const socket = io();

const statusIcon = document.getElementById('status-icon');
const statusText = document.getElementById('status-text');
const nowPlayingBox = document.getElementById('now-playing');
const nowPlayingTitle = document.getElementById('now-playing-title');
const ytPlayerIframe = document.getElementById('yt-player');

// Room id comes from the URL the control tab opened us with: /player.html?room=XXXX
const params = new URLSearchParams(window.location.search);
const roomId = params.get('room');

let currentTrack = null;
let captureStream = null;
const peerConnections = {}; // one RTCPeerConnection per listener, keyed by socket.id

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

if (!roomId) {
  statusIcon.textContent = '⚠️';
  statusText.textContent = 'No room specified. Open this from the Jukebox Party tab instead of directly.';
  throw new Error('Missing room param');
}

function setStatus(icon, text) {
  statusIcon.textContent = icon;
  statusText.textContent = text;
}

const btnShare = document.getElementById('btn-share');

// --- Self-capture: this tab shares ITSELF, which is why the picker will
// actually list it (a tab can never appear in its own getDisplayMedia
// picker — that's a hard Chrome restriction, hence this whole second tab).
//
// IMPORTANT: getDisplayMedia() requires a real user gesture (a click)
// *inside this tab*. Opening this tab via window.open() from the control
// tab does NOT count — the gesture doesn't carry over across tabs. That's
// why this is wired to a button click rather than firing automatically
// on page load; calling it on load gets silently blocked with no dialog.
async function startCapture() {
  btnShare.disabled = true;
  btnShare.textContent = 'Requesting...';

  try {
    captureStream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // required by the API even though we only want audio
      audio: true
    });
  } catch (err) {
    console.error('getDisplayMedia failed or was cancelled:', err);
    setStatus('❌', 'Sharing was cancelled or blocked.');
    btnShare.disabled = false;
    btnShare.textContent = 'Try Again';
    return;
  }

  if (captureStream.getAudioTracks().length === 0) {
    setStatus('❌', 'No audio was shared. Make sure "Also share tab audio" is checked, and pick the Chrome Tab option.');
    captureStream.getTracks().forEach(t => t.stop());
    captureStream = null;
    btnShare.disabled = false;
    btnShare.textContent = 'Try Again';
    return;
  }

  // We don't need the video track for anything — drop it immediately.
  captureStream.getVideoTracks().forEach(t => t.stop());

  // If sharing stops (user clicks Chrome's "Stop sharing" bar), the room
  // can't continue — audio has nowhere to come from anymore.
  captureStream.getAudioTracks()[0].addEventListener('ended', () => {
    setStatus('❌', 'Tab sharing stopped. Close this tab and start a new room to resume.');
    socket.emit('leave-room');
  });

  btnShare.classList.add('hidden');
  setStatus('✅', 'Streaming — you can switch back to the other tab now.');
  socket.emit('register-player', roomId);
}

btnShare.addEventListener('click', startCapture);

// --- YouTube player control ---
function sendPlayerCommand(func, args = []) {
  if (ytPlayerIframe && ytPlayerIframe.contentWindow) {
    ytPlayerIframe.contentWindow.postMessage(JSON.stringify({
      event: 'command',
      func: func,
      args: args
    }), 'https://www.youtube-nocookie.com');
  }
}

function sendPlayerHandshake(event) {
  if (ytPlayerIframe && ytPlayerIframe.contentWindow) {
    ytPlayerIframe.contentWindow.postMessage(JSON.stringify({
      event: event
    }), 'https://www.youtube-nocookie.com');
  }
}

function playVideo(track) {
  const myOrigin = window.location.origin;
  ytPlayerIframe.src = `https://www.youtube-nocookie.com/embed/${track.videoId}?autoplay=1&rel=0&enablejsapi=1&vq=small&origin=${encodeURIComponent(myOrigin)}`;
  ytPlayerIframe.onload = () => {
    sendPlayerHandshake('listening');
    sendPlayerCommand('addEventListener', ['onStateChange']);
  };
}

// --- Detect when the song ends, so the queue can advance ---
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://www.youtube-nocookie.com') return;
  try {
    let data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;

    let isEnded = false;
    if (data && data.event === 'infoDelivery' && data.info && data.info.playerState === 0) {
      isEnded = true;
    } else if (data && data.event === 'onStateChange' && data.info === 0) {
      isEnded = true;
    }

    if (isEnded && currentTrack) {
      console.log('Song finished. Notifying server...');
      socket.emit('song-ended', roomId, currentTrack.videoId);
    }
  } catch (err) {
    // Ignore
  }
});

// --- Room state ---
socket.on('sync-state', (state) => {
  if (state.currentTrack && state.isPlaying) {
    currentTrack = state.currentTrack;
    nowPlayingBox.classList.remove('hidden');
    nowPlayingTitle.textContent = state.currentTrack.title;

    const isNewTrack = !ytPlayerIframe.src || !ytPlayerIframe.src.includes(state.currentTrack.videoId);
    if (isNewTrack) playVideo(state.currentTrack);
  } else {
    currentTrack = null;
    nowPlayingBox.classList.add('hidden');
    ytPlayerIframe.src = '';
  }
});

socket.on('play-track', (data) => {
  currentTrack = data.track;
  nowPlayingBox.classList.remove('hidden');
  nowPlayingTitle.textContent = data.track.title;
  playVideo(data.track);
});

socket.on('stop-track', () => {
  currentTrack = null;
  nowPlayingBox.classList.add('hidden');
  ytPlayerIframe.src = '';
});

socket.on('room-not-found', () => {
  setStatus('⚠️', 'Room not found — it may have already been closed.');
});

socket.on('broadcaster-disconnected', () => {
  setStatus('⚠️', 'Room closed.');
});

// --- WebRTC: broadcast our captured audio to every listener ---

socket.on('listener-joined', async (listenerId) => {
  if (!captureStream) return; // not ready yet — server re-announces once we register

  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConnections[listenerId] = pc;

  captureStream.getAudioTracks().forEach(track => {
    pc.addTrack(track, captureStream);
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', { targetId: listenerId, candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      cleanupPeerConnection(listenerId);
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { targetId: listenerId, offer });
  } catch (err) {
    console.error(`Failed to create offer for listener ${listenerId}:`, err);
    cleanupPeerConnection(listenerId);
  }
});

socket.on('webrtc-answer', async ({ fromId, answer }) => {
  const pc = peerConnections[fromId];
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (err) {
    console.error(`Failed to set remote description from listener ${fromId}:`, err);
  }
});

socket.on('webrtc-ice-candidate', async ({ fromId, candidate }) => {
  const pc = peerConnections[fromId];
  if (pc) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('Failed to add ICE candidate:', err);
    }
  }
});

socket.on('listener-left', (listenerId) => {
  cleanupPeerConnection(listenerId);
});

function cleanupPeerConnection(listenerId) {
  const pc = peerConnections[listenerId];
  if (pc) {
    pc.close();
    delete peerConnections[listenerId];
  }
}

// Closing this tab (or navigating away) should end the room cleanly rather
// than leaving a ghost room with no audio source.
window.addEventListener('beforeunload', () => {
  socket.emit('leave-room');
});