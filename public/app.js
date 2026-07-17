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
let lastTrackStartTime = 0; 
let currentTrack = null;
let driftCheckInterval = null;
let keepAliveInterval = null;
let playerTimePollInterval = null;

// Real playback position as reported by the YouTube iframe itself (via
// getCurrentTime), not our own timer guess. Updated whenever the iframe
// answers a getCurrentTime request. `playerTimeUpdatedAt` is the local
// Date.now() when that reading arrived, so we can extrapolate a couple
// seconds forward if a fresh reading hasn't come in yet.
let lastKnownPlayerTime = null;
let playerTimeUpdatedAt = 0;

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

// --- VOLUME & COMMANDS ---
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

// Send raw handshake event initialization directly to the window context
function sendPlayerHandshake(event) {
  if (ytPlayerIframe && ytPlayerIframe.contentWindow) {
    ytPlayerIframe.contentWindow.postMessage(JSON.stringify({
      event: event
    }), 'https://www.youtube-nocookie.com');
  }
}

// Ask the YouTube iframe for its actual current playback position. The
// answer comes back asynchronously as an 'infoDelivery' message and is
// captured in the window 'message' listener below (info.currentTime).
function requestPlayerTime() {
  sendPlayerCommand('getCurrentTime');
}

// --- DETECT WHEN SONG ENDS ---

window.addEventListener('message', (event) => {
  if (event.origin === 'https://www.youtube-nocookie.com') {
    try {
      let data;
      if (typeof event.data === 'string') {
        data = JSON.parse(event.data);
      } else {
        data = event.data;
      }

      // Capture the real playback position whenever the iframe reports one.
      // This is what lets drift-checking compare against actual video
      // position instead of just our own wall-clock estimate.
      if (data && data.event === 'infoDelivery' && data.info && typeof data.info.currentTime === 'number') {
        lastKnownPlayerTime = data.info.currentTime;
        playerTimeUpdatedAt = Date.now();
      }

      let isEnded = false;

      // Check standard and raw message formats
      if (data && data.event === 'infoDelivery' && data.info && data.info.playerState === 0) {
        isEnded = true;
      } else if (data && data.event === 'onStateChange' && data.info === 0) {
        isEnded = true;
      }

      if (isEnded) {
        const now = Date.now();
        // Cooldown: Only allow ended triggers if the song has been playing for at least 5 seconds
        if (now - lastTrackStartTime > 5000 && currentTrack) {
          lastTrackStartTime = now;
          console.log("Song finished. Notifying server...");
          // Pass the specific videoId that ended to prevent double-skips on the server
          socket.emit('song-ended', currentRoomId, currentTrack.videoId);
        }
      }
    } catch (err) {
      // Ignore
    }
  }
});

// --- SHARED REAL-TIME EVENTS ---

socket.on('sync-state', (state) => {
  // Safe fallback to grab the active Room ID
  const activeRoomId = currentRoomId || inputRoomId.value.toUpperCase();
  // showJukeboxView is safe to call again on a resync — it just re-asserts
  // the current view, it doesn't reset anything.
  showJukeboxView(activeRoomId, role === 'host' ? 'host' : 'listener');
  updateQueueUI(state.queue);

  if (state.currentTrack && state.isPlaying) {
    const isNewTrack = !currentTrack || currentTrack.videoId !== state.currentTrack.videoId;

    if (isNewTrack) {
      // Different (or first) track — load it fresh at the server's position.
      playVideo(state.currentTrack, state.elapsedSeconds);
    } else {
      // Same track already playing locally. Only reseek if we've drifted
      // noticeably; otherwise reloading the iframe every resync would cause
      // audible stutter for no benefit.
      const expectedElapsed = state.elapsedSeconds;
      const localElapsed = getLocalPlaybackPosition();
      const driftSeconds = Math.abs(expectedElapsed - localElapsed);

      if (driftSeconds > 3) {
        console.log(`Drift detected (${driftSeconds}s, using ${lastKnownPlayerTime !== null ? 'real player time' : 'wall-clock estimate'}). Reseeking...`);
        playVideo(state.currentTrack, expectedElapsed);
      } else {
        // Still in sync — just make sure the drift-check loop keeps running.
        startDriftChecking();
      }
    }
  } else {
    stopDriftChecking();
    stopKeepAlive();
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
  currentTrack = null;
  stopDriftChecking();
  stopKeepAlive();
  nowPlayingInfo.innerHTML = '<p class="text-sm text-gray-400 italic">Queue is empty.</p>';
});

// Best estimate of "what second is this listener's player actually on".
// Prefers a real getCurrentTime() reading from the iframe (extrapolated
// forward by however long it's been since that reading arrived, since
// readings are only refreshed periodically). Falls back to the pure
// wall-clock guess if we don't have a real reading yet (e.g. right after
// a fresh load, before the iframe has answered its first getCurrentTime).
function getLocalPlaybackPosition() {
  if (lastKnownPlayerTime !== null) {
    const secondsSinceReading = (Date.now() - playerTimeUpdatedAt) / 1000;
    return lastKnownPlayerTime + secondsSinceReading;
  }
  return (Date.now() - lastTrackStartTime) / 1000;
}

function playVideo(track, startSecond = 0) {
  const myOrigin = window.location.origin;
  
  // Store the active track locally
  currentTrack = track;
  
  // Adjust the cooldown lock based on how far into the song we are starting
  lastTrackStartTime = Date.now() - (startSecond * 1000);

  // Reset real-player-time tracking — any reading we had was for whatever
  // was playing before, and would otherwise pollute the next drift check
  // until a fresh getCurrentTime response comes back in.
  lastKnownPlayerTime = null;
  playerTimeUpdatedAt = 0;

  // We append &start=... to make the YouTube player jump directly to the synchronized second
  ytPlayerIframe.src = `https://www.youtube-nocookie.com/embed/${track.videoId}?autoplay=1&rel=0&enablejsapi=1&vq=small&start=${startSecond}&origin=${encodeURIComponent(myOrigin)}`;

  ytPlayerIframe.onload = () => {
    sendPlayerHandshake('listening');
    sendPlayerCommand('addEventListener', ['onStateChange']);
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

  startDriftChecking();
  startKeepAlive();
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

// Ask the server for the current authoritative state and reseek the player to match.
// Called on: initial connect, socket reconnect, and tab becoming visible again.
function requestFreshSync() {
  if (currentRoomId) {
    console.log("Requesting fresh sync from server...");
    // Also ask the iframe for its real position right now, so by the time
    // sync-state comes back we're comparing against as fresh a reading as
    // possible rather than one that might be several seconds stale.
    requestPlayerTime();
    socket.emit('request-sync', currentRoomId);
  }
}

socket.on('connect', () => {
  if (currentRoomId) {
    console.log("Reconnected to server. Syncing room state...");
    // Host still needs join-room to (re)join the socket.io room server-side
    // after a reconnect; listeners already have a room record, but re-joining
    // is harmless and guarantees we're subscribed to broadcasts either way.
    socket.emit('join-room', currentRoomId);
  }
});

// Browser tabs get heavily throttled (or their socket silently dies) while
// backgrounded. The moment the tab becomes visible again, force a resync
// instead of trusting whatever state we were left in.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentRoomId) {
    // If the underlying socket dropped while hidden, socket.io will
    // reconnect and our 'connect' handler above will also fire a sync.
    // If it stayed connected the whole time, we still want to correct
    // for drift accumulated while timers were throttled.
    if (socket.connected) {
      requestFreshSync();
    }
  }
});

// Periodic drift correction: every 15s while something is playing, compare
// where the player *should* be (per server truth) against where it likely
// drifted to, and nudge it back in line. This is what keeps everyone
// glued together over a long session, not just at the moment they join.
function startDriftChecking() {
  stopDriftChecking();
  driftCheckInterval = setInterval(() => {
    if (document.visibilityState !== 'visible') return; // no point correcting while hidden
    if (!currentTrack || !ytPlayerIframe.contentWindow) return;
    requestFreshSync();
  }, 15000);
  startPlayerTimePolling();
}

function stopDriftChecking() {
  if (driftCheckInterval) {
    clearInterval(driftCheckInterval);
    driftCheckInterval = null;
  }
  stopPlayerTimePolling();
}

// Keeps lastKnownPlayerTime fresh (every 3s) so that whenever a drift check
// or resync happens, we're comparing against real player position instead
// of a stale or purely theoretical wall-clock guess. This is the piece that
// actually catches "buffered late so it's really behind" or "genuinely
// running ahead" cases that timestamp math alone can't see.
function startPlayerTimePolling() {
  stopPlayerTimePolling();
  playerTimePollInterval = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!currentTrack || !ytPlayerIframe.contentWindow) return;
    requestPlayerTime();
  }, 3000);
}

function stopPlayerTimePolling() {
  if (playerTimePollInterval) {
    clearInterval(playerTimePollInterval);
    playerTimePollInterval = null;
  }
}

// Keep-alive: while a track is actively playing, ping a plain HTTP endpoint
// every few minutes so Render's free-tier instance doesn't spin down mid-song.
// This intentionally does NOT run when nothing is playing — an idle room
// with no music should be allowed to sleep normally.
//
// Reliability note: background tabs get their JS timers throttled, but
// Chrome/Firefox exempt tabs that are (a) playing audible audio and/or
// (b) holding an open WebSocket — this app has both, so this interval
// should keep firing even while backgrounded. If a listener mutes the
// player entirely, the audio exemption may not apply, but the open
// socket.io WebSocket connection alone is generally enough to avoid the
// most aggressive throttling tiers.
const KEEP_ALIVE_INTERVAL_MS = 3 * 60 * 1000; // well under Render's 15-min timeout, with margin

function startKeepAlive() {
  if (keepAliveInterval) return; // already running
  keepAliveInterval = setInterval(() => {
    fetch('/healthz').catch(() => {
      // Ignore failures — if the server is unreachable there's nothing
      // to keep alive anyway; the next drift-check/reconnect will surface it.
    });
  }, KEEP_ALIVE_INTERVAL_MS);
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

btnLeave.addEventListener('click', leaveRoom);

function leaveRoom() {
  ytPlayerIframe.src = '';
  stopDriftChecking();
  stopKeepAlive();
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