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

let currentRoomId = null;
let role = null; // 'host' or 'listener'
let currentVolume = volumeSlider.value;

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

// --- VOLUME CONTROLS (Controlled via postMessage API) ---
volumeSlider.addEventListener('input', (e) => {
  currentVolume = e.target.value;
  sendPlayerCommand('setVolume', [currentVolume]);
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

// --- SHARED REAL-TIME EVENTS ---

socket.on('sync-state', (state) => {
  showJukeboxView(inputRoomId.value.toUpperCase(), 'listener');
  updateQueueUI(state.queue);
  if (state.currentTrack && state.isPlaying) {
    playVideo(state.currentTrack);
  }
});

socket.on('play-track', (data) => {
  playVideo(data.track);
  updateQueueUI(data.queue);
});

socket.on('queue-updated', (queue) => {
  updateQueueUI(queue);
});

socket.on('stop-track', () => {
  ytPlayerIframe.src = '';
  nowPlayingInfo.innerHTML = '<p class="text-sm text-gray-400 italic">Queue is empty.</p>';
});

function playVideo(track) {
  // We no longer require enablejsapi or origin queries for queue tracking
  ytPlayerIframe.src = `https://www.youtube-nocookie.com/embed/${track.videoId}?autoplay=1&rel=0&vq=small`;

  // Set the initial volume once the iframe reloads
  ytPlayerIframe.onload = () => {
    sendPlayerCommand('setVolume', [currentVolume]);
  };

  nowPlayingInfo.innerHTML = `
    <div class="flex items-center gap-3">
      <img src="${track.thumbnail}" class="w-16 h-12 object-cover rounded border border-gray-700">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-bold text-white truncate">${track.title}</p>
        <p class="text-xs text-indigo-400">Now streaming</p>
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
  alert("The host disconnected, closing room.");
  leaveRoom();
});

btnLeave.addEventListener('click', leaveRoom);

function leaveRoom() {
  ytPlayerIframe.src = '';
  setupPanel.classList.remove('hidden');
  jukeboxView.classList.add('hidden');
  roomBadge.classList.add('hidden');
  searchResults.innerHTML = '<p class="text-sm text-gray-500 italic">No search results yet.</p>';
  nowPlayingInfo.innerHTML = '<p class="text-sm text-gray-400 italic">Queue is empty.</p>';
  queueListElement.innerHTML = '<p class="text-xs text-gray-500 italic">No songs queued.</p>';
  searchInput.value = '';
  inputRoomId.value = '';
  currentRoomId = null;
  role = null;
  socket.emit('leave-room');
}