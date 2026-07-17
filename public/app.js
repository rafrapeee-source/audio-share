const socket = io();

const selectionPanel = document.getElementById('selection-panel');
const streamPanel = document.getElementById('stream-panel');
const btnHost = document.getElementById('btn-host');
const btnJoin = document.getElementById('btn-join');
const btnLeave = document.getElementById('btn-leave');
const inputRoomId = document.getElementById('input-room-id');
const displayRoomId = document.getElementById('display-room-id');
const streamStatus = document.getElementById('stream-status');
const participantInfo = document.getElementById('participant-info');
const remoteAudio = document.getElementById('remote-audio');

let localStream = null;
let peerConnections = {}; // Keyed by socket ID
let currentRoomId = null;
let role = null; // 'host' or 'listener'

// Standard ICE servers for basic NAT traversal
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// UI State Switcher
function showStreamView(roomId, userRole) {
  currentRoomId = roomId;
  role = userRole;
  selectionPanel.classList.add('hidden');
  streamPanel.classList.remove('hidden');
  displayRoomId.textContent = roomId;
  
  if (role === 'host') {
    streamStatus.textContent = "Broadcasting Audio";
    participantInfo.textContent = "0 listeners active";
  } else {
    streamStatus.textContent = "Listening to Stream";
    participantInfo.textContent = "Connected to host";
  }
}

// --- BROADCASTER / HOST LOGIC ---
btnHost.addEventListener('click', async () => {
  try {
    // We capture video and audio via getDisplayMedia because desktop audio is usually tied to display sharing.
    // We then extract only the audio track.
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // Some browsers require video to be true to prompt for system audio
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      // Clean up video stream if no audio was selected
      displayStream.getTracks().forEach(track => track.stop());
      alert("No audio track detected. Make sure to check the 'Share audio' option during screen sharing.");
      return;
    }

    // Stop the video track as we only need the audio
    displayStream.getVideoTracks().forEach(track => track.stop());

    // Create a new stream containing only the audio track
    localStream = new MediaStream([audioTracks[0]]);

    // Generate a random 6-character room ID
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    socket.emit('create-room', roomId);
    showStreamView(roomId, 'host');

  } catch (err) {
    console.error("Error accessing screen/system audio:", err);
    alert("Could not start broadcast. Screen sharing permissions are required.");
  }
});

// Host receives notification that a listener joined
socket.on('listener-joined', async (listenerId) => {
  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections[listenerId] = pc;

  // Add our audio track to the connection
  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  // Handle ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', listenerId, event.candidate);
    }
  };

  // Create WebRTC Offer
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', listenerId, pc.localDescription);
    updateListenerCount();
  } catch (err) {
    console.error("Error creating WebRTC offer:", err);
  }
});

// Host receives an answer from a listener
socket.on('answer', async (listenerId, description) => {
  const pc = peerConnections[listenerId];
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(description));
  }
});

function updateListenerCount() {
  const count = Object.keys(peerConnections).length;
  participantInfo.textContent = `${count} listener${count !== 1 ? 's' : ''} active`;
}


// --- LISTENER LOGIC ---
btnJoin.addEventListener('click', () => {
  const roomId = inputRoomId.value.trim().toUpperCase();
  if (!roomId) return;
  socket.emit('join-room', roomId);
});

// Listener receives WebRTC Offer from Broadcaster
socket.on('offer', async (broadcasterId, description) => {
  showStreamView(inputRoomId.value.toUpperCase(), 'listener');
  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections[broadcasterId] = pc;

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', broadcasterId, event.candidate);
    }
  };

  // When the audio track arrives, attach it to our audio player
  pc.ontrack = (event) => {
    remoteAudio.classList.remove('hidden');
    if (remoteAudio.srcObject !== event.streams[0]) {
      remoteAudio.srcObject = event.streams[0];
    }
  };

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(description));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', broadcasterId, pc.localDescription);
  } catch (err) {
    console.error("Error setting up connection on listener end:", err);
  }
});


// --- SHARED SIGNALING LOGIC ---

// Receive ICE candidate from peer
socket.on('ice-candidate', async (senderId, candidate) => {
  const pc = peerConnections[senderId];
  if (pc) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error("Error adding received ICE candidate:", err);
    }
  }
});

// Handle disconnected users
socket.on('user-disconnected', (userId) => {
  if (peerConnections[userId]) {
    peerConnections[userId].close();
    delete peerConnections[userId];
    if (role === 'host') {
      updateListenerCount();
    }
  }
});

socket.on('broadcaster-disconnected', () => {
  alert("The broadcaster disconnected.");
  leaveRoom();
});

socket.on('room-not-found', () => {
  alert("Room not found. Check the ID and try again.");
});


// --- LEAVE / CLEANUP ---
btnLeave.addEventListener('click', leaveRoom);

function leaveRoom() {
  // Stop all local media tracks
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  // Close all peer connections
  Object.keys(peerConnections).forEach(id => {
    peerConnections[id].close();
  });
  peerConnections = {};

  // Clean up audio element
  remoteAudio.srcObject = null;
  remoteAudio.classList.add('hidden');

  // Reset UI
  streamPanel.classList.add('hidden');
  selectionPanel.classList.remove('hidden');
  inputRoomId.value = '';
  currentRoomId = null;
  role = null;

  // Refresh page connections safely
  socket.emit('leave-room');
}