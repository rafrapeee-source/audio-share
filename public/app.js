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

let currentRoomId = null;
let role = null; // 'host' or 'listener'
let ytPlayer = null;
let isPlayerReady = false;

// Initialize YouTube Player API
function onYouTubeIframeAPIReady() {
  ytPlayer = new YT.Player('yt-player', {
    host: 'https://www.youtube-nocookie.com', // <-- ADD THIS LINE
    height: '100',
    width: '100',
    videoId: '', 
    playerVars: {
      autoplay: 1,
      controls: 0,
      disablekb: 1,
      fs: 0,
      rel: 0,
      playsinline: 1
    },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange
    }
  });
}

function onPlayerReady(event) {
  isPlayerReady = true;
  ytPlayer.setVolume(volumeSlider.value);
  // Suggest the lowest possible quality (144p/240p) to conserve background bandwidth
  ytPlayer.setPlaybackQuality('small'); 
}

function onPlayerStateChange(event) {
  // If the video ends and we are the host, coordinate playing the next track
  if (event.data === YT.PlayerState.ENDED) {
    if (role === 'host') {
      socket.emit('song-ended', currentRoomId);
    }
  }
}

// Volume Controls
volumeSlider.addEventListener('input', (e) => {
  if (isPlayerReady && ytPlayer) {
    ytPlayer.setVolume(e.target.value);
  }
});

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

// --- SHARED REAL-TIME EVENTS ---

// Sync complete room state for newly connected listeners
socket.on('sync-state', (state) => {
  showJukeboxView(inputRoomId.value.toUpperCase(), 'listener');
  updateQueueUI(state.queue);
  if (state.currentTrack && state.isPlaying) {
    playVideo(state.currentTrack);
  }
});

// Play a track commanded by the server
socket.on('play-track', (data) => {
  playVideo(data.track);
  updateQueueUI(data.queue);
});

// Queue update notification
socket.on('queue-updated', (queue) => {
  updateQueueUI(queue);
});

// Stop playing when the queue is completely empty
socket.on('stop-track', () => {
  if (isPlayerReady && ytPlayer) {
    ytPlayer.stopVideo();
  }
  nowPlayingInfo.innerHTML = '<p class="text-sm text-gray-400 italic">Queue is empty.</p>';
});

// Helper to run local hidden audio player
function playVideo(track) {
  if (isPlayerReady && ytPlayer) {
    ytPlayer.loadVideoById({
      videoId: track.videoId,
      suggestedQuality: 'small' // Keep background video bandwidth use low
    });
    // Ensure quality is lowered once loading starts
    ytPlayer.setPlaybackQuality('small');
  }

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

// Update the queue panel UI list
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

// Room exceptions / disconnect handling
socket.on('room-not-found', () => {
  alert("Room not found. Check the ID.");
});

socket.on('broadcaster-disconnected', () => {
  alert("The host disconnected, closing room.");
  leaveRoom();
});

btnLeave.addEventListener('click', leaveRoom);

function leaveRoom() {
  if (isPlayerReady && ytPlayer) {
    ytPlayer.stopVideo();
  }
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