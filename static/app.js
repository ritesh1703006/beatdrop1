/**
 * BEATDROP // UNIVERSAL AUDIO ENGINE
 * Engineered by Ritesh
 * Supports Spotify, Apple Music, YouTube Music, and YouTube Playlists
 */

// ============================================================
// GAME CONFIGURATION & STATE
// ============================================================

const LEVELS = [
  { level: 1, duration: 1.0,  points: 1000, label: "1.0s" },
  { level: 2, duration: 2.0,  points: 800,  label: "2.0s" },
  { level: 3, duration: 4.0,  points: 400,  label: "4.0s" },
  { level: 4, duration: 7.0,  points: 300,  label: "7.0s" },
  { level: 5, duration: 11.0, points: 200,  label: "11.0s" },
  { level: 6, duration: 16.0, points: 100,  label: "16.0s" }
];

const state = {
  // Playlist info
  playlistId: null,
  playlistTitle: "",
  platform: "youtube",
  platformBadge: "YouTube",
  tracks: [],
  remainingTracks: [],
  maxRounds: 10,
  
  // Game metrics
  totalScore: 0,
  currentStreak: 0,
  bestStreak: 0,
  roundNumber: 1,
  roundsHistory: [],

  // Current Round State
  currentSong: null,
  currentLevelIndex: 0,
  startOffset: 0,
  useRandomHook: false,
  isResolvingAudio: false,

  // Audio Playback
  isPlayingSnippet: false,
  isPlayingFullTrack: false,
  snippetTimeoutId: null,
  progressAnimId: null,
  bufferWatchdogId: null,

  // UI state
  selectedSuggestion: null,
  highlightedDropdownIndex: -1
};

let ytPlayer = null;
let isPlayerReady = false;
let pendingPlayAfterReady = false;
let sfxEnabled = true;
let audioCtx = null;

// ============================================================
// WEB AUDIO API SOUND FX (Procedural Chimes & Clicks)
// ============================================================

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  return audioCtx;
}

function playSFX(type) {
  if (!sfxEnabled) return;
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    if (type === "win") {
      const notes = [523.25, 659.25, 783.99, 1046.50];
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, now + idx * 0.08);
        gain.gain.setValueAtTime(0, now + idx * 0.08);
        gain.gain.linearRampToValueAtTime(0.2, now + idx * 0.08 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.4);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.08);
        osc.stop(now + idx * 0.08 + 0.45);
      });
    } else if (type === "wrong") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(150, now);
      osc.frequency.linearRampToValueAtTime(110, now + 0.22);
      gain.gain.setValueAtTime(0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
    } else if (type === "click") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(800, now);
      osc.frequency.exponentialRampToValueAtTime(200, now + 0.04);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.05);
    }
  } catch (e) {}
}

// ============================================================
// YOUTUBE IFRAME ENGINE INITIALIZATION
// ============================================================

function initYouTubePlayer() {
  if (ytPlayer) return;
  if (!window.YT || !window.YT.Player) return;

  try {
    ytPlayer = new YT.Player("yt-player", {
      height: "180",
      width: "240",
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        fs: 0,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
        enablejsapi: 1
      },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange,
        onError: onPlayerError
      }
    });
  } catch (err) {
    console.error("Error creating YT.Player:", err);
  }
}

window.onYouTubeIframeAPIReady = function() {
  initYouTubePlayer();
};

if (window.YT && window.YT.Player) {
  initYouTubePlayer();
} else {
  const checkYTInterval = setInterval(() => {
    if (window.YT && window.YT.Player) {
      clearInterval(checkYTInterval);
      initYouTubePlayer();
    }
  }, 150);
}

function updateAudioStatus(status, text) {
  const dot = document.getElementById("audio-status-dot");
  const label = document.getElementById("audio-status-text");
  if (!dot || !label) return;
  if (status === "ready") {
    dot.className = "status-indicator ready";
    label.textContent = text || "AUDIO ACTIVE";
  } else {
    dot.className = "status-indicator connecting";
    label.textContent = text || "CONNECTING...";
  }
}

function onPlayerReady(event) {
  isPlayerReady = true;
  updateAudioStatus("ready", "AUDIO ACTIVE");
  try {
    ytPlayer.setVolume(100);
  } catch (e) {}

  if (state.currentSong && state.currentSong.id) {
    try {
      ytPlayer.cueVideoById({
        videoId: state.currentSong.id,
        startSeconds: state.startOffset || 0
      });
    } catch (e) {}
  }

  if (gameUI.guessFeedback.textContent.includes("Player is still loading") || gameUI.guessFeedback.textContent.includes("Connecting audio")) {
    showFeedback("");
  }

  if (pendingPlayAfterReady) {
    pendingPlayAfterReady = false;
    playCurrentSnippet();
  }
}

function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.PLAYING) {
    if (state.isPlayingSnippet) {
      handleSnippetPlayingStarted();
    }
  } else if (event.data === YT.PlayerState.ENDED) {
    stopVisualizer();
    resetProgressFill();
  }
}

function onPlayerError(event) {
  console.warn("YouTube player error:", event.data);
  let reason = "This video stream encountered an issue.";
  if (event.data === 150 || event.data === 101) {
    reason = "Video owner restricted embed playback on this track.";
  }
  showFeedback(`⚠️ ${reason} Skipping to next track in playlist...`, true);
  setTimeout(() => {
    nextRound();
  }, 1500);
}

// ============================================================
// DOM ELEMENTS
// ============================================================

const screens = {
  setup: document.getElementById("screen-setup"),
  game: document.getElementById("screen-game")
};

const nav = {
  stats: document.getElementById("nav-stats"),
  score: document.getElementById("nav-score"),
  streak: document.getElementById("nav-streak"),
  round: document.getElementById("nav-round"),
  maxRounds: document.getElementById("nav-max-rounds"),
  btnQuit: document.getElementById("btn-quit")
};

const setupUI = {
  urlInput: document.getElementById("playlist-url-input"),
  btnPaste: document.getElementById("btn-paste"),
  btnLoad: document.getElementById("btn-load-playlist"),
  toggleRandomHook: document.getElementById("toggle-random-hook"),
  selectRounds: document.getElementById("select-rounds-count"),
  loaderStatus: document.getElementById("loader-status"),
  loaderMessage: document.getElementById("loader-message"),
  errorMessage: document.getElementById("error-message"),
  presetsContainer: document.getElementById("presets-container")
};

const gameUI = {
  sourcePill: document.getElementById("source-platform-pill"),
  sourceName: document.getElementById("source-platform-name"),
  playlistTitle: document.getElementById("game-playlist-title"),
  playlistCount: document.getElementById("playlist-count-badge"),
  vinylDisc: document.getElementById("vinyl-disc"),
  revealedAlbumArt: document.getElementById("revealed-album-art"),
  vinylMysteryIcon: document.querySelector(".vinyl-mystery-icon"),
  tonearm: document.getElementById("tonearm"),
  visualizer: document.getElementById("visualizer"),
  vuMeterL: document.getElementById("vu-meter-l"),
  vuMeterR: document.getElementById("vu-meter-r"),
  currentLevelTag: document.getElementById("current-level-tag"),
  currentDurationTag: document.getElementById("current-duration-tag"),
  currentPointsTag: document.getElementById("current-points-tag"),
  btnPlaySnippet: document.getElementById("btn-play-snippet"),
  playIcon: document.getElementById("play-icon"),
  playHintText: document.getElementById("play-hint-text"),
  levelsTracker: document.getElementById("levels-tracker"),
  guessInput: document.getElementById("guess-input"),
  btnClearGuess: document.getElementById("btn-clear-guess"),
  suggestionsDropdown: document.getElementById("suggestions-dropdown"),
  btnSubmitGuess: document.getElementById("btn-submit-guess"),
  btnSkipLevel: document.getElementById("btn-skip-level"),
  skipBtnText: document.getElementById("skip-btn-text"),
  btnGiveUp: document.getElementById("btn-give-up"),
  guessFeedback: document.getElementById("guess-feedback")
};

const modalReveal = {
  overlay: document.getElementById("modal-reveal"),
  badge: document.getElementById("reveal-badge"),
  title: document.getElementById("reveal-title"),
  thumb: document.getElementById("reveal-thumb"),
  songTitle: document.getElementById("reveal-song-title"),
  artistName: document.getElementById("reveal-artist-name"),
  pointsEarned: document.getElementById("reveal-points-earned"),
  timeTaken: document.getElementById("reveal-time-taken"),
  streakVal: document.getElementById("reveal-streak-val"),
  ytLink: document.getElementById("reveal-yt-link"),
  btnToggleFull: document.getElementById("btn-toggle-full-player"),
  revealPlayIcon: document.getElementById("reveal-play-icon"),
  btnNextRound: document.getElementById("btn-next-round")
};

const modalSummary = {
  overlay: document.getElementById("modal-summary"),
  finalScore: document.getElementById("summary-final-score"),
  accuracy: document.getElementById("summary-accuracy"),
  bestStreak: document.getElementById("summary-best-streak"),
  sub1sCount: document.getElementById("summary-sub1s-count"),
  shareGrid: document.getElementById("share-grid-text"),
  btnCopyScore: document.getElementById("btn-copy-score"),
  btnPlayAgain: document.getElementById("btn-play-again")
};

// ============================================================
// AUDIO VISUALIZER & DUAL VU METERS
// ============================================================

function setupVisualizerBars() {
  gameUI.visualizer.innerHTML = "";
  const BAR_COUNT = 28;
  for (let i = 0; i < BAR_COUNT; i++) {
    const bar = document.createElement("div");
    bar.className = "v-bar";
    gameUI.visualizer.appendChild(bar);
  }
}

let visualizerInterval = null;
function startVisualizer() {
  const bars = gameUI.visualizer.querySelectorAll(".v-bar");
  bars.forEach(b => b.classList.add("active"));
  gameUI.vinylDisc.classList.add("playing");
  gameUI.btnPlaySnippet.classList.add("playing");
  gameUI.playIcon.className = "fa-solid fa-volume-high";

  if (gameUI.tonearm) gameUI.tonearm.classList.add("playing");

  const vuLedsL = gameUI.vuMeterL ? gameUI.vuMeterL.querySelectorAll(".vu-led") : [];
  const vuLedsR = gameUI.vuMeterR ? gameUI.vuMeterR.querySelectorAll(".vu-led") : [];

  clearInterval(visualizerInterval);
  visualizerInterval = setInterval(() => {
    bars.forEach((bar, idx) => {
      const centerFactor = 1 - Math.abs(idx - 14) / 16;
      const h = Math.floor(Math.random() * 32 * centerFactor) + 6;
      bar.style.height = `${h}px`;
    });

    // Animate VU meters (random dynamic decibel bounce)
    const activeCountL = Math.floor(Math.random() * 8) + 1;
    const activeCountR = Math.floor(Math.random() * 8) + 1;
    vuLedsL.forEach((led, i) => {
      led.classList.toggle("active", i < activeCountL);
    });
    vuLedsR.forEach((led, i) => {
      led.classList.toggle("active", i < activeCountR);
    });
  }, 75);
}

function stopVisualizer() {
  clearInterval(visualizerInterval);
  const bars = gameUI.visualizer.querySelectorAll(".v-bar");
  bars.forEach(bar => {
    bar.classList.remove("active");
    bar.style.height = "5px";
  });
  gameUI.vinylDisc.classList.remove("playing");
  gameUI.btnPlaySnippet.classList.remove("playing");
  gameUI.playIcon.className = "fa-solid fa-play";

  if (gameUI.tonearm) gameUI.tonearm.classList.remove("playing");

  const vuLeds = document.querySelectorAll(".vu-led");
  vuLeds.forEach(led => led.classList.remove("active"));
}

// ============================================================
// INITIALIZATION & PRESETS
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  setupVisualizerBars();
  loadPresets();
  attachEventListeners();
});

async function loadPresets() {
  try {
    const res = await fetch("/api/presets");
    const data = await res.json();
    renderPresets(data.presets || []);
  } catch (err) {
    console.error("Failed to load presets:", err);
  }
}

function renderPresets(presets) {
  setupUI.presetsContainer.innerHTML = "";
  presets.forEach((p, index) => {
    const card = document.createElement("div");
    card.className = index === 0 ? "preset-card featured-dhh" : "preset-card";
    card.innerHTML = `
      <div>
        <div class="preset-cat">${p.category}</div>
        <div class="preset-name">${p.name}</div>
        <div class="preset-desc">${p.description}</div>
      </div>
    `;
    card.addEventListener("click", () => {
      setupUI.urlInput.value = `https://www.youtube.com/playlist?list=${p.id}`;
      handleLoadPlaylist();
    });
    setupUI.presetsContainer.appendChild(card);
  });
}

// ============================================================
// EVENT LISTENERS
// ============================================================

function attachEventListeners() {
  setupUI.btnPaste.addEventListener("click", handlePaste);
  setupUI.btnLoad.addEventListener("click", handleLoadPlaylist);
  setupUI.urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleLoadPlaylist();
  });

  nav.btnQuit.addEventListener("click", () => {
    if (confirm("Quit current game session and select another playlist?")) {
      stopSnippetPlayback();
      showScreen("setup");
    }
  });

  const btnToggleSfx = document.getElementById("btn-toggle-sfx");
  const sfxIcon = document.getElementById("sfx-icon");
  if (btnToggleSfx) {
    btnToggleSfx.addEventListener("click", () => {
      sfxEnabled = !sfxEnabled;
      sfxIcon.className = sfxEnabled ? "fa-solid fa-volume-high" : "fa-solid fa-volume-xmark";
      btnToggleSfx.title = sfxEnabled ? "Mute Sound Effects" : "Enable Sound Effects";
    });
  }

  gameUI.btnPlaySnippet.addEventListener("click", toggleSnippetPlayback);

  gameUI.guessInput.addEventListener("input", handleSearchInput);
  gameUI.guessInput.addEventListener("keydown", handleSearchKeydown);
  gameUI.btnClearGuess.addEventListener("click", clearGuessInput);

  document.addEventListener("click", (e) => {
    if (!gameUI.guessInput.contains(e.target) && !gameUI.suggestionsDropdown.contains(e.target)) {
      gameUI.suggestionsDropdown.style.display = "none";
    }
  });

  gameUI.btnSubmitGuess.addEventListener("click", submitGuess);
  gameUI.btnSkipLevel.addEventListener("click", skipToNextLevel);
  gameUI.btnGiveUp.addEventListener("click", giveUpCurrentSong);

  modalReveal.btnNextRound.addEventListener("click", nextRound);
  modalReveal.btnToggleFull.addEventListener("click", toggleFullTrackPlayback);
  modalSummary.btnPlayAgain.addEventListener("click", restartGame);
  modalSummary.btnCopyScore.addEventListener("click", copyShareScore);

  document.addEventListener("keydown", (e) => {
    if (document.activeElement === gameUI.guessInput) return;
    if (screens.game.classList.contains("active") && modalReveal.overlay.style.display === "none") {
      if (e.code === "Space") {
        e.preventDefault();
        toggleSnippetPlayback();
      }
    } else if (modalReveal.overlay.style.display === "flex") {
      if (e.key === "Enter" || e.code === "Space") {
        e.preventDefault();
        nextRound();
      }
    }
  });
}

async function handlePaste() {
  try {
    const text = await navigator.clipboard.readText();
    setupUI.urlInput.value = text.trim();
  } catch (err) {
    setupUI.urlInput.focus();
  }
}

function showScreen(screenName) {
  screens.setup.classList.remove("active");
  screens.game.classList.remove("active");

  if (screenName === "setup") {
    screens.setup.classList.add("active");
    nav.stats.style.display = "none";
  } else {
    screens.game.classList.add("active");
    nav.stats.style.display = "flex";
  }
}

// ============================================================
// PLAYLIST INGESTION (SPOTIFY / APPLE / YOUTUBE)
// ============================================================

async function handleLoadPlaylist() {
  const url = setupUI.urlInput.value.trim();
  if (!url) {
    showSetupError("Please paste a playlist URL from Spotify, Apple Music, or YouTube.");
    return;
  }

  showSetupError("");
  setupUI.loaderStatus.style.display = "flex";
  setupUI.btnLoad.disabled = true;

  try {
    const res = await fetch("/api/load-playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Failed to parse playlist.");
    }

    state.playlistId = data.id;
    state.playlistTitle = data.title;
    state.platform = data.platform || "youtube";
    state.platformBadge = data.platformBadge || "PLAYLIST";
    state.tracks = [...data.tracks];
    state.useRandomHook = setupUI.toggleRandomHook.checked;

    startNewGame();
  } catch (err) {
    showSetupError(err.message || "Failed to load playlist.");
  } finally {
    setupUI.loaderStatus.style.display = "none";
    setupUI.btnLoad.disabled = false;
  }
}

function showSetupError(msg) {
  if (!msg) {
    setupUI.errorMessage.style.display = "none";
    setupUI.errorMessage.textContent = "";
  } else {
    setupUI.errorMessage.style.display = "block";
    setupUI.errorMessage.textContent = msg;
  }
}

// ============================================================
// GAME LOGIC & ROUND ENGINE
// ============================================================

function startNewGame() {
  state.totalScore = 0;
  state.currentStreak = 0;
  state.bestStreak = 0;
  state.roundNumber = 1;
  state.roundsHistory = [];

  state.remainingTracks = shuffleArray([...state.tracks]);

  const selectedRoundsVal = setupUI.selectRounds ? setupUI.selectRounds.value : "10";
  if (selectedRoundsVal === "all") {
    state.maxRounds = state.tracks.length;
  } else {
    state.maxRounds = Math.min(parseInt(selectedRoundsVal, 10), state.tracks.length);
  }

  // Update Deck Identity
  gameUI.playlistTitle.textContent = state.playlistTitle;
  gameUI.playlistCount.textContent = `${state.tracks.length} TRACKS`;
  gameUI.sourceName.textContent = state.platformBadge.toUpperCase();
  nav.maxRounds.textContent = state.maxRounds;

  updateNavStats();
  showScreen("game");
  loadRound();
}

async function loadRound() {
  if (state.remainingTracks.length === 0 || state.roundNumber > state.maxRounds) {
    endGame();
    return;
  }

  state.currentSong = state.remainingTracks.pop();
  state.currentLevelIndex = 0;
  state.selectedSuggestion = null;
  state.isPlayingSnippet = false;
  state.isPlayingFullTrack = false;

  if (state.useRandomHook && state.currentSong.duration > 35) {
    const maxStart = Math.max(20, Math.floor(state.currentSong.duration - 25));
    state.startOffset = Math.floor(Math.random() * (maxStart - 15)) + 15;
  } else {
    state.startOffset = 0;
  }

  resetRoundUI();
  updateNavStats();
  clearGuessInput();

  // If track comes from Spotify or Apple Music, resolve its YouTube video ID
  if (!state.currentSong.id) {
    state.isResolvingAudio = true;
    gameUI.playHintText.textContent = "Matching clean audio stream...";
    try {
      const res = await fetch("/api/resolve-track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: state.currentSong.title,
          artist: state.currentSong.artist
        })
      });
      const data = await res.json();
      if (data.videoId) {
        state.currentSong.id = data.videoId;
      }
    } catch (e) {
      console.warn("Track audio resolution error:", e);
    } finally {
      state.isResolvingAudio = false;
      gameUI.playHintText.innerHTML = `Press <strong>Play</strong> or hit <kbd class="kbd-key">Space</kbd> to listen`;
    }
  }

  // Cue into player
  if (isPlayerReady && ytPlayer && state.currentSong.id && typeof ytPlayer.cueVideoById === "function") {
    try {
      ytPlayer.cueVideoById({
        videoId: state.currentSong.id,
        startSeconds: state.startOffset
      });
    } catch (e) {}
  }
}

function resetRoundUI() {
  gameUI.vinylDisc.classList.remove("playing");
  gameUI.vinylMysteryIcon.style.display = "flex";
  gameUI.revealedAlbumArt.style.display = "none";
  gameUI.revealedAlbumArt.src = "";

  updateLevelUI();
  resetProgressFill();
  showFeedback("");
}

function updateLevelUI() {
  const currentConfig = LEVELS[state.currentLevelIndex];

  gameUI.currentLevelTag.textContent = `LEVEL ${currentConfig.level}`;
  gameUI.currentDurationTag.textContent = currentConfig.label;
  gameUI.currentPointsTag.textContent = `+${currentConfig.points.toLocaleString()} PTS`;
  gameUI.playHintText.innerHTML = `Listen to <strong>${currentConfig.label}</strong> (Hit Play or Space)`;

  if (state.currentLevelIndex < LEVELS.length - 1) {
    const nextConfig = LEVELS[state.currentLevelIndex + 1];
    gameUI.skipBtnText.textContent = `SKIP TO ${nextConfig.label}`;
    gameUI.btnSkipLevel.style.display = "inline-flex";
  } else {
    gameUI.btnSkipLevel.style.display = "none";
  }

  const steps = gameUI.levelsTracker.querySelectorAll(".stage-tab");
  steps.forEach((step, idx) => {
    step.className = "stage-tab";
    const statusIcon = step.querySelector(".tab-icon i");

    if (idx < state.currentLevelIndex) {
      step.classList.add("passed-wrong");
      statusIcon.className = "fa-solid fa-xmark";
    } else if (idx === state.currentLevelIndex) {
      step.classList.add("active");
      statusIcon.className = "fa-solid fa-headphones";
    } else {
      statusIcon.className = "fa-solid fa-lock";
    }
  });

  const timelineCells = document.querySelectorAll("#segmented-progress-bar .timeline-cell");
  timelineCells.forEach((cell, idx) => {
    cell.className = "timeline-cell";
    const fill = cell.querySelector(".cell-fill");
    if (fill) fill.style.width = "0%";

    if (idx < state.currentLevelIndex) {
      cell.classList.add("unlocked");
      if (fill) fill.style.width = "100%";
    } else if (idx === state.currentLevelIndex) {
      cell.classList.add("active");
    }
  });
}

function updateNavStats() {
  nav.score.textContent = state.totalScore.toLocaleString();
  nav.streak.textContent = `🔥 ${state.currentStreak}`;
  nav.round.textContent = state.roundNumber;
}

// ============================================================
// AUDIO SNIPPET PLAYBACK CONTROLLER
// ============================================================

function toggleSnippetPlayback() {
  if (!isPlayerReady || !ytPlayer) {
    pendingPlayAfterReady = true;
    showFeedback("Connecting audio engine... will play automatically in a moment!", false);
    initYouTubePlayer();
    return;
  }

  if (state.isPlayingSnippet) {
    stopSnippetPlayback();
  } else {
    playCurrentSnippet();
  }
}

async function playCurrentSnippet() {
  if (!isPlayerReady || !ytPlayer) {
    pendingPlayAfterReady = true;
    showFeedback("Connecting audio engine... will play automatically in a moment!", false);
    initYouTubePlayer();
    return;
  }

  stopSnippetPlayback();
  playSFX("click");

  // If audio is still resolving for an external track, wait for it
  if (state.isResolvingAudio || !state.currentSong.id) {
    gameUI.playHintText.textContent = "Buffering audio stream...";
    try {
      const res = await fetch("/api/resolve-track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: state.currentSong.title,
          artist: state.currentSong.artist
        })
      });
      const data = await res.json();
      if (data.videoId) {
        state.currentSong.id = data.videoId;
      }
    } catch (e) {}
  }

  state.isPlayingSnippet = true;
  gameUI.playIcon.className = "fa-solid fa-spinner fa-spin";
  gameUI.playHintText.textContent = "Buffering audio...";

  try {
    let currentLoadedId = null;
    try {
      const data = ytPlayer.getVideoData();
      currentLoadedId = data ? data.video_id : null;
    } catch (e) {}

    if (currentLoadedId === state.currentSong.id) {
      ytPlayer.seekTo(state.startOffset, true);
      ytPlayer.playVideo();
    } else {
      ytPlayer.loadVideoById({
        videoId: state.currentSong.id,
        startSeconds: state.startOffset
      });
    }
  } catch (err) {
    console.error("Playback trigger error:", err);
    state.isPlayingSnippet = false;
    gameUI.playIcon.className = "fa-solid fa-play";
    showFeedback("Error starting audio. Click Play to retry.");
    return;
  }

  clearTimeout(state.bufferWatchdogId);
  state.bufferWatchdogId = setTimeout(() => {
    if (state.isPlayingSnippet && gameUI.playIcon.classList.contains("fa-spin")) {
      stopSnippetPlayback();
      showFeedback("Audio buffering took slightly long. Tap Play to retry.");
    }
  }, 7500);
}

function handleSnippetPlayingStarted() {
  clearTimeout(state.bufferWatchdogId);
  const currentConfig = LEVELS[state.currentLevelIndex];
  const durationMs = currentConfig.duration * 1000;

  startVisualizer();
  gameUI.playHintText.textContent = `Streaming ${currentConfig.label} snippet...`;

  animateProgressFill(currentConfig.duration);

  clearTimeout(state.snippetTimeoutId);
  state.snippetTimeoutId = setTimeout(() => {
    stopSnippetPlayback();
  }, durationMs);
}

function stopSnippetPlayback() {
  clearTimeout(state.snippetTimeoutId);
  clearTimeout(state.bufferWatchdogId);
  cancelAnimationFrame(state.progressAnimId);

  if (isPlayerReady && ytPlayer && typeof ytPlayer.pauseVideo === "function") {
    try {
      ytPlayer.pauseVideo();
    } catch (e) {}
  }

  state.isPlayingSnippet = false;
  stopVisualizer();
  resetProgressFill();
  gameUI.playHintText.innerHTML = `Press <strong>Play</strong> or hit <kbd class="kbd-key">Space</kbd> to listen`;
}

function animateProgressFill(durationSec) {
  const startTime = performance.now();
  const totalMs = durationSec * 1000;
  const activeSegFill = document.querySelector("#segmented-progress-bar .timeline-cell.active .cell-fill");

  function step(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(100, (elapsed / totalMs) * 100);

    if (activeSegFill) {
      activeSegFill.style.width = `${progress}%`;
    }

    if (elapsed < totalMs && state.isPlayingSnippet) {
      state.progressAnimId = requestAnimationFrame(step);
    }
  }

  cancelAnimationFrame(state.progressAnimId);
  state.progressAnimId = requestAnimationFrame(step);
}

function resetProgressFill() {
  const activeSegFill = document.querySelector("#segmented-progress-bar .timeline-cell.active .cell-fill");
  if (activeSegFill) {
    activeSegFill.style.width = "0%";
  }
}

// ============================================================
// AUTOCOMPLETE & SEARCH
// ============================================================

function handleSearchInput(e) {
  const query = e.target.value.trim().toLowerCase();

  if (!query) {
    gameUI.suggestionsDropdown.style.display = "none";
    gameUI.btnClearGuess.style.display = "none";
    gameUI.btnSubmitGuess.disabled = true;
    state.selectedSuggestion = null;
    return;
  }

  gameUI.btnClearGuess.style.display = "block";

  const matches = state.tracks.filter(t => {
    const fullText = `${t.title} ${t.artist} ${t.rawTitle}`.toLowerCase();
    return fullText.includes(query);
  }).slice(0, 7);

  renderSuggestions(matches);
}

function renderSuggestions(matches) {
  if (matches.length === 0) {
    gameUI.suggestionsDropdown.style.display = "none";
    state.selectedSuggestion = null;
    gameUI.btnSubmitGuess.disabled = true;
    return;
  }

  gameUI.suggestionsDropdown.innerHTML = "";
  state.highlightedDropdownIndex = -1;

  matches.forEach((song, idx) => {
    const item = document.createElement("div");
    item.className = "suggestion-item";
    item.dataset.index = idx;
    item.innerHTML = `
      <img class="s-thumb" src="${song.thumbnail}" alt="" onerror="this.style.display='none'">
      <div class="s-info">
        <span class="s-title">${escapeHtml(song.title)}</span>
        <span class="s-artist">${escapeHtml(song.artist)}</span>
      </div>
      <i class="fa-solid fa-arrow-turn-down s-icon"></i>
    `;

    item.addEventListener("click", () => {
      selectSuggestion(song);
    });

    gameUI.suggestionsDropdown.appendChild(item);
  });

  gameUI.suggestionsDropdown.style.display = "block";
}

function selectSuggestion(song) {
  state.selectedSuggestion = song;
  gameUI.guessInput.value = `${song.title} - ${song.artist}`;
  gameUI.suggestionsDropdown.style.display = "none";
  gameUI.btnSubmitGuess.disabled = false;
  gameUI.guessInput.focus();
}

function clearGuessInput() {
  gameUI.guessInput.value = "";
  gameUI.btnClearGuess.style.display = "none";
  gameUI.suggestionsDropdown.style.display = "none";
  gameUI.btnSubmitGuess.disabled = true;
  state.selectedSuggestion = null;
  gameUI.guessInput.focus();
}

function handleSearchKeydown(e) {
  const items = gameUI.suggestionsDropdown.querySelectorAll(".suggestion-item");
  if (items.length === 0) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    state.highlightedDropdownIndex = (state.highlightedDropdownIndex + 1) % items.length;
    updateHighlightedItem(items);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    state.highlightedDropdownIndex = (state.highlightedDropdownIndex - 1 + items.length) % items.length;
    updateHighlightedItem(items);
  } else if (e.key === "Enter") {
    if (state.highlightedDropdownIndex >= 0 && items[state.highlightedDropdownIndex]) {
      e.preventDefault();
      items[state.highlightedDropdownIndex].click();
    } else if (state.selectedSuggestion) {
      e.preventDefault();
      submitGuess();
    }
  } else if (e.key === "Escape") {
    gameUI.suggestionsDropdown.style.display = "none";
  }
}

function updateHighlightedItem(items) {
  items.forEach((item, idx) => {
    if (idx === state.highlightedDropdownIndex) {
      item.classList.add("highlighted");
      item.scrollIntoView({ block: "nearest" });
    } else {
      item.classList.remove("highlighted");
    }
  });
}

// ============================================================
// GUESS VERIFICATION
// ============================================================

function submitGuess() {
  if (!state.selectedSuggestion) {
    showFeedback("Please select a track from the suggestions dropdown.");
    return;
  }

  stopSnippetPlayback();

  // Match by title & artist or ID
  const isMatch = (state.selectedSuggestion.title.toLowerCase() === state.currentSong.title.toLowerCase()) ||
                  (state.selectedSuggestion.id && state.selectedSuggestion.id === state.currentSong.id);

  if (isMatch) {
    handleCorrectGuess();
  } else {
    handleWrongGuess();
  }
}

function handleCorrectGuess() {
  const currentConfig = LEVELS[state.currentLevelIndex];
  const pointsEarned = currentConfig.points;

  state.totalScore += pointsEarned;
  state.currentStreak += 1;
  if (state.currentStreak > state.bestStreak) {
    state.bestStreak = state.currentStreak;
  }

  state.roundsHistory.push({
    song: state.currentSong,
    won: true,
    level: currentConfig.level,
    duration: currentConfig.label,
    points: pointsEarned
  });

  const steps = gameUI.levelsTracker.querySelectorAll(".stage-tab");
  if (steps[state.currentLevelIndex]) {
    steps[state.currentLevelIndex].className = "stage-tab passed-correct";
    steps[state.currentLevelIndex].querySelector(".tab-icon i").className = "fa-solid fa-check";
  }

  playSFX("win");
  triggerConfetti();
  showRevealModal(true, pointsEarned, currentConfig.label);
}

function handleWrongGuess() {
  playSFX("wrong");
  showFeedback(`❌ Not quite! That wasn't "${state.selectedSuggestion.title}". Try next duration!`);
  clearGuessInput();

  if (state.currentLevelIndex < LEVELS.length - 1) {
    state.currentLevelIndex += 1;
    updateLevelUI();
    setTimeout(() => {
      playCurrentSnippet();
    }, 400);
  } else {
    handleMissedRound();
  }
}

function skipToNextLevel() {
  stopSnippetPlayback();

  if (state.currentLevelIndex < LEVELS.length - 1) {
    state.currentLevelIndex += 1;
    updateLevelUI();
    showFeedback(`⏩ Unlocked ${LEVELS[state.currentLevelIndex].label} snippet.`);
    setTimeout(() => {
      playCurrentSnippet();
    }, 200);
  } else {
    handleMissedRound();
  }
}

function giveUpCurrentSong() {
  stopSnippetPlayback();
  handleMissedRound();
}

function handleMissedRound() {
  state.currentStreak = 0;

  state.roundsHistory.push({
    song: state.currentSong,
    won: false,
    level: 7,
    duration: "Missed",
    points: 0
  });

  showRevealModal(false, 0, "Missed");
}

function showFeedback(msg, isPermanent = false) {
  if (!msg) {
    gameUI.guessFeedback.style.display = "none";
    gameUI.guessFeedback.textContent = "";
  } else {
    gameUI.guessFeedback.style.display = "block";
    gameUI.guessFeedback.textContent = msg;

    if (!isPermanent) {
      setTimeout(() => {
        gameUI.guessFeedback.style.display = "none";
      }, 3500);
    }
  }
}

// ============================================================
// REVEAL MODAL & FULL TRACK AUDIO
// ============================================================

function showRevealModal(won, pointsEarned, timeTaken) {
  modalReveal.thumb.src = state.currentSong.thumbnail;
  modalReveal.songTitle.textContent = state.currentSong.title;
  modalReveal.artistName.textContent = state.currentSong.artist;
  modalReveal.ytLink.href = `https://www.youtube.com/watch?v=${state.currentSong.id}`;
  modalReveal.timeTaken.textContent = timeTaken;
  modalReveal.streakVal.textContent = `🔥 ${state.currentStreak}`;

  if (won) {
    modalReveal.badge.className = "reveal-stamp win";
    modalReveal.badge.innerHTML = `<i class="fa-solid fa-trophy"></i> TRACK IDENTIFIED`;
    modalReveal.title.textContent = timeTaken === "1.0s" ? "⚡ GODLIKE EAR! 1-SEC GUESS!" : "🎉 TRACK IDENTIFIED!";
    modalReveal.pointsEarned.textContent = `+${pointsEarned.toLocaleString()} PTS`;
  } else {
    modalReveal.badge.className = "reveal-stamp missed";
    modalReveal.badge.innerHTML = `<i class="fa-solid fa-xmark"></i> MISSED`;
    modalReveal.title.textContent = "BETTER LUCK NEXT TIME";
    modalReveal.pointsEarned.textContent = "0 PTS";
  }

  gameUI.revealedAlbumArt.src = state.currentSong.thumbnail;
  gameUI.revealedAlbumArt.style.display = "block";
  gameUI.vinylMysteryIcon.style.display = "none";

  modalReveal.overlay.style.display = "flex";
  startFullTrackPlayback();
}

function startFullTrackPlayback() {
  if (!isPlayerReady || !ytPlayer || !state.currentSong.id) return;
  state.isPlayingFullTrack = true;
  modalReveal.btnToggleFull.classList.add("playing");
  modalReveal.revealPlayIcon.className = "fa-solid fa-pause";

  ytPlayer.seekTo(0, true);
  ytPlayer.playVideo();
}

function toggleFullTrackPlayback() {
  if (!isPlayerReady || !ytPlayer) return;

  if (state.isPlayingFullTrack) {
    ytPlayer.pauseVideo();
    state.isPlayingFullTrack = false;
    modalReveal.btnToggleFull.classList.remove("playing");
    modalReveal.revealPlayIcon.className = "fa-solid fa-play";
  } else {
    ytPlayer.playVideo();
    state.isPlayingFullTrack = true;
    modalReveal.btnToggleFull.classList.add("playing");
    modalReveal.revealPlayIcon.className = "fa-solid fa-pause";
  }
}

function nextRound() {
  if (isPlayerReady && ytPlayer) {
    try { ytPlayer.pauseVideo(); } catch (e) {}
  }
  state.isPlayingFullTrack = false;
  modalReveal.overlay.style.display = "none";

  state.roundNumber += 1;
  loadRound();
}

// ============================================================
// GAME OVER & SHARE GRID
// ============================================================

function endGame() {
  modalReveal.overlay.style.display = "none";
  modalSummary.overlay.style.display = "flex";

  const totalRounds = state.roundsHistory.length;
  const wins = state.roundsHistory.filter(r => r.won).length;
  const sub1s = state.roundsHistory.filter(r => r.won && r.duration === "1.0s").length;
  const accuracyPct = totalRounds > 0 ? Math.round((wins / totalRounds) * 100) : 0;

  modalSummary.finalScore.textContent = state.totalScore.toLocaleString();
  modalSummary.accuracy.textContent = `${accuracyPct}%`;
  modalSummary.bestStreak.textContent = `${state.bestStreak}`;
  modalSummary.sub1sCount.textContent = `${sub1s}`;

  const gridText = generateShareableGrid(wins, totalRounds);
  modalSummary.shareGrid.textContent = gridText;

  triggerConfetti();
}

function generateShareableGrid(wins, totalRounds) {
  let text = `⚡ BeatDrop (Engineered by Ritesh)\n`;
  text += `Deck: ${state.playlistTitle} [${state.platformBadge}]\n`;
  text += `Score: ${state.totalScore.toLocaleString()} pts | ${wins}/${totalRounds} Correct\n`;
  text += `Best Streak: 🔥 ${state.bestStreak}\n\n`;

  state.roundsHistory.forEach((r, idx) => {
    let emoji = "⬛";
    if (r.won) {
      if (r.level === 1) emoji = "🟩";
      else if (r.level <= 3) emoji = "🟨";
      else emoji = "🟧";
    } else {
      emoji = "🟥";
    }
    text += `${idx + 1}. ${emoji} (${r.duration} - ${r.points} pts)\n`;
  });

  return text.trim();
}

function copyShareScore() {
  const text = modalSummary.shareGrid.textContent;
  navigator.clipboard.writeText(text).then(() => {
    modalSummary.btnCopyScore.innerHTML = `<i class="fa-solid fa-check"></i> COPIED TO CLIPBOARD!`;
    setTimeout(() => {
      modalSummary.btnCopyScore.innerHTML = `<i class="fa-regular fa-copy"></i> COPY SCORE TO CLIPBOARD`;
    }, 2500);
  });
}

function restartGame() {
  modalSummary.overlay.style.display = "none";
  startNewGame();
}

// ============================================================
// UTILITIES & CELEBRATION
// ============================================================

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function triggerConfetti() {
  if (typeof confetti !== "function") return;
  confetti({
    particleCount: 90,
    spread: 75,
    origin: { y: 0.65 },
    colors: ["#ccff00", "#00f0ff", "#ff5500", "#1ed760", "#ffb703"]
  });
}
