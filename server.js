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

app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

// Server-side state for rooms.
const rooms = {};

function playNext(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  if (room.queue.length > 0) {
    room.currentTrack = room.queue.shift();
    room.isPlaying = true;

    io.to(roomId).emit('play-track', {
      track: room.currentTrack,
      queue: room.queue
    });
  } else {
    room.currentTrack = null;
    room.isPlaying = false;
    io.to(roomId).emit('stop-track');
  }
}

// Shared helper: push current room state (track + queue) to one socket.
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

      if (socket.id !== room.hostId) {
        room.listenerIds.add(socket.id);
        io.to(room.hostId).emit('listener-joined', socket.id);
      }

      sendSyncState(socket, room);
    } else {
      socket.emit('room-not-found');
    }
  });

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
      socket.emit('queue-full-error', 'The queue is full!');
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
      console.log(`[Room ${roomId}] Confirmed song ended. Advancing queue...`);
      playNext(roomId);
    }
  });

  // Simple UI-only notifications for pause/resume
  socket.on('track-paused', (roomId) => {
    socket.to(roomId).emit('track-paused');
  });

  socket.on('track-resumed', (roomId) => {
    socket.to(roomId).emit('track-resumed');
  });

  // --- WebRTC signaling relay ---
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
        delete rooms[roomId];
        io.to(roomId).emit('broadcaster-disconnected');
      } else if (room.listenerIds.has(socket.id)) {
        room.listenerIds.delete(socket.id);
        io.to(room.hostId).emit('listener-left', socket.id);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));