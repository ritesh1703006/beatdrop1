/**
 * BEATDROP // UNIVERSAL AUDIO ENGINE
 * Engineered by Ritesh
 * Supports Spotify, Apple Music, YouTube Music, and YouTube Playlists
 */

// ============================================================
// GAME CONFIGURATION & STATE
// ============================================================

const LEVELS = [
  { level: 1, duration: 0.1,  points: 1000, label: "0.1s" },
  { level: 2, duration: 1.0,  points: 800,  label: "1.0s" },
  { level: 3, duration: 2.0,  points: 600,  label: "2.0s" },
  { level: 4, duration: 4.0,  points: 400,  label: "4.0s" },
  { level: 5, duration: 7.0,  points: 200,  label: "7.0s" },
  { level: 6, duration: 16.0, points: 100,  label: "16.0s" }
];

const state = {
  // Mode info: "solo" | "duel-local" | "duel-online"
  mode: "solo",
  p1: { name: "Player 1", score: 0 },
  p2: { name: "Player 2", score: 0 },
  activeBuzzer: null,

  // Online Multiplayer Room State
  online: {
    roomId: null,
    token: null,
    role: null, // "host" | "guest" | "spectator"
    playerName: localStorage.getItem("beatdrop_dj_name") || "Player 1",
    pollTimer: null,
    lastStatus: null,
    lastRound: 0,
    isHost: false,
    hasBuzzedThisRound: false
  },

  // Playlist info
  playlistId: null,
  playlistTitle: "",
  platform: "youtube",
  platformBadge: "YouTube",
  tracks: [],
  remainingTracks: [],
  maxRounds: 10,
  
  // Game metrics (Solo)
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
    label.textContent = text || "Audio Ready";
  } else {
    dot.className = "status-indicator connecting";
    label.textContent = text || "Connecting...";
  }
}

function onPlayerReady(event) {
  isPlayerReady = true;
  updateAudioStatus("ready", "Audio Ready");
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

const duelNav = {
  container: document.getElementById("nav-duel-stats"),
  p1Name: document.getElementById("nav-p1-name"),
  p1Score: document.getElementById("nav-p1-score"),
  p2Name: document.getElementById("nav-p2-name"),
  p2Score: document.getElementById("nav-p2-score"),
  btnQuitDuel: document.getElementById("btn-quit-duel")
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

const duelUI = {
  buzzersBay: document.getElementById("duel-buzzers-bay"),
  btnBuzzP1: document.getElementById("btn-buzz-p1"),
  btnBuzzP2: document.getElementById("btn-buzz-p2"),
  labelP1: document.getElementById("label-p1-buzzer"),
  labelP2: document.getElementById("label-p2-buzzer"),
  statusBanner: document.getElementById("buzzer-status-banner"),
  localConfig: document.getElementById("duel-local-config"),
  onlineConfig: document.getElementById("duel-online-config"),
  inputP1Name: document.getElementById("input-p1-name"),
  inputP2Name: document.getElementById("input-p2-name"),
  modeChip: document.getElementById("current-mode-chip"),
  startBtnLabel: document.getElementById("start-btn-label"),

  // Online multiplayer elements
  prejoinView: document.getElementById("online-prejoin-view"),
  inputPlayerName: document.getElementById("input-online-player-name"),
  btnCreateRoom: document.getElementById("btn-create-room"),
  btnJoinRoom: document.getElementById("btn-join-room"),
  inputRoomCode: document.getElementById("input-room-code"),
  onlineStatusCue: document.getElementById("online-status-cue"),

  activeLobby: document.getElementById("online-active-lobby"),
  lobbyCodeText: document.getElementById("lobby-code-text"),
  btnCopyCode: document.getElementById("btn-copy-code"),
  btnCopyRoomLink: document.getElementById("btn-copy-room-link"),
  btnWhatsappRoomLink: document.getElementById("btn-whatsapp-room-link"),
  lobbyHostName: document.getElementById("lobby-host-name"),
  lobbyGuestName: document.getElementById("lobby-guest-name"),
  lobbyGuestStatus: document.getElementById("lobby-guest-status"),
  lobbyDeckTitle: document.getElementById("lobby-deck-title"),
  btnLobbyStart: document.getElementById("btn-lobby-start"),
  lobbyGuestBanner: document.getElementById("lobby-guest-banner"),
  btnLeaveRoom: document.getElementById("btn-leave-room"),

  // Online HUD & buzzer in game screen
  onlineMatchStrip: document.getElementById("online-match-strip"),
  onlineHudHostName: document.getElementById("online-hud-host-name"),
  onlineHudHostScore: document.getElementById("online-hud-host-score"),
  onlineHudGuestName: document.getElementById("online-hud-guest-name"),
  onlineHudGuestScore: document.getElementById("online-hud-guest-score"),
  onlineHudRound: document.getElementById("online-hud-round"),
  onlineBuzzerCountdown: document.getElementById("online-buzzer-countdown"),
  onlineTimerSeconds: document.getElementById("online-timer-seconds"),
  onlineBuzzerBay: document.getElementById("online-buzzer-bay"),
  btnOnlineBuzzer: document.getElementById("btn-online-buzzer"),
  onlineBuzzerLabel: document.getElementById("online-buzzer-label"),
  onlineBuzzerSubtext: document.getElementById("online-buzzer-subtext"),

  // Duel summary
  duelSummaryPod: document.getElementById("duel-summary-pod"),
  soloSummaryMatrix: document.getElementById("solo-summary-matrix"),
  duelWinnerName: document.getElementById("duel-winner-name"),
  duelP1FinalLabel: document.getElementById("duel-p1-final-label"),
  duelP1FinalScore: document.getElementById("duel-p1-final-score"),
  duelP2FinalLabel: document.getElementById("duel-p2-final-label"),
  duelP2FinalScore: document.getElementById("duel-p2-final-score")
};

const gameUI = {
  sourcePill: document.getElementById("source-platform-pill"),
  sourceName: document.getElementById("source-platform-name"),
  playlistTitle: document.getElementById("game-playlist-title"),
  playlistCount: document.getElementById("playlist-count-badge"),
  vinylDisc: document.getElementById("vinyl-disc"),
  revealedAlbumArt: document.getElementById("revealed-album-art"),
  vinylMysteryIcon: document.querySelector(".vinyl-art-mystery"),
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

const modalHistory = {
  overlay: document.getElementById("modal-history"),
  totalScore: document.getElementById("career-total-score"),
  accuracy: document.getElementById("career-accuracy"),
  bestStreak: document.getElementById("career-best-streak"),
  madnessCount: document.getElementById("career-madness-count"),
  historyList: document.getElementById("career-history-list"),
  btnClose: document.getElementById("btn-close-history"),
  btnClearLog: document.getElementById("btn-clear-history-log"),
  btnOpenHistory: document.getElementById("btn-open-history")
};

const savedDecksUI = {
  section: document.getElementById("recent-decks-section"),
  container: document.getElementById("recent-playlists-container"),
  btnClear: document.getElementById("btn-clear-recent-decks")
};

// ============================================================
// AUDIO VISUALIZER & DUAL VU METERS
// ============================================================

function setupVisualizerBars() {
  if (!gameUI.visualizer) return;
  gameUI.visualizer.innerHTML = "";
  const BAR_COUNT = 32;
  for (let i = 0; i < BAR_COUNT; i++) {
    const bar = document.createElement("div");
    bar.className = "v-bar";
    gameUI.visualizer.appendChild(bar);
  }
}

let visualizerInterval = null;
function startVisualizer() {
  if (!gameUI.visualizer) return;
  const bars = gameUI.visualizer.querySelectorAll(".v-bar");
  bars.forEach(b => b.classList.add("active"));
  if (gameUI.vinylDisc) gameUI.vinylDisc.classList.add("playing");
  if (gameUI.btnPlaySnippet) gameUI.btnPlaySnippet.classList.add("playing");
  if (gameUI.playIcon) gameUI.playIcon.className = "fa-solid fa-volume-high";

  if (gameUI.tonearm) gameUI.tonearm.classList.add("playing");

  const vuSegmentsL = gameUI.vuMeterL ? Array.from(gameUI.vuMeterL.querySelectorAll(".vu-segment")) : [];
  const vuSegmentsR = gameUI.vuMeterR ? Array.from(gameUI.vuMeterR.querySelectorAll(".vu-segment")) : [];

  clearInterval(visualizerInterval);
  visualizerInterval = setInterval(() => {
    bars.forEach((bar, idx) => {
      const centerFactor = 1 - Math.abs(idx - 16) / 18;
      const h = Math.floor(Math.random() * 26 * Math.max(0.2, centerFactor)) + 6;
      bar.style.height = `${h}px`;
    });

    // Realistic VU meter bounce: segments indexed 0 (top, red) to N-1 (bottom, green)
    const countL = Math.floor(Math.random() * 8) + 1;
    const countR = Math.floor(Math.random() * 8) + 1;
    vuSegmentsL.forEach((seg, i) => {
      seg.classList.toggle("active", i >= (vuSegmentsL.length - countL));
    });
    vuSegmentsR.forEach((seg, i) => {
      seg.classList.toggle("active", i >= (vuSegmentsR.length - countR));
    });
  }, 75);
}

function stopVisualizer() {
  clearInterval(visualizerInterval);
  if (gameUI.visualizer) {
    const bars = gameUI.visualizer.querySelectorAll(".v-bar");
    bars.forEach(bar => {
      bar.classList.remove("active");
      bar.style.height = "4px";
    });
  }
  if (gameUI.vinylDisc) gameUI.vinylDisc.classList.remove("playing");
  if (gameUI.btnPlaySnippet) gameUI.btnPlaySnippet.classList.remove("playing");
  if (gameUI.playIcon) gameUI.playIcon.className = "fa-solid fa-play";

  if (gameUI.tonearm) gameUI.tonearm.classList.remove("playing");

  const vuSegments = document.querySelectorAll(".vu-segment");
  vuSegments.forEach(seg => seg.classList.remove("active"));
}

// ============================================================
// INITIALIZATION & PRESETS
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  setupVisualizerBars();
  loadPresets();
  initSavedDecksAndHistory();
  attachEventListeners();
  initOnlineRoomParams();
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
      <div class="preset-card-top">
        <span class="preset-cat">${escapeHtml(p.category)}</span>
        ${index === 0 ? '<span class="preset-badge-pill">FLAGSHIP</span>' : ''}
      </div>
      <div class="preset-name">${escapeHtml(p.name)}</div>
      <div class="preset-desc">${escapeHtml(p.description)}</div>
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

  if (duelNav.btnQuitDuel) {
    duelNav.btnQuitDuel.addEventListener("click", () => {
      if (confirm("Quit 1v1 Duel session and return to lobby?")) {
        stopSnippetPlayback();
        showScreen("setup");
      }
    });
  }

  // Mode tabs listener
  const modeButtons = document.querySelectorAll(".mode-select-btn");
  modeButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      modeButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const mode = btn.dataset.mode;
      state.mode = mode;

      if (mode === "duel-local") {
        if (duelUI.localConfig) duelUI.localConfig.style.display = "block";
        if (duelUI.onlineConfig) duelUI.onlineConfig.style.display = "none";
        if (duelUI.modeChip) duelUI.modeChip.textContent = "1V1 DUEL";
        if (duelUI.startBtnLabel) duelUI.startBtnLabel.textContent = "START 1V1 DUEL";
      } else if (mode === "duel-online") {
        if (duelUI.localConfig) duelUI.localConfig.style.display = "none";
        if (duelUI.onlineConfig) duelUI.onlineConfig.style.display = "block";
        if (duelUI.modeChip) duelUI.modeChip.textContent = "ONLINE ROOM";
        if (duelUI.startBtnLabel) duelUI.startBtnLabel.textContent = "LAUNCH ROOM";
      } else {
        if (duelUI.localConfig) duelUI.localConfig.style.display = "none";
        if (duelUI.onlineConfig) duelUI.onlineConfig.style.display = "none";
        if (duelUI.modeChip) duelUI.modeChip.textContent = "SOLO";
        if (duelUI.startBtnLabel) duelUI.startBtnLabel.textContent = "START CHALLENGE";
      }
    });
  });

  // Duel buzzer buttons
  if (duelUI.btnBuzzP1) duelUI.btnBuzzP1.addEventListener("click", () => handleBuzzerPress(1));
  if (duelUI.btnBuzzP2) duelUI.btnBuzzP2.addEventListener("click", () => handleBuzzerPress(2));

  // Online multiplayer handlers
  if (duelUI.btnCreateRoom) duelUI.btnCreateRoom.addEventListener("click", createOnlineRoom);
  if (duelUI.btnJoinRoom) {
    duelUI.btnJoinRoom.addEventListener("click", () => {
      const code = duelUI.inputRoomCode ? duelUI.inputRoomCode.value.trim() : "";
      joinOnlineRoom(code);
    });
  }
  if (duelUI.inputRoomCode) {
    duelUI.inputRoomCode.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        joinOnlineRoom(duelUI.inputRoomCode.value.trim());
      }
    });
  }
  if (duelUI.btnCopyCode) duelUI.btnCopyCode.addEventListener("click", copyRoomCode);
  if (duelUI.btnCopyRoomLink) duelUI.btnCopyRoomLink.addEventListener("click", copyRoomLink);
  if (duelUI.btnWhatsappRoomLink) duelUI.btnWhatsappRoomLink.addEventListener("click", shareRoomWhatsApp);
  if (duelUI.btnLobbyStart) duelUI.btnLobbyStart.addEventListener("click", startOnlineBattle);
  if (duelUI.btnLeaveRoom) duelUI.btnLeaveRoom.addEventListener("click", () => leaveOnlineRoom(true));
  if (duelUI.btnOnlineBuzzer) duelUI.btnOnlineBuzzer.addEventListener("click", buzzOnline);

  // Career stats & History modal handlers
  if (modalHistory.btnOpenHistory) {
    modalHistory.btnOpenHistory.addEventListener("click", openCareerHistoryModal);
  }
  if (modalHistory.btnClose) {
    modalHistory.btnClose.addEventListener("click", closeCareerHistoryModal);
  }
  if (modalHistory.overlay) {
    modalHistory.overlay.addEventListener("click", (e) => {
      if (e.target === modalHistory.overlay) closeCareerHistoryModal();
    });
  }
  if (modalHistory.btnClearLog) {
    modalHistory.btnClearLog.addEventListener("click", clearCareerHistory);
  }

  // Saved Decks handlers
  if (savedDecksUI.btnClear) {
    savedDecksUI.btnClear.addEventListener("click", clearAllSavedPlaylists);
  }

  // Close modals on Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (modalHistory.overlay && modalHistory.overlay.style.display === "flex") {
        closeCareerHistoryModal();
      }
    }
  });

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
    
    // In 1v1 duel mode, handle buzzers: 'KeyA' for P1, 'KeyL' for P2
    if (state.mode === "duel-local" && screens.game.classList.contains("active") && modalReveal.overlay.style.display === "none") {
      if (e.code === "KeyA") {
        e.preventDefault();
        handleBuzzerPress(1);
        return;
      } else if (e.code === "KeyL") {
        e.preventDefault();
        handleBuzzerPress(2);
        return;
      }
    }

    // In 1v1 online mode, Space or B buzzes in!
    if (state.mode === "duel-online" && screens.game.classList.contains("active") && modalReveal.overlay.style.display === "none") {
      if (e.code === "Space" || e.code === "KeyB") {
        e.preventDefault();
        buzzOnline();
        return;
      }
    }

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

function handleBuzzerPress(playerNum) {
  if (state.mode !== "duel-local") return;
  if (state.activeBuzzer) return; // already buzzed

  stopSnippetPlayback();
  state.activeBuzzer = playerNum;
  playSFX("click");

  const activeName = playerNum === 1 ? state.p1.name : state.p2.name;

  if (playerNum === 1) {
    if (duelUI.btnBuzzP1) duelUI.btnBuzzP1.classList.add("active-buzzer");
    if (duelUI.btnBuzzP2) duelUI.btnBuzzP2.classList.add("locked-out");
  } else {
    if (duelUI.btnBuzzP2) duelUI.btnBuzzP2.classList.add("active-buzzer");
    if (duelUI.btnBuzzP1) duelUI.btnBuzzP1.classList.add("locked-out");
  }

  if (duelUI.statusBanner) {
    duelUI.statusBanner.innerHTML = `⚡ <strong>${escapeHtml(activeName)}</strong> BUZZED! (TYPE GUESS)`;
  }

  gameUI.guessInput.focus();
}

function resetBuzzers() {
  state.activeBuzzer = null;
  if (duelUI.btnBuzzP1) {
    duelUI.btnBuzzP1.classList.remove("active-buzzer");
    duelUI.btnBuzzP1.classList.remove("locked-out");
  }
  if (duelUI.btnBuzzP2) {
    duelUI.btnBuzzP2.classList.remove("active-buzzer");
    duelUI.btnBuzzP2.classList.remove("locked-out");
  }
  if (duelUI.statusBanner) {
    duelUI.statusBanner.innerHTML = `<span>HIT BUZZER (<kbd>A</kbd> / <kbd>L</kbd>) TO GUESS!</span>`;
  }
}

function updateDuelScoreboard() {
  if (duelNav.p1Name) duelNav.p1Name.textContent = state.p1.name;
  if (duelNav.p1Score) duelNav.p1Score.textContent = state.p1.score.toLocaleString();
  if (duelNav.p2Name) duelNav.p2Name.textContent = state.p2.name;
  if (duelNav.p2Score) duelNav.p2Score.textContent = state.p2.score.toLocaleString();
}

// ============================================================
// ONLINE MULTIPLAYER ROOM ENGINE (REAL-TIME 2-PLAYER)
// ============================================================

function showOnlineStatus(msg, type = "info") {
  if (!duelUI.onlineStatusCue) return;
  if (!msg) {
    duelUI.onlineStatusCue.style.display = "none";
    duelUI.onlineStatusCue.innerHTML = "";
    return;
  }
  duelUI.onlineStatusCue.className = `online-status-box ${type}`;
  duelUI.onlineStatusCue.innerHTML = msg;
  duelUI.onlineStatusCue.style.display = "flex";
}

function initOnlineRoomParams() {
  const params = new URLSearchParams(window.location.search);
  const roomCode = params.get("room") || params.get("join");
  if (roomCode) {
    const cleanCode = roomCode.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const onlineBtn = document.querySelector('[data-mode="duel-online"]');
    if (onlineBtn) onlineBtn.click();

    if (duelUI.inputRoomCode) duelUI.inputRoomCode.value = cleanCode;
    showOnlineStatus(`🎯 Invited to Room <strong>${escapeHtml(cleanCode)}</strong>! Enter your name and tap <strong>JOIN</strong> to battle!`, "info");
    if (duelUI.onlineConfig) duelUI.onlineConfig.scrollIntoView({ behavior: "smooth" });
  }
}

function getStoredPlayerName(defaultName = "Player 1") {
  if (duelUI.inputPlayerName && duelUI.inputPlayerName.value.trim()) {
    const name = duelUI.inputPlayerName.value.trim();
    localStorage.setItem("beatdrop_dj_name", name);
    return name;
  }
  const stored = localStorage.getItem("beatdrop_dj_name");
  return stored || defaultName;
}

async function createOnlineRoom() {
  const playerName = getStoredPlayerName("Host");
  const playlistUrl = setupUI.urlInput.value.trim();

  showOnlineStatus("⏳ Creating private room and preparing audio catalog...", "info");
  if (duelUI.btnCreateRoom) duelUI.btnCreateRoom.disabled = true;

  try {
    const res = await fetch("/api/room/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        player_name: playerName,
        playlist_url: playlistUrl
      })
    });

    const data = await res.json();
    if (!res.ok) {
      showOnlineStatus(data.error || "Could not create room.", "error");
      return;
    }

    state.online.roomId = data.room_id;
    state.online.token = data.token;
    state.online.role = data.role;
    state.online.isHost = true;
    state.online.playerName = playerName;
    state.mode = "duel-online";

    window.history.replaceState({}, "", `?room=${data.room_id}`);

    if (duelUI.prejoinView) duelUI.prejoinView.style.display = "none";
    if (duelUI.activeLobby) duelUI.activeLobby.style.display = "flex";

    renderRoomLobby(data.room, "host");
    startRoomPolling();
    playSFX("click");
  } catch (err) {
    showOnlineStatus("Network error creating room: " + err.message, "error");
  } finally {
    if (duelUI.btnCreateRoom) duelUI.btnCreateRoom.disabled = false;
  }
}

async function joinOnlineRoom(rawCode) {
  const cleanCode = (rawCode || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!cleanCode) {
    showOnlineStatus("Please enter a valid Room Code (e.g. DHH42).", "error");
    if (duelUI.inputRoomCode) duelUI.inputRoomCode.focus();
    return;
  }

  const playerName = getStoredPlayerName("Guest");
  showOnlineStatus(`Connecting to Room <strong>${cleanCode}</strong>...`, "info");
  if (duelUI.btnJoinRoom) duelUI.btnJoinRoom.disabled = true;

  try {
    const res = await fetch("/api/room/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room_id: cleanCode,
        player_name: playerName
      })
    });

    const data = await res.json();
    if (!res.ok) {
      showOnlineStatus(data.error || "Failed to join room.", "error");
      return;
    }

    state.online.roomId = data.room_id;
    state.online.token = data.token;
    state.online.role = data.role;
    state.online.isHost = false;
    state.online.playerName = playerName;
    state.mode = "duel-online";

    window.history.replaceState({}, "", `?room=${data.room_id}`);

    if (duelUI.prejoinView) duelUI.prejoinView.style.display = "none";
    if (duelUI.activeLobby) duelUI.activeLobby.style.display = "flex";

    renderRoomLobby(data.room, "guest");
    startRoomPolling();
    playSFX("click");
  } catch (err) {
    showOnlineStatus("Network error joining room: " + err.message, "error");
  } finally {
    if (duelUI.btnJoinRoom) duelUI.btnJoinRoom.disabled = false;
  }
}

function startRoomPolling() {
  if (state.online.pollTimer) clearInterval(state.online.pollTimer);
  pollRoomStatus();
  state.online.pollTimer = setInterval(pollRoomStatus, 1000);
}

function stopRoomPolling() {
  if (state.online.pollTimer) {
    clearInterval(state.online.pollTimer);
    state.online.pollTimer = null;
  }
}

async function pollRoomStatus() {
  if (!state.online.roomId || !state.online.token) return;

  try {
    const res = await fetch(`/api/room/${state.online.roomId}?token=${state.online.token}`);
    if (res.status === 404) {
      stopRoomPolling();
      alert("This room has ended or was closed by the host.");
      leaveOnlineRoom(false);
      return;
    }

    const data = await res.json();
    if (res.ok && data.room) {
      handleRoomUpdate(data.room, data.role || state.online.role);
    }
  } catch (err) {
    // Ignore transient hiccups
  }
}

function renderRoomLobby(room, role) {
  if (!room) return;
  if (duelUI.lobbyCodeText) duelUI.lobbyCodeText.textContent = room.id;
  if (duelUI.lobbyHostName) duelUI.lobbyHostName.textContent = room.host ? room.host.name : "Host";

  if (room.guest) {
    if (duelUI.lobbyGuestName) duelUI.lobbyGuestName.textContent = room.guest.name;
    if (duelUI.lobbyGuestStatus) {
      duelUI.lobbyGuestStatus.className = "roster-status connected";
      duelUI.lobbyGuestStatus.textContent = room.guest.connected ? "🟢 Ready to Battle" : "⏳ Reconnecting...";
    }
  } else {
    if (duelUI.lobbyGuestName) duelUI.lobbyGuestName.textContent = "Waiting for Player 2...";
    if (duelUI.lobbyGuestStatus) {
      duelUI.lobbyGuestStatus.className = "roster-status waiting";
      duelUI.lobbyGuestStatus.textContent = "⏳ Share code or invite link to battle";
    }
  }

  if (duelUI.lobbyDeckTitle) duelUI.lobbyDeckTitle.textContent = room.playlist_name || "Curated Deck";

  const isHost = (role === "host" || state.online.isHost);
  if (isHost) {
    if (duelUI.btnLobbyStart) {
      duelUI.btnLobbyStart.style.display = "flex";
      duelUI.btnLobbyStart.innerHTML = room.guest 
        ? '<i class="fa-solid fa-bolt"></i> <span>START 1V1 BATTLE</span>'
        : '<i class="fa-solid fa-bolt"></i> <span>START (WAITING FOR GUEST)</span>';
    }
    if (duelUI.lobbyGuestBanner) duelUI.lobbyGuestBanner.style.display = "none";
  } else {
    if (duelUI.btnLobbyStart) duelUI.btnLobbyStart.style.display = "none";
    if (duelUI.lobbyGuestBanner) duelUI.lobbyGuestBanner.style.display = "flex";
  }
}

function handleRoomUpdate(room, role) {
  if (!room) return;
  const isHost = (role === "host" || state.online.isHost);

  // If in Setup screen, update lobby
  if (screens.setup.classList.contains("active")) {
    renderRoomLobby(room, role);
  }

  // Populate autocomplete suggestions from room pool
  if (room.autocomplete_pool && room.autocomplete_pool.length > 0) {
    state.tracks = room.autocomplete_pool;
  }

  // Check state transitions
  if (room.status === "playing") {
    if (!screens.game.classList.contains("active")) {
      showScreen("game");
      if (gameUI.playlistTitle) gameUI.playlistTitle.textContent = room.playlist_name || "1v1 Duel";
      if (gameUI.playlistCount) gameUI.playlistCount.textContent = `${room.total_rounds} ROUNDS`;
    }

    if (duelUI.onlineHudHostName) duelUI.onlineHudHostName.textContent = room.host ? room.host.name : "Host";
    if (duelUI.onlineHudHostScore) duelUI.onlineHudHostScore.textContent = `${room.host ? room.host.score : 0} PTS`;
    if (duelUI.onlineHudGuestName) duelUI.onlineHudGuestName.textContent = room.guest ? room.guest.name : "Guest";
    if (duelUI.onlineHudGuestScore) duelUI.onlineHudGuestScore.textContent = `${room.guest ? room.guest.score : 0} PTS`;
    if (duelUI.onlineHudRound) duelUI.onlineHudRound.textContent = `ROUND ${room.round} / ${room.total_rounds}`;

    if (state.online.lastRound !== room.round) {
      state.online.lastRound = room.round;
      modalReveal.overlay.style.display = "none";
      clearGuessInput();
      resetOnlineBuzzerUI();

      if (room.current_track) {
        state.currentSong = {
          id: room.current_track.videoId,
          title: "Mystery Song",
          artist: "Mystery Artist",
          thumbnail: ""
        };
        state.startOffset = room.current_track.start_seconds || 0;
        playCurrentSnippet();
      }
    }

    // Buzzer state
    if (room.buzzer) {
      if (duelUI.onlineBuzzerCountdown) duelUI.onlineBuzzerCountdown.style.display = "inline-flex";
      if (duelUI.onlineTimerSeconds) duelUI.onlineTimerSeconds.textContent = `${room.buzzer.seconds_left}s`;

      const amIBuzzer = (room.buzzer.player === role);
      if (amIBuzzer) {
        if (duelUI.btnOnlineBuzzer) {
          duelUI.btnOnlineBuzzer.className = "btn-online-buzzer active-buzzer";
        }
        if (duelUI.onlineBuzzerLabel) duelUI.onlineBuzzerLabel.textContent = "⚡ YOU BUZZED! (GUESS NOW)";
        if (duelUI.onlineBuzzerSubtext) duelUI.onlineBuzzerSubtext.textContent = `${room.buzzer.seconds_left}s remaining to submit guess`;
        
        gameUI.guessInput.disabled = false;
        gameUI.guessInput.focus();
        stopSnippetPlayback();
      } else {
        if (duelUI.btnOnlineBuzzer) {
          duelUI.btnOnlineBuzzer.className = "btn-online-buzzer locked-out";
        }
        if (duelUI.onlineBuzzerLabel) duelUI.onlineBuzzerLabel.textContent = `⏳ ${room.buzzer.player_name.toUpperCase()} BUZZED!`;
        if (duelUI.onlineBuzzerSubtext) duelUI.onlineBuzzerSubtext.textContent = "Waiting for opponent's guess...";
        
        gameUI.guessInput.disabled = true;
        stopSnippetPlayback();
      }
    } else {
      if (duelUI.onlineBuzzerCountdown) duelUI.onlineBuzzerCountdown.style.display = "none";
      if (duelUI.btnOnlineBuzzer) {
        duelUI.btnOnlineBuzzer.className = "btn-online-buzzer";
      }
      if (duelUI.onlineBuzzerLabel) duelUI.onlineBuzzerLabel.textContent = "⚡ TAP TO BUZZ IN!";
      if (duelUI.onlineBuzzerSubtext) duelUI.onlineBuzzerSubtext.textContent = "Freezes music & unlocks 10s guess window";
      
      gameUI.guessInput.disabled = true;
    }
  } else if (room.status === "revealed") {
    stopSnippetPlayback();
    if (modalReveal.overlay.style.display !== "flex") {
      showOnlineTrackReveal(room, role);
    }
  } else if (room.status === "finished") {
    stopSnippetPlayback();
    modalReveal.overlay.style.display = "none";
    showOnlineSessionSummary(room);
  }
}

function resetOnlineBuzzerUI() {
  if (duelUI.btnOnlineBuzzer) duelUI.btnOnlineBuzzer.className = "btn-online-buzzer";
  if (duelUI.onlineBuzzerLabel) duelUI.onlineBuzzerLabel.textContent = "⚡ TAP TO BUZZ IN!";
  if (duelUI.onlineBuzzerSubtext) duelUI.onlineBuzzerSubtext.textContent = "Freezes music & unlocks 10s guess window";
  if (duelUI.onlineBuzzerCountdown) duelUI.onlineBuzzerCountdown.style.display = "none";
  gameUI.guessInput.disabled = true;
}

function showOnlineTrackReveal(room, role) {
  const result = room.round_result || {};
  modalReveal.overlay.style.display = "flex";

  const amIWinner = (result.winner === role);

  // Record this track into career stats if not already recorded this round
  if (state.online.lastRecordedRound !== room.round) {
    state.online.lastRecordedRound = room.round;
    recordSongHistory(
      amIWinner,
      amIWinner ? 1000 : 0,
      `Round ${room.round}`,
      {
        title: result.song_title || "Unknown Track",
        artist: result.artist_name || "Unknown Artist",
        thumbnail: result.thumbnail || ""
      }
    );
  }

  if (modalReveal.thumb) modalReveal.thumb.src = result.thumbnail || "";
  if (modalReveal.songTitle) modalReveal.songTitle.textContent = result.song_title || "Unknown Song";
  if (modalReveal.artistName) modalReveal.artistName.textContent = result.artist_name || "Unknown Artist";
  if (modalReveal.timeTaken) modalReveal.timeTaken.textContent = `Round ${room.round}`;
  if (modalReveal.ytLink && result.videoId) {
    modalReveal.ytLink.href = `https://www.youtube.com/watch?v=${result.videoId}`;
  }

  if (amIWinner) {
    playSFX("win");
    if (modalReveal.badge) modalReveal.badge.innerHTML = '<i class="fa-solid fa-trophy"></i> ROUND WON!';
    if (modalReveal.title) modalReveal.title.textContent = "YOU EARNED 1 POINT!";
    if (modalReveal.pointsEarned) modalReveal.pointsEarned.textContent = "+1 PT";
    triggerConfetti();
  } else if (result.winner) {
    playSFX("wrong");
    if (modalReveal.badge) modalReveal.badge.innerHTML = '<i class="fa-solid fa-bolt"></i> OPPONENT SCORED';
    if (modalReveal.title) modalReveal.title.textContent = `${result.winner_name} WON THIS ROUND!`;
    if (modalReveal.pointsEarned) modalReveal.pointsEarned.textContent = "+0 PTS";
  } else {
    playSFX("wrong");
    if (modalReveal.badge) modalReveal.badge.innerHTML = '<i class="fa-solid fa-forward-step"></i> TRACK REVEALED';
    if (modalReveal.title) modalReveal.title.textContent = "NO POINTS AWARDED";
    if (modalReveal.pointsEarned) modalReveal.pointsEarned.textContent = "+0 PTS";
  }

  const isHost = (role === "host" || state.online.isHost);
  if (isHost) {
    modalReveal.btnNextRound.disabled = false;
    modalReveal.btnNextRound.innerHTML = (room.round >= room.total_rounds)
      ? '<span>VIEW FINAL SCORES</span> <i class="fa-solid fa-trophy"></i>'
      : `<span>NEXT TRACK (ROUND ${room.round + 1})</span> <i class="fa-solid fa-arrow-right"></i>`;
  } else {
    modalReveal.btnNextRound.disabled = true;
    modalReveal.btnNextRound.innerHTML = '<span>WAITING FOR HOST TO ADVANCE...</span>';
  }
}

function showOnlineSessionSummary(room) {
  modalSummary.overlay.style.display = "flex";
  if (duelUI.soloSummaryMatrix) duelUI.soloSummaryMatrix.style.display = "none";
  if (duelUI.duelSummaryPod) duelUI.duelSummaryPod.style.display = "block";

  const hostName = room.host ? room.host.name : "Player 1";
  const hostScore = room.host ? room.host.score : 0;
  const guestName = room.guest ? room.guest.name : "Player 2";
  const guestScore = room.guest ? room.guest.score : 0;

  if (duelUI.duelP1FinalLabel) duelUI.duelP1FinalLabel.textContent = hostName.toUpperCase();
  if (duelUI.duelP1FinalScore) duelUI.duelP1FinalScore.textContent = `${hostScore} PTS`;
  if (duelUI.duelP2FinalLabel) duelUI.duelP2FinalLabel.textContent = guestName.toUpperCase();
  if (duelUI.duelP2FinalScore) duelUI.duelP2FinalScore.textContent = `${guestScore} PTS`;

  if (hostScore > guestScore) {
    if (duelUI.duelWinnerName) duelUI.duelWinnerName.textContent = `${hostName.toUpperCase()} WINS THE BATTLE! 👑`;
    triggerConfetti();
  } else if (guestScore > hostScore) {
    if (duelUI.duelWinnerName) duelUI.duelWinnerName.textContent = `${guestName.toUpperCase()} WINS THE BATTLE! 👑`;
    triggerConfetti();
  } else {
    if (duelUI.duelWinnerName) duelUI.duelWinnerName.textContent = "IT'S A DRAW BATTLE! 🤝";
  }
}

async function startOnlineBattle() {
  if (!state.online.roomId || !state.online.token) return;
  if (!state.online.isHost) return;

  if (duelUI.btnLobbyStart) duelUI.btnLobbyStart.disabled = true;
  try {
    const res = await fetch(`/api/room/${state.online.roomId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: state.online.token,
        total_rounds: 5
      })
    });
    const data = await res.json();
    if (res.ok) {
      handleRoomUpdate(data.room, "host");
    } else {
      alert(data.error || "Could not start battle.");
    }
  } catch (err) {
    alert("Error starting battle: " + err.message);
  } finally {
    if (duelUI.btnLobbyStart) duelUI.btnLobbyStart.disabled = false;
  }
}

async function buzzOnline() {
  if (state.mode !== "duel-online") return;
  if (!state.online.roomId || !state.online.token) return;

  try {
    const res = await fetch(`/api/room/${state.online.roomId}/buzz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: state.online.token })
    });
    const data = await res.json();
    if (res.ok) {
      playSFX("click");
      handleRoomUpdate(data.room, state.online.role);
    } else {
      showFeedback(data.error || "Buzzer locked!");
    }
  } catch (err) {
    showFeedback("Network error buzzing: " + err.message);
  }
}

async function submitOnlineGuess(guessText) {
  if (!state.online.roomId || !state.online.token) return;
  if (!guessText) return;

  try {
    const res = await fetch(`/api/room/${state.online.roomId}/guess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: state.online.token,
        guess: guessText
      })
    });
    const data = await res.json();
    if (!res.ok) {
      showFeedback(data.error || "Could not submit guess.");
      return;
    }

    if (data.correct) {
      playSFX("win");
      handleRoomUpdate(data.room, state.online.role);
    } else {
      playSFX("wrong");
      showFeedback(data.message || "❌ Incorrect guess! Buzzer released.");
      handleRoomUpdate(data.room, state.online.role);
    }
  } catch (err) {
    showFeedback("Network error submitting guess: " + err.message);
  }
}

async function skipOnlineRound() {
  if (!state.online.roomId || !state.online.token) return;
  try {
    const res = await fetch(`/api/room/${state.online.roomId}/skip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: state.online.token })
    });
    const data = await res.json();
    if (res.ok) {
      handleRoomUpdate(data.room, state.online.role);
    }
  } catch (err) {}
}

async function advanceOnlineRound() {
  if (!state.online.roomId || !state.online.token) return;
  if (!state.online.isHost) return;

  try {
    const res = await fetch(`/api/room/${state.online.roomId}/next`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: state.online.token })
    });
    const data = await res.json();
    if (res.ok) {
      handleRoomUpdate(data.room, "host");
    }
  } catch (err) {
    alert("Could not advance round: " + err.message);
  }
}

function copyRoomCode() {
  if (!state.online.roomId) return;
  navigator.clipboard.writeText(state.online.roomId).then(() => {
    if (duelUI.btnCopyCode) {
      const origHtml = duelUI.btnCopyCode.innerHTML;
      duelUI.btnCopyCode.innerHTML = '<i class="fa-solid fa-check"></i> <span>COPIED!</span>';
      setTimeout(() => { duelUI.btnCopyCode.innerHTML = origHtml; }, 2000);
    }
  }).catch(() => {});
}

function copyRoomLink() {
  if (!state.online.roomId) return;
  const url = `${window.location.origin}${window.location.pathname}?room=${state.online.roomId}`;
  navigator.clipboard.writeText(url).then(() => {
    if (duelUI.btnCopyRoomLink) {
      const origHtml = duelUI.btnCopyRoomLink.innerHTML;
      duelUI.btnCopyRoomLink.innerHTML = '<i class="fa-solid fa-check"></i> <span>LINK COPIED!</span>';
      setTimeout(() => { duelUI.btnCopyRoomLink.innerHTML = origHtml; }, 2000);
    }
  }).catch(() => {});
}

function shareRoomWhatsApp() {
  if (!state.online.roomId) return;
  const url = `${window.location.origin}${window.location.pathname}?room=${state.online.roomId}`;
  const text = `Join my BeatDrop 1v1 Music Duel! 🎵🔥\n\nRoom Code: ${state.online.roomId}\nTap to join directly:\n${url}`;
  window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, "_blank");
}

async function leaveOnlineRoom(notifyServer = true) {
  stopRoomPolling();
  if (notifyServer && state.online.roomId && state.online.token) {
    try {
      await fetch(`/api/room/${state.online.roomId}/leave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: state.online.token })
      });
    } catch (e) {}
  }

  state.online.roomId = null;
  state.online.token = null;
  state.online.role = null;
  state.online.isHost = false;
  state.online.lastRound = 0;

  window.history.replaceState({}, "", window.location.pathname);

  if (duelUI.activeLobby) duelUI.activeLobby.style.display = "none";
  if (duelUI.prejoinView) duelUI.prejoinView.style.display = "block";
  showOnlineStatus("");

  stopSnippetPlayback();
  showScreen("setup");
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
    if (duelNav.container) duelNav.container.style.display = "none";
    if (duelUI.onlineMatchStrip) duelUI.onlineMatchStrip.style.display = "none";
    if (duelUI.onlineBuzzerBay) duelUI.onlineBuzzerBay.style.display = "none";
  } else {
    screens.game.classList.add("active");
    if (state.mode === "duel-local") {
      nav.stats.style.display = "none";
      if (duelNav.container) duelNav.container.style.display = "flex";
      if (duelUI.buzzersBay) duelUI.buzzersBay.style.display = "flex";
      if (duelUI.onlineMatchStrip) duelUI.onlineMatchStrip.style.display = "none";
      if (duelUI.onlineBuzzerBay) duelUI.onlineBuzzerBay.style.display = "none";
    } else if (state.mode === "duel-online") {
      nav.stats.style.display = "none";
      if (duelNav.container) duelNav.container.style.display = "none";
      if (duelUI.buzzersBay) duelUI.buzzersBay.style.display = "none";
      if (duelUI.onlineMatchStrip) duelUI.onlineMatchStrip.style.display = "flex";
      if (duelUI.onlineBuzzerBay) duelUI.onlineBuzzerBay.style.display = "block";
    } else {
      nav.stats.style.display = "flex";
      if (duelNav.container) duelNav.container.style.display = "none";
      if (duelUI.buzzersBay) duelUI.buzzersBay.style.display = "none";
      if (duelUI.onlineMatchStrip) duelUI.onlineMatchStrip.style.display = "none";
      if (duelUI.onlineBuzzerBay) duelUI.onlineBuzzerBay.style.display = "none";
    }
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

    // Persist this playlist to Saved Decks & remember last URL
    saveRecentPlaylist({
      url: url,
      title: data.title || "Custom Playlist",
      platform: data.platform || "youtube",
      platformBadge: data.platformBadge || "PLAYLIST",
      trackCount: data.tracks ? data.tracks.length : 0
    });

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

  if (state.mode === "duel-local") {
    state.p1 = { name: (duelUI.inputP1Name && duelUI.inputP1Name.value.trim()) || "Player 1", score: 0 };
    state.p2 = { name: (duelUI.inputP2Name && duelUI.inputP2Name.value.trim()) || "Player 2", score: 0 };
    state.activeBuzzer = null;
    if (duelUI.labelP1) duelUI.labelP1.textContent = state.p1.name.toUpperCase();
    if (duelUI.labelP2) duelUI.labelP2.textContent = state.p2.name.toUpperCase();
    updateDuelScoreboard();
  }

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

  resetBuzzers();
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
  if (gameUI.vinylDisc) gameUI.vinylDisc.classList.remove("playing");
  if (gameUI.vinylMysteryIcon) gameUI.vinylMysteryIcon.style.display = "flex";
  if (gameUI.revealedAlbumArt) {
    gameUI.revealedAlbumArt.style.display = "none";
    gameUI.revealedAlbumArt.src = "";
  }

  updateLevelUI();
  resetProgressFill();
  showFeedback("");
}

function updateLevelUI() {
  const currentConfig = LEVELS[state.currentLevelIndex];

  if (gameUI.currentLevelTag) gameUI.currentLevelTag.textContent = `STAGE ${currentConfig.level}`;
  if (gameUI.currentDurationTag) gameUI.currentDurationTag.textContent = currentConfig.label;
  if (gameUI.currentPointsTag) gameUI.currentPointsTag.textContent = `+${currentConfig.points.toLocaleString()} PTS`;
  if (gameUI.playHintText) {
    if (state.mode === "duel-local") {
      gameUI.playHintText.innerHTML = `LISTEN TO <strong>${currentConfig.label}</strong> (HIT <kbd class="hardware-key">A</kbd> OR <kbd class="hardware-key">L</kbd> TO BUZZ)`;
    } else {
      gameUI.playHintText.innerHTML = `LISTEN TO <strong>${currentConfig.label}</strong> (TAP PLAY OR <kbd class="hardware-key">SPACE</kbd>)`;
    }
  }

  if (state.currentLevelIndex < LEVELS.length - 1) {
    const nextConfig = LEVELS[state.currentLevelIndex + 1];
    if (gameUI.skipBtnText) gameUI.skipBtnText.textContent = `SKIP TO ${nextConfig.label}`;
    if (gameUI.btnSkipLevel) gameUI.btnSkipLevel.style.display = "inline-flex";
  } else {
    if (gameUI.btnSkipLevel) gameUI.btnSkipLevel.style.display = "none";
  }

  // Update unified 6-stage timeline slots
  const slots = document.querySelectorAll("#segmented-progress-bar .timeline-slot");
  slots.forEach((slot, idx) => {
    slot.className = "timeline-slot";
    const meter = slot.querySelector(".slot-meter");
    const statusIcon = slot.querySelector(".slot-status-icon i");
    if (meter) meter.style.width = "0%";

    if (idx < state.currentLevelIndex) {
      slot.classList.add("passed-wrong");
      if (meter) meter.style.width = "100%";
      if (statusIcon) statusIcon.className = "fa-solid fa-xmark";
    } else if (idx === state.currentLevelIndex) {
      slot.classList.add("active");
      if (statusIcon) statusIcon.className = "fa-solid fa-headphones";
    } else {
      if (statusIcon) statusIcon.className = "fa-solid fa-lock";
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
    showFeedback("Connecting audio... will play automatically in a moment!", false);
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
    showFeedback("Connecting audio... will play automatically in a moment!", false);
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

  if (state.mode === "duel-online") {
    startVisualizer();
    if (gameUI.playHintText) gameUI.playHintText.textContent = "Streaming audio snippet... HIT BUZZ TO GUESS!";
    clearTimeout(state.snippetTimeoutId);
    state.snippetTimeoutId = setTimeout(() => {
      stopSnippetPlayback();
    }, 16000);
    return;
  }

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
  const activeMeter = document.querySelector("#segmented-progress-bar .timeline-slot.active .slot-meter");

  function step(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(100, (elapsed / totalMs) * 100);

    if (activeMeter) {
      activeMeter.style.width = `${progress}%`;
    }

    if (elapsed < totalMs && state.isPlayingSnippet) {
      state.progressAnimId = requestAnimationFrame(step);
    }
  }

  cancelAnimationFrame(state.progressAnimId);
  state.progressAnimId = requestAnimationFrame(step);
}

function resetProgressFill() {
  const activeMeter = document.querySelector("#segmented-progress-bar .timeline-slot.active .slot-meter");
  if (activeMeter) {
    activeMeter.style.width = "0%";
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
  if (state.mode === "duel-online") {
    let guessVal = "";
    if (state.selectedSuggestion) {
      guessVal = `${state.selectedSuggestion.title} ${state.selectedSuggestion.artist || ""}`;
    } else {
      guessVal = gameUI.guessInput.value.trim();
    }
    if (!guessVal) {
      showFeedback("Please type or select a song before submitting!");
      return;
    }
    submitOnlineGuess(guessVal);
    return;
  }

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

  if (state.mode === "duel-local") {
    if (state.activeBuzzer === 1) {
      state.p1.score += pointsEarned;
    } else if (state.activeBuzzer === 2) {
      state.p2.score += pointsEarned;
    } else {
      state.p1.score += pointsEarned;
    }
    updateDuelScoreboard();
  } else {
    state.totalScore += pointsEarned;
    state.currentStreak += 1;
    if (state.currentStreak > state.bestStreak) {
      state.bestStreak = state.currentStreak;
    }
  }

  state.roundsHistory.push({
    song: state.currentSong,
    won: true,
    winner: state.mode === "duel-local" ? (state.activeBuzzer === 1 ? state.p1.name : state.p2.name) : null,
    level: currentConfig.level,
    duration: currentConfig.label,
    points: pointsEarned
  });

  const slots = document.querySelectorAll("#segmented-progress-bar .timeline-slot");
  if (slots[state.currentLevelIndex]) {
    slots[state.currentLevelIndex].className = "timeline-slot passed-correct";
    const badgeIcon = slots[state.currentLevelIndex].querySelector(".slot-status-icon i");
    if (badgeIcon) badgeIcon.className = "fa-solid fa-check";
  }

  playSFX("win");
  triggerConfetti();
  showRevealModal(true, pointsEarned, currentConfig.label);
}

function handleWrongGuess() {
  playSFX("wrong");
  showFeedback(`❌ Not quite! That wasn't "${state.selectedSuggestion.title}". Try next duration!`);
  clearGuessInput();

  if (state.mode === "duel-local") {
    resetBuzzers();
  }

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
  if (state.mode === "duel-online") {
    skipOnlineRound();
    return;
  }

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
  if (state.mode === "duel-online") {
    skipOnlineRound();
    return;
  }

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

  // Record into persistent Career Stats & Song History
  recordSongHistory(won, pointsEarned, timeTaken, state.currentSong);

  if (won) {
    modalReveal.badge.className = "status-stamp win";
    modalReveal.badge.innerHTML = `<i class="fa-solid fa-trophy"></i> TRACK IDENTIFIED`;
    let heroTitle = "🎉 TRACK IDENTIFIED!";
    if (timeTaken === "0.1s") {
      heroTitle = "⚡ 0.1-SEC MADNESS! GODLIKE EAR!";
    } else if (timeTaken === "1.0s") {
      heroTitle = "🔥 1-SEC LIGHTNING GUESS!";
    }
    modalReveal.title.textContent = heroTitle;
    modalReveal.pointsEarned.textContent = `+${pointsEarned.toLocaleString()} PTS`;
  } else {
    modalReveal.badge.className = "status-stamp missed";
    modalReveal.badge.innerHTML = `<i class="fa-solid fa-xmark"></i> MISSED`;
    modalReveal.title.textContent = "BETTER LUCK NEXT TIME";
    modalReveal.pointsEarned.textContent = "0 PTS";
  }

  if (gameUI.revealedAlbumArt) {
    gameUI.revealedAlbumArt.src = state.currentSong.thumbnail;
    gameUI.revealedAlbumArt.style.display = "block";
  }
  if (gameUI.vinylMysteryIcon) {
    gameUI.vinylMysteryIcon.style.display = "none";
  }

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
  if (state.mode === "duel-online") {
    advanceOnlineRound();
    return;
  }

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
  const sub1s = state.roundsHistory.filter(r => r.won && (r.duration === "0.1s" || r.duration === "1.0s")).length;
  const accuracyPct = totalRounds > 0 ? Math.round((wins / totalRounds) * 100) : 0;

  if (state.mode === "duel-local") {
    if (duelUI.soloSummaryMatrix) duelUI.soloSummaryMatrix.style.display = "none";
    if (duelUI.duelSummaryPod) duelUI.duelSummaryPod.style.display = "block";

    let winner = "TIE MATCH!";
    if (state.p1.score > state.p2.score) {
      winner = `${state.p1.name.toUpperCase()} WINS!`;
    } else if (state.p2.score > state.p1.score) {
      winner = `${state.p2.name.toUpperCase()} WINS!`;
    }

    if (duelUI.duelWinnerName) duelUI.duelWinnerName.textContent = winner;
    if (duelUI.duelP1FinalLabel) duelUI.duelP1FinalLabel.textContent = state.p1.name.toUpperCase();
    if (duelUI.duelP1FinalScore) duelUI.duelP1FinalScore.textContent = `${state.p1.score.toLocaleString()} PTS`;
    if (duelUI.duelP2FinalLabel) duelUI.duelP2FinalLabel.textContent = state.p2.name.toUpperCase();
    if (duelUI.duelP2FinalScore) duelUI.duelP2FinalScore.textContent = `${state.p2.score.toLocaleString()} PTS`;

    const summaryHeading = document.getElementById("summary-main-heading");
    if (summaryHeading) summaryHeading.textContent = "1V1 DUEL RESULTS";
    const summarySub = document.getElementById("summary-subcaption");
    if (summarySub) summarySub.textContent = `${state.p1.name} vs ${state.p2.name}`;
  } else {
    if (duelUI.soloSummaryMatrix) duelUI.soloSummaryMatrix.style.display = "grid";
    if (duelUI.duelSummaryPod) duelUI.duelSummaryPod.style.display = "none";

    modalSummary.finalScore.textContent = state.totalScore.toLocaleString();
    modalSummary.accuracy.textContent = `${accuracyPct}%`;
    modalSummary.bestStreak.textContent = `${state.bestStreak}`;
    modalSummary.sub1sCount.textContent = `${sub1s}`;

    const summaryHeading = document.getElementById("summary-main-heading");
    if (summaryHeading) summaryHeading.textContent = "SESSION COMPLETE";
    const summarySub = document.getElementById("summary-subcaption");
    if (summarySub) summarySub.textContent = "Telemetry logged by BeatDrop Sound System";
  }

  const gridText = generateShareableGrid(wins, totalRounds);
  modalSummary.shareGrid.textContent = gridText;

  triggerConfetti();
}

function generateShareableGrid(wins, totalRounds) {
  let text = `⚡ BeatDrop // Engineered by Ritesh\n`;
  if (state.mode === "duel-local") {
    text += `⚔️ 1v1 DUEL: ${state.p1.name} (${state.p1.score} pts) vs ${state.p2.name} (${state.p2.score} pts)\n`;
  } else {
    text += `Deck: ${state.playlistTitle} [${state.platformBadge}]\n`;
    text += `Score: ${state.totalScore.toLocaleString()} pts | ${wins}/${totalRounds} Correct\n`;
    text += `Best Streak: 🔥 ${state.bestStreak}\n\n`;
  }

  state.roundsHistory.forEach((r, idx) => {
    let emoji = "⬛";
    if (r.won) {
      if (r.level === 1) emoji = "🟩";
      else if (r.level <= 3) emoji = "🟨";
      else emoji = "🟧";
    } else {
      emoji = "🟥";
    }
    const winNote = r.winner ? ` [${r.winner}]` : "";
    text += `${idx + 1}. ${emoji} (${r.duration} - ${r.points} pts)${winNote}\n`;
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
  if (state.mode === "duel-online") {
    leaveOnlineRoom(false);
    return;
  }
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
    colors: ["#10b981", "#f59e0b", "#f43f5e", "#6366f1", "#ffffff"]
  });
}

// ============================================================
// PERSISTENT SAVED DECKS & CAREER STATS LOGIC
// ============================================================

const STORAGE_KEYS = {
  RECENT_PLAYLISTS: "beatdrop_recent_playlists",
  LAST_URL: "beatdrop_last_url",
  CAREER_STATS: "beatdrop_career_stats"
};

function safeGetStorage(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.warn(`localStorage read error for ${key}:`, e);
    return fallback;
  }
}

function safeSetStorage(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch (e) {
    console.warn(`localStorage write error for ${key}:`, e);
  }
}

function initSavedDecksAndHistory() {
  try {
    const lastUrl = localStorage.getItem(STORAGE_KEYS.LAST_URL);
    if (lastUrl && setupUI.urlInput && !setupUI.urlInput.value) {
      setupUI.urlInput.value = lastUrl;
    }
  } catch (e) {}

  renderSavedPlaylists();
}

function getSavedPlaylists() {
  const list = safeGetStorage(STORAGE_KEYS.RECENT_PLAYLISTS, []);
  return Array.isArray(list) ? list : [];
}

function saveRecentPlaylist(deck) {
  if (!deck || !deck.url) return;
  try {
    localStorage.setItem(STORAGE_KEYS.LAST_URL, deck.url);
  } catch (e) {}

  let list = getSavedPlaylists();
  // Remove existing match by URL or title
  list = list.filter(item => item.url !== deck.url && item.title !== deck.title);
  // Prepend fresh deck
  list.unshift({
    url: deck.url,
    title: deck.title || "Custom Deck",
    platform: deck.platform || "youtube",
    platformBadge: deck.platformBadge || "PLAYLIST",
    trackCount: deck.trackCount || 0,
    savedAt: Date.now()
  });
  // Cap to top 6 decks
  if (list.length > 6) {
    list = list.slice(0, 6);
  }
  safeSetStorage(STORAGE_KEYS.RECENT_PLAYLISTS, list);
  renderSavedPlaylists();
}

function removeSavedPlaylist(url) {
  let list = getSavedPlaylists();
  list = list.filter(item => item.url !== url);
  safeSetStorage(STORAGE_KEYS.RECENT_PLAYLISTS, list);
  renderSavedPlaylists();
}

function clearAllSavedPlaylists() {
  if (confirm("Are you sure you want to clear all your saved playlists?")) {
    try {
      localStorage.removeItem(STORAGE_KEYS.RECENT_PLAYLISTS);
    } catch (e) {}
    renderSavedPlaylists();
  }
}

function renderSavedPlaylists() {
  if (!savedDecksUI.section || !savedDecksUI.container) return;
  const list = getSavedPlaylists();

  if (list.length === 0) {
    savedDecksUI.section.style.display = "none";
    savedDecksUI.container.innerHTML = "";
    return;
  }

  savedDecksUI.section.style.display = "block";
  savedDecksUI.container.innerHTML = "";

  list.forEach(deck => {
    const card = document.createElement("div");
    card.className = "recent-deck-card";

    let iconHtml = '<i class="fa-brands fa-youtube"></i> YOUTUBE';
    let pClass = "youtube";
    if (deck.platform === "spotify") {
      iconHtml = '<i class="fa-brands fa-spotify"></i> SPOTIFY';
      pClass = "spotify";
    } else if (deck.platform === "apple") {
      iconHtml = '<i class="fa-brands fa-apple"></i> APPLE MUSIC';
      pClass = "apple";
    }

    card.innerHTML = `
      <div class="recent-card-top">
        <span class="recent-platform-badge ${pClass}">${iconHtml}</span>
        <button class="recent-delete-btn" title="Remove deck from saved list">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
      <div class="recent-title" title="${escapeHtml(deck.title)}">${escapeHtml(deck.title)}</div>
      <div class="recent-card-footer">
        <span class="recent-track-count">${deck.trackCount} TRACKS</span>
        <button class="btn-launch-recent">
          <i class="fa-solid fa-play"></i> <span>PLAY DECK</span>
        </button>
      </div>
    `;

    // Launch handlers
    const launchBtn = card.querySelector(".btn-launch-recent");
    const launchHandler = (e) => {
      e.stopPropagation();
      setupUI.urlInput.value = deck.url;
      handleLoadPlaylist();
    };
    if (launchBtn) launchBtn.addEventListener("click", launchHandler);
    card.addEventListener("click", (e) => {
      if (!e.target.closest(".recent-delete-btn")) {
        launchHandler(e);
      }
    });

    // Delete button
    const delBtn = card.querySelector(".recent-delete-btn");
    if (delBtn) {
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeSavedPlaylist(deck.url);
      });
    }

    savedDecksUI.container.appendChild(card);
  });
}

// ------------------------------------------------------------
// CAREER TELEMETRY & PLAYED TRACK LOG
// ------------------------------------------------------------

function getCareerStats() {
  const fallback = {
    totalScore: 0,
    songsAttempted: 0,
    songsIdentified: 0,
    bestStreak: 0,
    madness01s: 0,
    history: []
  };
  const stats = safeGetStorage(STORAGE_KEYS.CAREER_STATS, fallback);
  return {
    totalScore: stats.totalScore || 0,
    songsAttempted: stats.songsAttempted || 0,
    songsIdentified: stats.songsIdentified || 0,
    bestStreak: stats.bestStreak || 0,
    madness01s: stats.madness01s || 0,
    history: Array.isArray(stats.history) ? stats.history : []
  };
}

function recordSongHistory(won, pointsEarned, durationLabel, songData) {
  const stats = getCareerStats();
  const track = songData || state.currentSong;

  stats.songsAttempted += 1;
  if (won) {
    stats.totalScore += (pointsEarned || 0);
    stats.songsIdentified += 1;
    if (durationLabel === "0.1s") {
      stats.madness01s += 1;
    }
    stats.bestStreak = Math.max(stats.bestStreak || 0, state.currentStreak || 0);
  }

  const historyEntry = {
    title: (track && track.title) ? track.title : "Mystery Song",
    artist: (track && track.artist) ? track.artist : "Mystery Artist",
    thumbnail: (track && track.thumbnail) ? track.thumbnail : "",
    won: !!won,
    duration: durationLabel || (won ? "Win" : "Missed"),
    points: pointsEarned || 0,
    timestamp: Date.now()
  };

  stats.history.unshift(historyEntry);
  if (stats.history.length > 50) {
    stats.history = stats.history.slice(0, 50);
  }

  safeSetStorage(STORAGE_KEYS.CAREER_STATS, stats);
}

function openCareerHistoryModal() {
  renderCareerStatsModal();
  if (modalHistory.overlay) {
    modalHistory.overlay.style.display = "flex";
  }
}

function closeCareerHistoryModal() {
  if (modalHistory.overlay) {
    modalHistory.overlay.style.display = "none";
  }
}

function clearCareerHistory() {
  if (confirm("Reset all career stats and clear played track history?")) {
    const blank = {
      totalScore: 0,
      songsAttempted: 0,
      songsIdentified: 0,
      bestStreak: 0,
      madness01s: 0,
      history: []
    };
    safeSetStorage(STORAGE_KEYS.CAREER_STATS, blank);
    renderCareerStatsModal();
  }
}

function renderCareerStatsModal() {
  const stats = getCareerStats();
  if (modalHistory.totalScore) {
    modalHistory.totalScore.textContent = stats.totalScore.toLocaleString();
  }
  if (modalHistory.accuracy) {
    const pct = stats.songsAttempted > 0
      ? Math.round((stats.songsIdentified / stats.songsAttempted) * 100)
      : 0;
    modalHistory.accuracy.textContent = `${pct}%`;
  }
  if (modalHistory.bestStreak) {
    modalHistory.bestStreak.textContent = stats.bestStreak;
  }
  if (modalHistory.madnessCount) {
    modalHistory.madnessCount.textContent = stats.madness01s;
  }

  if (modalHistory.historyList) {
    if (stats.history.length === 0) {
      modalHistory.historyList.innerHTML = `
        <div class="history-empty-note">
          <i class="fa-solid fa-compact-disc fa-spin" style="margin-right: 6px;"></i>
          No tracks recorded yet. Play a round to start your career log!
        </div>
      `;
      return;
    }

    modalHistory.historyList.innerHTML = stats.history.map(item => {
      const fallbackSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'><rect width='40' height='40' fill='%2312151e'/><text x='20' y='25' fill='%23666' font-size='14' text-anchor='middle'>♫</text></svg>";
      const thumb = item.thumbnail || fallbackSvg;
      const resultClass = item.won ? "won" : "missed";
      const resultText = item.won ? (item.duration ? item.duration : "WIN") : "MISSED";
      const ptsText = item.won ? `+${(item.points || 0).toLocaleString()} PTS` : "0 PTS";

      return `
        <div class="history-row-card">
          <div class="history-row-left">
            <img class="history-thumb" src="${escapeHtml(thumb)}" alt="Art" onerror="this.src='${fallbackSvg}'"/>
            <div class="history-meta">
              <span class="history-song-name" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
              <span class="history-artist-name" title="${escapeHtml(item.artist)}">${escapeHtml(item.artist)}</span>
            </div>
          </div>
          <div class="history-row-right">
            <span class="history-pill-result ${resultClass}">${resultText}</span>
            <span class="history-points-badge">${ptsText}</span>
          </div>
        </div>
      `;
    }).join("");
  }
}
