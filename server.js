const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

// Lightweight endpoint clients ping via plain HTTP while a track is playing.
// A real HTTP request (not just WebSocket traffic) is the safest way to make
// sure Render's activity detector counts this as "the app is in use" and
// doesn't spin the free-tier instance down mid-song.
app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

// Server-side state for rooms.
// NOTE: Audio no longer flows through this server at all — the host captures
// tab audio locally and streams it directly to each listener over WebRTC.
// This server's job is now just (a) queue/room bookkeeping and (b) relaying
// WebRTC signaling messages (offer/answer/ICE) between the host and each
// listener so they can establish those direct peer connections.
const rooms = {};

// Parses YouTube's "duration" string (e.g. "3:45", "1:02:33") into seconds.
// Falls back to a generous default if missing/unparseable, since we still
// want an advance timer even for tracks with unknown length.
function parseDurationToSeconds(durationStr) {
  if (!durationStr || typeof durationStr !== 'string') return null;
  const parts = durationStr.split(':').map(p => parseInt(p, 10));
  if (parts.some(isNaN)) return null;

  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + part;
  }
  return seconds;
}

function playNext(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // Clear any pending advance timer from the previous track
  if (room.advanceTimer) {
    clearTimeout(room.advanceTimer);
    room.advanceTimer = null;
  }

  if (room.queue.length > 0) {
    room.currentTrack = room.queue.shift();
    room.isPlaying = true;

    io.to(roomId).emit('play-track', {
      track: room.currentTrack,
      queue: room.queue
    });

    // Server-driven auto-advance, based on the track's reported duration.
    // The host is the only one actually playing the video, but the server
    // still owns queue advancement so a host tab hiccup doesn't desync the
    // "what's up next" state everyone else sees.
    const durationSeconds = parseDurationToSeconds(room.currentTrack.duration);
    // Small buffer (2s) past the actual duration so a slightly slow-loading
    // client doesn't get cut off before it even reaches the true end.
    const advanceMs = durationSeconds ? (durationSeconds + 2) * 1000 : 10 * 60 * 1000;

    const trackAtTimerStart = room.currentTrack.videoId;
    room.advanceTimer = setTimeout(() => {
      const stillCurrent = room.currentTrack && room.currentTrack.videoId === trackAtTimerStart;
      if (stillCurrent) {
        console.log(`[Room ${roomId}] Auto-advancing after ${Math.round(advanceMs / 1000)}s (duration-based timer).`);
        playNext(roomId);
      }
    }, advanceMs);
  } else {
    room.currentTrack = null;
    room.isPlaying = false;
    io.to(roomId).emit('stop-track');
  }
}

// Shared helper: push current room state (track + queue) to one socket.
// Used both for fresh joins and for the host reconnecting. There's no
// elapsedSeconds/playback-position math anymore — the audio itself is a
// live WebRTC stream, so there's nothing to reseek or drift-correct.
function sendSyncState(socket, room) {
  socket.emit('sync-state', {
    currentTrack: room.currentTrack,
    queue: room.queue,
    isPlaying: room.isPlaying
  });
}

// YouTube Search API Endpoint
app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.json([]);

    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      }
    });
    
    const html = await response.text();
    const regex = /ytInitialData\s*=\s*({.+?});/;
    const match = html.match(regex);
    if (!match) return res.json([]);
    
    const data = JSON.parse(match[1]);
    const contents = data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents;
    
    const results = [];
    for (const item of contents) {
      if (item.videoRenderer) {
        const video = item.videoRenderer;
        results.push({
          videoId: video.videoId,
          title: video.title.runs[0].text,
          thumbnail: video.thumbnail.thumbnails[0].url,
          duration: video.lengthText ? video.lengthText.simpleText : 'Unknown'
        });
      }
      if (results.length >= 8) break;
    }
    
    res.json(results);
  } catch (error) {
    console.error("Scraping error:", error);
    res.status(500).json({ error: "Failed to fetch search results" });
  }
});

// Socket Connections
io.on('connection', (socket) => {

  socket.on('create-room', (roomId) => {
    rooms[roomId] = {
      hostId: socket.id,
      queue: [],
      currentTrack: null,
      isPlaying: false,
      listenerIds: new Set()
    };
    socket.join(roomId);
  });

  socket.on('join-room', (roomId) => {
    const room = rooms[roomId];
    if (room) {
      socket.join(roomId);

      // Re-joining host (e.g. after reconnect) shouldn't be treated as a listener.
      if (socket.id !== room.hostId) {
        room.listenerIds.add(socket.id);
        // Tell the host a new listener showed up so it can create a fresh
        // RTCPeerConnection for them and kick off signaling (send an offer).
        io.to(room.hostId).emit('listener-joined', socket.id);
      }

      sendSyncState(socket, room);
    } else {
      socket.emit('room-not-found');
    }
  });

  // A listener whose page reloaded/reconnected but is still "in" the room
  // (host didn't see a clean disconnect yet) can ask for state without
  // re-triggering listener-joined bookkeeping weirdness — join-room already
  // handles this idempotently via the Set, so this is just a plain refetch.
  socket.on('request-sync', (roomId) => {
    const room = rooms[roomId];
    if (room) {
      sendSyncState(socket, room);
    } else {
      socket.emit('room-not-found');
    }
  });

  socket.on('add-to-queue', (roomId, track) => {
    const room = rooms[roomId];
    if (!room) return;

    if (room.queue.length >= 50) {
      socket.emit('queue-full-error', 'The queue is full! Wait for some songs to finish.');
      return;
    }

    room.queue.push(track);

    if (!room.currentTrack) {
      playNext(roomId);
    } else {
      io.to(roomId).emit('queue-updated', room.queue);
    }
  });

  socket.on('song-ended', (roomId, endedVideoId) => {
    const room = rooms[roomId];
    if (room && room.currentTrack && room.currentTrack.videoId === endedVideoId) {
      console.log(`[Room ${roomId}] Confirmed song ended for video: ${endedVideoId}. Advancing queue...`);
      playNext(roomId);
    }
  });

  // --- WebRTC signaling relay ---
  // The server never inspects/touches SDP or ICE payloads, it just forwards
  // them to the intended socket by id. `targetId` is the other side's
  // socket.id — the host learns listener ids from 'listener-joined', and a
  // listener learns the host's id from the 'sync-state'/'play-track' flow
  // (the client stores it after resolving the room's host once).
  socket.on('webrtc-offer', ({ targetId, offer }) => {
    io.to(targetId).emit('webrtc-offer', { fromId: socket.id, offer });
  });

  socket.on('webrtc-answer', ({ targetId, answer }) => {
    io.to(targetId).emit('webrtc-answer', { fromId: socket.id, answer });
  });

  socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('webrtc-ice-candidate', { fromId: socket.id, candidate });
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      const room = rooms[roomId];
      if (!room) continue;

      if (room.hostId === socket.id) {
        if (room.advanceTimer) clearTimeout(room.advanceTimer);
        delete rooms[roomId];
        io.to(roomId).emit('broadcaster-disconnected');
      } else if (room.listenerIds.has(socket.id)) {
        room.listenerIds.delete(socket.id);
        // Let the host know so it can tear down that listener's RTCPeerConnection.
        io.to(room.hostId).emit('listener-left', socket.id);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));