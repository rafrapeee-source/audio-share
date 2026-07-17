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

// Helper to play next song in queue
// function playNext(roomId) {
//   const room = rooms[roomId];
//   if (!room) return;

//   if (room.queue.length > 0) {
//     room.currentTrack = room.queue.shift();
//     room.isPlaying = true;
    
//     io.to(roomId).emit('play-track', {
//       track: room.currentTrack,
//       queue: room.queue
//     });
//   } else {
//     room.currentTrack = null;
//     room.isPlaying = false;
//     io.to(roomId).emit('stop-track');
//   }
// }

function playNext(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  if (room.queue.length > 0) {
    room.currentTrack = room.queue.shift();
    room.isPlaying = true;
    room.trackStartTime = Date.now(); // <-- Record the exact start time of the track
    
    io.to(roomId).emit('play-track', {
      track: room.currentTrack,
      queue: room.queue
    });
  } else {
    room.currentTrack = null;
    room.isPlaying = false;
    room.trackStartTime = null;
    io.to(roomId).emit('stop-track');
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
      isPlaying: false
    };
    socket.join(roomId);
  });

  // socket.on('join-room', (roomId) => {
  //   const room = rooms[roomId];
  //   if (room) {
  //     socket.join(roomId);
  //     socket.emit('sync-state', {
  //       currentTrack: room.currentTrack,
  //       queue: room.queue,
  //       isPlaying: room.isPlaying
  //     });
  //   } else {
  //     socket.emit('room-not-found');
  //   }
  // });

  socket.on('join-room', (roomId) => {
    const room = rooms[roomId];
    if (room) {
      socket.join(roomId);
      
      // Calculate how many seconds have elapsed since the track started
      let elapsedSeconds = 0;
      if (room.trackStartTime) {
        elapsedSeconds = Math.floor((Date.now() - room.trackStartTime) / 1000);
      }

      socket.emit('sync-state', {
        currentTrack: room.currentTrack,
        queue: room.queue,
        isPlaying: room.isPlaying,
        elapsedSeconds: elapsedSeconds // <-- Send the current playback position
      });
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

  socket.on('queue-full-error', (message) => {
    alert(message);
  });

  // Host notifies the server that the track ended; server triggers next track
  // socket.on('song-ended', (roomId) => {
  //   const room = rooms[roomId];
  //   if (room && socket.id === room.hostId) {
  //     playNext(roomId);
  //   }
  // });

  socket.on('song-ended', (roomId, endedVideoId) => {
    const room = rooms[roomId];
    if (room && room.currentTrack && room.currentTrack.videoId === endedVideoId) {
      console.log(`[Room ${roomId}] Confirmed song ended for video: ${endedVideoId}. Advancing queue...`);
      playNext(roomId);
    }
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      const room = rooms[roomId];
      if (room && room.hostId === socket.id) {
        delete rooms[roomId];
        io.to(roomId).emit('broadcaster-disconnected');
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));