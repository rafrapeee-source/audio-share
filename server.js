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

// Server-side state for rooms
const rooms = {};

// Helper to convert YouTube duration strings (e.g. "3:45", "1:02:15") to milliseconds
function parseDurationToMs(durationStr) {
  if (!durationStr || durationStr === 'Unknown') return 180000; // 3-minute fallback
  
  const parts = durationStr.split(':').map(Number);
  let seconds = 0;
  
  if (parts.some(isNaN)) return 180000;

  if (parts.length === 3) {
    // HH:MM:SS
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    // MM:SS
    seconds = parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    // SS
    seconds = parts[0];
  }
  
  // Add a 4-second buffer to account for YouTube load/buffering times
  return (seconds + 4) * 1000; 
}

// Helper to play next song in queue
function playNext(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // Clear any existing timer for this room to avoid double-triggers
  if (room.timeoutId) {
    clearTimeout(room.timeoutId);
    room.timeoutId = null;
  }

  if (room.queue.length > 0) {
    room.currentTrack = room.queue.shift();
    room.isPlaying = true;
    
    io.to(roomId).emit('play-track', {
      track: room.currentTrack,
      queue: room.queue
    });

    // Set a timer on the server to automatically load the next song
    const durationMs = parseDurationToMs(room.currentTrack.duration);
    console.log(`[Room ${roomId}] Playing: "${room.currentTrack.title}". Duration: ${room.currentTrack.duration}. Timer set for ${durationMs / 1000}s`);
    
    room.timeoutId = setTimeout(() => {
      console.log(`[Room ${roomId}] Track finished. Loading next track...`);
      playNext(roomId);
    }, durationMs);

  } else {
    room.currentTrack = null;
    room.isPlaying = false;
    io.to(roomId).emit('stop-track');
    console.log(`[Room ${roomId}] Queue is empty. Player stopped.`);
  }
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
      timeoutId: null
    };
    socket.join(roomId);
  });

  socket.on('join-room', (roomId) => {
    const room = rooms[roomId];
    if (room) {
      socket.join(roomId);
      socket.emit('sync-state', {
        currentTrack: room.currentTrack,
        queue: room.queue,
        isPlaying: room.isPlaying
      });
    } else {
      socket.emit('room-not-found');
    }
  });

  socket.on('add-to-queue', (roomId, track) => {
    const room = rooms[roomId];
    if (!room) return;

    room.queue.push(track);

    if (!room.currentTrack) {
      playNext(roomId);
    } else {
      io.to(roomId).emit('queue-updated', room.queue);
    }
  });

  // Listener disconnect cleanup
  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      const room = rooms[roomId];
      if (room && room.hostId === socket.id) {
        if (room.timeoutId) {
          clearTimeout(room.timeoutId);
        }
        delete rooms[roomId];
        io.to(roomId).emit('broadcaster-disconnected');
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));