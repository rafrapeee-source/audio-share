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
const listenerAudio = document.getElementById('listener-audio');

let currentRoomId = null;
let role = null; // 'host' or 'listener'
let currentVolume = volumeSlider.value;
let currentTrack = null;

// This is the CONTROL tab: search, queue, room code. It never captures or
// streams any audio itself. Hosting opens a second tab (player.html) which
// is the thing that actually gets shared via getDisplayMedia — a browser
// tab can't share/capture itself, so the player has to live somewhere else.
let playerWindow = null;

// Standard public STUN server so peers behind NAT can find each other.
// No TURN server configured — if a listener is on a very restrictive
// network (symmetric NAT / locked-down corporate wifi) the direct
// connection may fail to establish. Good enough for friends-on-home-wifi
// use, but worth knowing if someone reports "audio just never starts".
const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// --- LISTENER-ONLY STATE ---
// The single connection back to the player tab (wherever it lives).
let listenerPeerConnection = null;

// UI View Transition
function showJukeboxView(roomId, userRole) {
  currentRoomId = roomId;
  role = userRole;
  setupPanel.classList.add('hidden');
  jukeboxView.classList.remove('hidden');
  roomBadge.classList.remove('hidden');
  displayRoomId.textContent = roomId;
}

// --- HOST ACTION ---
btnHost.addEventListener('click', () => {
  const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
  socket.emit('create-room', roomId);
  showJukeboxView(roomId, 'host');

  // Open the player tab. It connects to the server itself, registers as
  // this room's player, and prompts for tab-audio sharing on its own.
  playerWindow = window.open(`/player.html?room=${roomId}`, '_blank');

  if (!playerWindow) {
    alert('Your browser blocked the player tab from opening. Please allow popups for this site and try again.');
  }
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

    item.querySelector('.add-btn').addEventListener('click', () => {
      socket.emit('add-to-queue', currentRoomId, track);
    });

    searchResults.appendChild(item);
  });
}

// --- VOLUME ---
// Host: this tab has no audio of its own (the player tab does) — the slider
// is just informational for now unless we later wire a "set player volume"
// message to the player tab. Listener: controls their own local <audio>
// element only — purely local playback volume, doesn't affect anyone else.
volumeSlider.addEventListener('input', (e) => {
  currentVolume = e.target.value;
  if (role === 'listener') {
    listenerAudio.volume = currentVolume / 100;
  }
});

// --- SHARED REAL-TIME EVENTS ---

socket.on('sync-state', (state) => {
  const activeRoomId = currentRoomId || inputRoomId.value.toUpperCase();
  showJukeboxView(activeRoomId, role === 'host' ? 'host' : 'listener');
  updateQueueUI(state.queue);

  if (state.currentTrack && state.isPlaying) {
    currentTrack = state.currentTrack;
    updateNowPlayingUI(state.currentTrack);
  } else {
    currentTrack = null;
    nowPlayingInfo.innerHTML = '<p class="text-sm text-gray-400 italic">Queue is empty. Search and add a track to start.</p>';
  }
});

socket.on('play-track', (data) => {
  currentTrack = data.track;
  updateNowPlayingUI(data.track);
  updateQueueUI(data.queue);
});

socket.on('queue-updated', (queue) => {
  updateQueueUI(queue);
});

socket.on('stop-track', () => {
  currentTrack = null;
  nowPlayingInfo.innerHTML = '<p class="text-sm text-gray-400 italic">Queue is empty.</p>';
});

function updateNowPlayingUI(track) {
  nowPlayingInfo.innerHTML = `
    <div class="flex items-center gap-3">
      <img src="${track.thumbnail}" class="w-16 h-12 object-cover rounded border border-gray-700">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-bold text-white truncate">${track.title}</p>
        <p class="text-xs text-indigo-400">${role === 'host' ? 'Now streaming' : 'Now playing'}</p>
      </div>
    </div>
  `;
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
  alert(role === 'host' ? "The player tab closed, ending the room." : "The host disconnected, closing room.");
  leaveRoom();
});

socket.on('connect', () => {
  if (currentRoomId) {
    console.log("Reconnected to server. Syncing room state...");
    socket.emit('join-room', currentRoomId);
  }
});

// =====================================================================
// WebRTC — LISTENER SIDE ONLY.
// The control tab never captures or broadcasts audio; that all happens in
// player.html. This tab, when acting as a listener, just receives the
// incoming audio stream from whichever socket is the room's player.
// =====================================================================

// The player tab sent us an offer — answer it and start receiving audio.
socket.on('webrtc-offer', async ({ fromId, offer }) => {
  if (role !== 'listener') return;

  // If we somehow already had a connection (e.g. player tab reconnected
  // and re-offered), tear down the old one first.
  if (listenerPeerConnection) {
    listenerPeerConnection.close();
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  listenerPeerConnection = pc;

  pc.ontrack = (event) => {
    listenerAudio.srcObject = event.streams[0];
    listenerAudio.volume = currentVolume / 100;
    listenerAudio.play().catch(err => {
      // Autoplay of audio-with-sound can be blocked until the user
      // interacts with the page. Surface this clearly instead of failing silently.
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
    console.error('Failed to answer player offer:', err);
  }
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  try {
    if (role === 'listener' && listenerPeerConnection) {
      await listenerPeerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (err) {
    console.error('Failed to add ICE candidate:', err);
  }
});

// A tab that autoplay-blocked the <audio> element will unblock as soon as
// the user interacts with the page at all — nudge playback on first click.
document.addEventListener('click', () => {
  if (role === 'listener' && listenerAudio.srcObject && listenerAudio.paused) {
    listenerAudio.play().catch(() => {});
  }
}, { once: false });

btnLeave.addEventListener('click', leaveRoom);

function leaveRoom() {
  if (role === 'host' && playerWindow && !playerWindow.closed) {
    playerWindow.close();
  }
  playerWindow = null;

  if (listenerPeerConnection) {
    listenerPeerConnection.close();
    listenerPeerConnection = null;
  }
  listenerAudio.srcObject = null;

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