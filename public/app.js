const socket = io();

// UI Elements
const setupPanel = document.getElementById('setup-panel');
const jukeboxView = document.getElementById('jukebox-view');
const roomBadge = document.getElementById('room-badge');
const displayRoomId = document.getElementById('display-room-id');
const btnHost = document.getElementById('btn-host');
const btnJoin = document.getElementById('btn-join');
const btnLeave = document.getElementById('btn-leave');
const inputRoomId = document.getElementById('input-room-id');
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
const nowPlayingInfo = document.getElementById('now-playing-info');
const queueListElement = document.getElementById('queue-list');
const volumeSlider = document.getElementById('volume-slider');
const ytPlayerIframe = document.getElementById('yt-player');
const listenerAudio = document.getElementById('listener-audio');

// Host-Only Control Elements
const hostControls = document.getElementById('host-controls');
const btnPlayPause = document.getElementById('btn-play-pause');
const btnNext = document.getElementById('btn-next');

// Seekbar / Scrubber UI Elements
const seekbar = document.getElementById('seekbar');
const currentTimeLabel = document.getElementById('current-time-label');
const durationLabel = document.getElementById('duration-label');

let currentRoomId = null;
let role = null; // 'host' or 'listener'
let currentVolume = volumeSlider.value;
let currentTrack = null;
let isPaused = false;

// Seekbar internal variables
let elapsedSeconds = 0;
let totalDurationSeconds = 0;
let isUserDragging = false; // Guard flag to halt automated timeline snapping while scrubbing

// Standard public STUN server so peers behind NAT can find each other.
const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// --- HOST-ONLY STATE ---
let hostCaptureStream = null;
const hostPeerConnections = {};

// --- LISTENER-ONLY STATE ---
let listenerPeerConnection = null;

// --- HELPERS ---

// Converts "3:45" or "1:12:30" format string to total seconds
function parseDuration(durationStr) {
  if (!durationStr || typeof durationStr !== 'string') return 0;
  const parts = durationStr.split(':').map(p => parseInt(p, 10));
  if (parts.some(isNaN)) return 0;

  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + part;
  }
  return seconds;
}

// Converts seconds back to "0:00" format string
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// UI View Transition
function showJukeboxView(roomId, userRole) {
  currentRoomId = roomId;
  role = userRole;
  setupPanel.classList.add('hidden');
  jukeboxView.classList.remove('hidden');
  roomBadge.classList.remove('hidden');
  displayRoomId.textContent = roomId;

  // Render host controls block only if user is hosting
  if (userRole === 'host') {
    hostControls.classList.remove('hidden');
  } else {
    hostControls.classList.add('hidden');
  }
}

// --- HOST ACTION ---
btnHost.addEventListener('click', async () => {
  try {
    // We capture audio with speech-processing filters disabled to prevent music pumping
    hostCaptureStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: "browser", 
      },
      audio: {
        echoCancellation: false, 
        noiseSuppression: false,  
        autoGainControl: false    
      },
      preferCurrentTab: true,      
      selfBrowserSurface: "include" 
    });

    if (hostCaptureStream.getAudioTracks().length === 0) {
      alert('No audio track was shared. Make sure to check "Also share tab audio" in the dialog, and pick "This Tab" (not a window or screen).');
      hostCaptureStream.getTracks().forEach(t => t.stop());
      hostCaptureStream = null;
      return;
    }

    // Drop video track immediately to conserve host CPU
    hostCaptureStream.getVideoTracks().forEach(t => t.stop());

    // Listen for manual "Stop sharing" trigger in browser chrome
    hostCaptureStream.getAudioTracks()[0].addEventListener('ended', () => {
      if (role === 'host') {
        alert('Tab audio sharing stopped. Closing the room.');
        leaveRoom();
      }
    });
  } catch (err) {
    console.error('getDisplayMedia failed or was cancelled:', err);
    alert('Tab audio sharing was cancelled or blocked, so a room can\'t be hosted without it.');
    return;
  }

  const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
  socket.emit('create-room', roomId);
  showJukeboxView(roomId, 'host');
});

// --- LISTENER ACTION ---
btnJoin.addEventListener('click', () => {
  const roomId = inputRoomId.value.trim().toUpperCase();
  if (!roomId) return;
  socket.emit('join-room', roomId);
});

// --- SEARCH FORM ---
searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = searchInput.value.trim();
  if (!query) return;

  searchResults.innerHTML = '<p class="text-sm text-gray-400">Searching...</p>';

  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const results = await response.json();
    displaySearchResults(results);
  } catch (error) {
    console.error(error);
    searchResults.innerHTML = '<p class="text-sm text-red-400">Search failed. Try again.</p>';
  }
});

function displaySearchResults(results) {
  if (results.length === 0) {
    searchResults.innerHTML = '<p class="text-sm text-gray-400">No results found.</p>';
    return;
  }

  searchResults.innerHTML = '';
  results.forEach(track => {
    const item = document.createElement('div');
    item.className = "flex items-center gap-3 p-2 bg-gray-700/30 border border-gray-700 rounded hover:bg-gray-700/50 transition";
    item.innerHTML = `
      <img src="${track.thumbnail}" class="w-12 h-9 object-cover rounded">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-semibold text-white truncate">${track.title}</p>
        <p class="text-xs text-gray-400">${track.duration}</p>
      </div>
      <button class="add-btn bg-indigo-600 hover:bg-indigo-500 text-xs font-bold py-1 px-3 rounded transition">
        Queue
      </button>
    `;

    const addBtn = item.querySelector('.add-btn');

    addBtn.addEventListener('click', () => {
      // 1. Instantly disable the queue button to block double clicks
      addBtn.disabled = true;

      // 2. Change appearance for positive action feedback
      addBtn.textContent = 'Added! ✓';
      addBtn.classList.remove('bg-indigo-600', 'hover:bg-indigo-500');
      addBtn.classList.add('bg-emerald-600', 'cursor-not-allowed');

      // 3. Emit the queue event
      socket.emit('add-to-queue', currentRoomId, track);

      // 4. Cooldown block release after 1.5s
      setTimeout(() => {
        addBtn.disabled = false;
        addBtn.textContent = 'Queue';
        addBtn.classList.remove('bg-emerald-600', 'cursor-not-allowed');
        addBtn.classList.add('bg-indigo-600', 'hover:bg-indigo-500');
      }, 1500);
    });

    searchResults.appendChild(item);
  });
}

// --- VOLUME ---
volumeSlider.addEventListener('input', (e) => {
  currentVolume = e.target.value;
  if (role === 'host') {
    sendPlayerCommand('setVolume', [currentVolume]);
  } else if (role === 'listener') {
    listenerAudio.volume = currentVolume / 100;
  }
});

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

// --- INTERCEPT POSTMESSAGE EVENTS FROM YOUTUBE IFRAME (Host only) ---
window.addEventListener('message', (event) => {
  if (role !== 'host') return;
  if (event.origin === 'https://www.youtube-nocookie.com') {
    try {
      let data;
      if (typeof event.data === 'string') {
        data = JSON.parse(event.data);
      } else {
        data = event.data;
      }

      // 1. Capture real-time progress updates directly from YouTube's playback clock
      if (data && data.event === 'infoDelivery' && data.info) {
        if (typeof data.info.currentTime !== 'undefined' && !isUserDragging) {
          const actualTime = Math.floor(data.info.currentTime);
          elapsedSeconds = actualTime;
          seekbar.value = actualTime;
          currentTimeLabel.textContent = formatTime(actualTime);
        }
      }

      // 2. Listen for track-ended states (to advance room queue)
      let isEnded = false;
      if (data && data.event === 'infoDelivery' && data.info && data.info.playerState === 0) {
        isEnded = true;
      } else if (data && data.event === 'onStateChange' && data.info === 0) {
        isEnded = true;
      }

      if (isEnded && currentTrack) {
        console.log("Song finished. Notifying server...");
        socket.emit('song-ended', currentRoomId, currentTrack.videoId);
      }
    } catch (err) {
      // Ignore
    }
  }
});

// --- SHARED REAL-TIME EVENTS ---

socket.on('sync-state', (state) => {
  const activeRoomId = currentRoomId || inputRoomId.value.toUpperCase();
  showJukeboxView(activeRoomId, role === 'host' ? 'host' : 'listener');
  updateQueueUI(state.queue);

  if (state.currentTrack && state.isPlaying) {
    updateNowPlayingUI(state.currentTrack);
    currentTrack = state.currentTrack;

    if (role === 'host') {
      const isNewTrack = !ytPlayerIframe.src || !ytPlayerIframe.src.includes(state.currentTrack.videoId);
      if (isNewTrack) {
        playVideo(state.currentTrack);
      }
    }
  } else {
    currentTrack = null;
    nowPlayingInfo.innerHTML = '<p class="text-sm text-gray-400 italic">Queue is empty. Search and add a track to start.</p>';
    if (role === 'host') {
      ytPlayerIframe.src = '';
    }
  }
});

socket.on('play-track', (data) => {
  currentTrack = data.track;
  updateNowPlayingUI(data.track);
  updateQueueUI(data.queue);
  if (role === 'host') {
    playVideo(data.track);
  }
});

socket.on('queue-updated', (queue) => {
  updateQueueUI(queue);
});

socket.on('stop-track', () => {
  currentTrack = null;
  nowPlayingInfo.innerHTML = '<p class="text-sm text-gray-400 italic">Queue is empty.</p>';
  if (role === 'host') {
    ytPlayerIframe.src = '';
    isPaused = false;
    btnPlayPause.textContent = 'Pause';
    
    // Clear out timeline views
    seekbar.value = 0;
    currentTimeLabel.textContent = "0:00";
    durationLabel.textContent = "0:00";
  }
});

function updateNowPlayingUI(track) {
  nowPlayingInfo.innerHTML = `
    <div class="flex items-center gap-3">
      <img src="${track.thumbnail}" class="w-16 h-12 object-cover rounded border border-gray-700">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-bold text-white truncate">${track.title}</p>
        <p id="track-status" class="text-xs text-indigo-400">${role === 'host' ? 'Now streaming' : 'Now playing'}</p>
      </div>
    </div>
  `;
}

function playVideo(track) {
  // Parse and establish boundaries for our seekbar
  isUserDragging = false;
  elapsedSeconds = 0;
  totalDurationSeconds = parseDuration(track.duration);

  seekbar.max = totalDurationSeconds;
  seekbar.value = 0;
  currentTimeLabel.textContent = "0:00";
  durationLabel.textContent = track.duration || "0:00";

  const myOrigin = window.location.origin;

  // Reset local pause toggle states
  isPaused = false;
  btnPlayPause.textContent = 'Pause';

  // Load lowest available video quality embed
  ytPlayerIframe.src = `https://www.youtube-nocookie.com/embed/${track.videoId}?autoplay=1&rel=0&enablejsapi=1&vq=small&origin=${encodeURIComponent(myOrigin)}`;

  ytPlayerIframe.onload = () => {
    sendPlayerHandshake('listening');
    sendPlayerCommand('addEventListener', ['onStateChange']);
    sendPlayerCommand('setVolume', [currentVolume]);
  };
}

function updateQueueUI(queue) {
  if (queue.length === 0) {
    queueListElement.innerHTML = '<p class="text-xs text-gray-500 italic">No songs queued.</p>';
    return;
  }

  queueListElement.innerHTML = '';
  queue.forEach((track, index) => {
    const item = document.createElement('div');
    item.className = "flex items-center gap-2 p-1.5 bg-gray-800/80 border border-gray-700 rounded";
    item.innerHTML = `
      <span class="text-xs text-gray-500 font-bold w-4 text-center">${index + 1}</span>
      <img src="${track.thumbnail}" class="w-8 h-6 object-cover rounded">
      <p class="text-xs text-gray-300 truncate flex-1">${track.title}</p>
    `;
    queueListElement.appendChild(item);
  });
}

socket.on('room-not-found', () => {
  alert("Room not found. Check the ID.");
});

socket.on('broadcaster-disconnected', () => {
  alert("The host disconnected, closing room.");
  leaveRoom();
});

socket.on('connect', () => {
  if (currentRoomId) {
    console.log("Reconnected to server. Syncing room state...");
    socket.emit('join-room', currentRoomId);
  }
});

// =====================================================================
// WebRTC: host self-captures this tab's audio and streams it to every listener.
// =====================================================================

// --- HOST SIDE ---

socket.on('listener-joined', async (listenerId) => {
  if (role !== 'host' || !hostCaptureStream) return;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  hostPeerConnections[listenerId] = pc;

  hostCaptureStream.getAudioTracks().forEach(track => {
    pc.addTrack(track, hostCaptureStream);
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', { targetId: listenerId, candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      cleanupHostPeerConnection(listenerId);
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { targetId: listenerId, offer });
  } catch (err) {
    console.error(`Failed to create offer for listener ${listenerId}:`, err);
    cleanupHostPeerConnection(listenerId);
  }
});

socket.on('webrtc-answer', async ({ fromId, answer }) => {
  if (role !== 'host') return;
  const pc = hostPeerConnections[fromId];
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (err) {
    console.error(`Failed to set remote description from listener ${fromId}:`, err);
  }
});

socket.on('listener-left', (listenerId) => {
  cleanupHostPeerConnection(listenerId);
});

function cleanupHostPeerConnection(listenerId) {
  const pc = hostPeerConnections[listenerId];
  if (pc) {
    pc.close();
    delete hostPeerConnections[listenerId];
  }
}

// --- LISTENER SIDE ---

socket.on('webrtc-offer', async ({ fromId, offer }) => {
  if (role !== 'listener') return;

  if (listenerPeerConnection) {
    listenerPeerConnection.close();
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  listenerPeerConnection = pc;

  pc.ontrack = (event) => {
    listenerAudio.srcObject = event.streams[0];
    listenerAudio.volume = currentVolume / 100;
    listenerAudio.play().catch(err => {
      console.warn('Autoplay was blocked, waiting for user interaction:', err);
    });
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', { targetId: fromId, candidate: event.candidate });
    }
  };

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', { targetId: fromId, answer });
  } catch (err) {
    console.error('Failed to answer host offer:', err);
  }
});

// --- SHARED: ICE candidates flow both directions ---
socket.on('webrtc-ice-candidate', async ({ fromId, candidate }) => {
  try {
    if (role === 'host') {
      const pc = hostPeerConnections[fromId];
      if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } else if (role === 'listener') {
      if (listenerPeerConnection) await listenerPeerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (err) {
    console.error('Failed to add ICE candidate:', err);
  }
});

// Autoplay release fallback listener
document.addEventListener('click', () => {
  if (role === 'listener' && listenerAudio.srcObject && listenerAudio.paused) {
    listenerAudio.play().catch(() => {});
  }
}, { once: false });

// --- PLAYBACK SYNC NOTIFICATIONS FOR LISTENERS ---
socket.on('track-paused', () => {
  const statusElement = document.getElementById('track-status');
  if (statusElement) {
    statusElement.textContent = 'Paused';
    statusElement.classList.remove('text-indigo-400');
    statusElement.classList.add('text-amber-500');
  }
});

socket.on('track-resumed', () => {
  const statusElement = document.getElementById('track-status');
  if (statusElement) {
    statusElement.textContent = role === 'host' ? 'Now streaming' : 'Now playing';
    statusElement.classList.remove('text-amber-500');
    statusElement.classList.add('text-indigo-400');
  }
});

// --- CONTROLS ---

btnPlayPause.addEventListener('click', () => {
  if (role !== 'host' || !currentTrack) return;

  const statusElement = document.getElementById('track-status');

  if (isPaused) {
    sendPlayerCommand('playVideo');
    btnPlayPause.textContent = 'Pause';
    if (statusElement) {
      statusElement.textContent = 'Now streaming';
      statusElement.classList.remove('text-amber-500');
      statusElement.classList.add('text-indigo-400');
    }
    isPaused = false;
    socket.emit('track-resumed', currentRoomId);
  } else {
    sendPlayerCommand('pauseVideo');
    btnPlayPause.textContent = 'Play';
    if (statusElement) {
      statusElement.textContent = 'Paused';
      statusElement.classList.remove('text-indigo-400');
      statusElement.classList.add('text-amber-500');
    }
    isPaused = true;
    socket.emit('track-paused', currentRoomId);
  }
});

btnNext.addEventListener('click', () => {
  if (role !== 'host' || !currentTrack) return;
  socket.emit('song-ended', currentRoomId, currentTrack.videoId);
});

btnLeave.addEventListener('click', leaveRoom);

function leaveRoom() {
  if (role === 'host') {
    ytPlayerIframe.src = '';
    if (hostCaptureStream) {
      hostCaptureStream.getTracks().forEach(t => t.stop());
      hostCaptureStream = null;
    }
    Object.keys(hostPeerConnections).forEach(cleanupHostPeerConnection);
  } else if (role === 'listener') {
    if (listenerPeerConnection) {
      listenerPeerConnection.close();
      listenerPeerConnection = null;
    }
    listenerAudio.srcObject = null;
  }

  // Clear timeline and state parameters back to blank
  seekbar.value = 0;
  currentTimeLabel.textContent = "0:00";
  durationLabel.textContent = "0:00";
  isPaused = false;
  btnPlayPause.textContent = 'Pause';

  setupPanel.classList.remove('hidden');
  jukeboxView.classList.add('hidden');
  roomBadge.classList.add('hidden');
  searchResults.innerHTML = '<p class="text-sm text-gray-500 italic">No search results yet.</p>';
  nowPlayingInfo.innerHTML = '<p class="text-sm text-gray-400 italic">Queue is empty.</p>';
  queueListElement.innerHTML = '<p class="text-xs text-gray-500 italic">No songs queued.</p>';
  searchInput.value = '';
  inputRoomId.value = '';
  currentRoomId = null;
  currentTrack = null;
  role = null;
  socket.emit('leave-room');
}

// --- SEEKBAR / SCRUBBING EVENT LISTENERS ---

seekbar.addEventListener('input', (e) => {
  if (role !== 'host') return;
  isUserDragging = true; // Lock timeline adjustments from incoming WS updates while dragging
  const tempTime = parseInt(e.target.value, 10);
  currentTimeLabel.textContent = formatTime(tempTime);
});

seekbar.addEventListener('change', (e) => {
  if (role !== 'host' || !currentTrack) return;
  const targetSeconds = parseInt(e.target.value, 10);
  
  elapsedSeconds = targetSeconds;
  sendPlayerCommand('seekTo', [targetSeconds, true]);

  // Brief delay to allow the player to update before unlocking timeline snaps
  setTimeout(() => {
    isUserDragging = false;
  }, 500);
});