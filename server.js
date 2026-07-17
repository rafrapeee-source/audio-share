const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Keep track of active rooms and who the broadcaster is
const rooms = {};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('create-room', (roomId) => {
    rooms[roomId] = socket.id;
    socket.join(roomId);
    console.log(`Room ${roomId} created by broadcaster: ${socket.id}`);
  });

  socket.on('join-room', (roomId) => {
    if (rooms[roomId]) {
      socket.join(roomId);
      // Notify the broadcaster that a new listener has joined
      io.to(rooms[roomId]).emit('listener-joined', socket.id);
      console.log(`Listener ${socket.id} joined room: ${roomId}`);
    } else {
      socket.emit('room-not-found');
    }
  });

  // Relay WebRTC negotiation messages
  socket.on('offer', (targetId, description) => {
    io.to(targetId).emit('offer', socket.id, description);
  });

  socket.on('answer', (targetId, description) => {
    io.to(targetId).emit('answer', socket.id, description);
  });

  socket.on('ice-candidate', (targetId, candidate) => {
    io.to(targetId).emit('ice-candidate', socket.id, candidate);
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    // If the broadcaster disconnected, clean up the room
    for (const roomId in rooms) {
      if (rooms[roomId] === socket.id) {
        delete rooms[roomId];
        io.to(roomId).emit('broadcaster-disconnected');
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});