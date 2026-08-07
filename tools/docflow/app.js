// ── API base ──
const API = '';

// ── Audio ──
let helpAudio = null;
let audioUnlocked = false;

function initAudio() {
  if (!helpAudio) {
    helpAudio = new Audio('/READ.mp3');
    helpAudio.loop = true;
    helpAudio.preload = 'auto';
    helpAudio.load();
    
    // 添加错误处理
    helpAudio.addEventListener('error', (e) => {
      console.log('音频加载失败:', e);
    });
  }
}

async function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;

  // 创建一个空的音频上下文来解锁音频
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (AudioContext) {
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }

  // 尝试播放并立即暂停来解锁
  if (helpAudio) {
    try {
      await helpAudio.play();
      helpAudio.pause();
      helpAudio.currentTime = 0;
    } catch (e) {
      // 忽略错误，继续尝试
    }
  }
}

// 页面加载时初始化音频
document.addEventListener('DOMContentLoaded', initAudio);

// 首次用户交互时解锁音频
document.addEventListener('click', unlockAudio, { once: true });
document.addEventListener('touchstart', unlockAudio, { once: true });

// ── Music Player ──
const musicPlayer = {
  audio: null,
  tracks: [],
  currentIndex: -1,
  mode: 'loop',         // 'loop' | 'shuffle' | 'single'
  isPlaying: false,
  isExpanded: false,
  shuffleOrder: [],
  shufflePos: 0,
  _saveTimer: null,
  _userIntendedPlay: false,
  _initialized: false,
};

function initMusicPlayer() {
  // Restore saved state
  const savedMode = localStorage.getItem('docflow_music_mode');
  if (savedMode && ['loop', 'shuffle', 'single'].includes(savedMode)) {
    musicPlayer.mode = savedMode;
  }
  musicPlayer._userIntendedPlay = localStorage.getItem('docflow_music_playing') === 'true';
  musicPlayer._initialized = true;

  // Create audio element
  const audio = new Audio();
  audio.preload = 'auto';
  musicPlayer.audio = audio;

  // Apply music enabled state on startup
  applyMusicEnabled(localStorage.getItem('docflow_music_enabled') !== 'false');

  audio.addEventListener('timeupdate', () => {
    if (musicPlayer._seeking) return;
    const fill = document.getElementById('musicProgressFill');
    const timeEl = document.getElementById('musicTime');
    if (fill && audio.duration) {
      fill.style.width = (audio.currentTime / audio.duration * 100) + '%';
    }
    if (timeEl) {
      timeEl.textContent = formatTime(audio.currentTime);
    }
    // Debounced position save
    clearTimeout(musicPlayer._saveTimer);
    musicPlayer._saveTimer = setTimeout(() => {
      localStorage.setItem('docflow_music_position', audio.currentTime);
    }, 2000);
  });

  audio.addEventListener('loadedmetadata', () => {
    const timeEl = document.getElementById('musicTime');
    if (timeEl) timeEl.textContent = formatTime(audio.currentTime);
  });

  audio.addEventListener('ended', () => {
    if (musicPlayer.mode === 'single') {
      audio.currentTime = 0;
      audio.play();
    } else {
      nextTrack();
    }
  });

  audio.addEventListener('play', () => {
    musicPlayer.isPlaying = true;
    updatePlayPauseIcon();
    musicPlayer._userIntendedPlay = true;
    localStorage.setItem('docflow_music_playing', 'true');
    document.getElementById('musicPlayer')?.classList.add('playing');
  });

  audio.addEventListener('pause', () => {
    musicPlayer.isPlaying = false;
    updatePlayPauseIcon();
    document.getElementById('musicPlayer')?.classList.remove('playing');
  });

  // Save state immediately before unload (debounced saves may not fire in time)
  const saveMusicState = () => {
    if (!musicPlayer._initialized) return;
    localStorage.setItem('docflow_music_playing', musicPlayer._userIntendedPlay ? 'true' : 'false');
    if (musicPlayer.audio && musicPlayer.currentIndex >= 0) {
      clearTimeout(musicPlayer._saveTimer);
      localStorage.setItem('docflow_music_position', musicPlayer.audio.currentTime);
    }
  };
  window.addEventListener('beforeunload', saveMusicState);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveMusicState();
  });

  // Bind controls
  document.getElementById('musicPlayPause')?.addEventListener('click', togglePlayPause);
  document.getElementById('musicNext')?.addEventListener('click', nextTrack);
  document.getElementById('musicPrev')?.addEventListener('click', prevTrack);
  document.getElementById('musicModeBtn')?.addEventListener('click', cycleMode);
  document.getElementById('musicExpand')?.addEventListener('click', togglePlaylist);

  // Progress bar seeking
  const progressWrap = document.getElementById('musicProgressWrap');
  if (progressWrap) {
    progressWrap.addEventListener('mousedown', (e) => {
      musicPlayer._seeking = true;
      seekTo(e);
      const onMove = (ev) => seekTo(ev);
      const onUp = () => {
        musicPlayer._seeking = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // Click to toggle mini player
  const playerEl = document.getElementById('musicPlayer');
  if (playerEl) {
    document.getElementById('musicToggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMiniPlayer();
    });
    // Click outside to close mini player
    document.addEventListener('mousedown', (e) => {
      if (playerEl.classList.contains('show-mini') && !playerEl.contains(e.target)) {
        hideMiniPlayer();
      }
    });
  }

  // Click outside to close playlist
  document.addEventListener('mousedown', (e) => {
    const playerEl = document.getElementById('musicPlayer');
    if (playerEl && musicPlayer.isExpanded && !playerEl.contains(e.target)) {
      togglePlaylist();
    }
  });

  // Fetch tracks
  fetch('/api/music/list')
    .then(r => r.json())
    .then(data => {
      musicPlayer.tracks = data.tracks || [];
      renderPlaylist();
      updateModeIcon();

      // Restore track
      const savedTrack = parseInt(localStorage.getItem('docflow_music_track'));
      if (savedTrack >= 0 && savedTrack < musicPlayer.tracks.length) {
        musicPlayer.currentIndex = savedTrack;
        updateTrackName();
        // Restore position after metadata loads
        const savedPos = parseFloat(localStorage.getItem('docflow_music_position'));
        if (savedPos > 0) {
          audio.addEventListener('loadedmetadata', function restore() {
            audio.currentTime = Math.min(savedPos, audio.duration || 0);
            audio.removeEventListener('loadedmetadata', restore);
          });
        }
        // Set source (restore track + position, but do not auto-play)
        audio.src = '/music/' + encodeURIComponent(musicPlayer.tracks[savedTrack].file);
      }
    })
    .catch(() => {});
}

function toggleMiniPlayer() {
  const playerEl = document.getElementById('musicPlayer');
  if (!playerEl) return;
  if (playerEl.classList.contains('show-mini')) {
    hideMiniPlayer();
  } else {
    if (musicPlayer.tracks.length === 0) return;
    if (musicPlayer.currentIndex < 0) playTrack(0);
    playerEl.classList.remove('hiding');
    playerEl.classList.add('show-mini');
  }
}

function hideMiniPlayer() {
  const playerEl = document.getElementById('musicPlayer');
  if (!playerEl || !playerEl.classList.contains('show-mini')) return;
  const mini = document.getElementById('musicMini');
  const playlist = document.getElementById('musicPlaylist');

  const startMiniExit = () => {
    playerEl.classList.remove('show-mini');
    playerEl.classList.add('hiding');
    if (mini) {
      const onEnd = () => {
        mini.removeEventListener('animationend', onEnd);
        playerEl.classList.remove('hiding');
      };
      mini.addEventListener('animationend', onEnd);
    } else {
      playerEl.classList.remove('hiding');
    }
  };

  // If playlist is open, wait for its collapse animation before removing show-mini
  if (musicPlayer.isExpanded && playlist) {
    togglePlaylist();
    const onCollapse = (e) => {
      if (e.propertyName === 'max-height') {
        playlist.removeEventListener('transitionend', onCollapse);
        startMiniExit();
      }
    };
    playlist.addEventListener('transitionend', onCollapse);
  } else {
    startMiniExit();
  }
}

function playTrack(index) {
  if (localStorage.getItem('docflow_music_enabled') === 'false') return;
  if (index < 0 || index >= musicPlayer.tracks.length) return;
  musicPlayer.currentIndex = index;
  const track = musicPlayer.tracks[index];
  musicPlayer.audio.src = '/music/' + encodeURIComponent(track.file);
  musicPlayer.audio.play().catch(() => {});
  localStorage.setItem('docflow_music_track', index);
  localStorage.setItem('docflow_music_position', '0');
  updateTrackName();
  renderPlaylist();
  const playerEl = document.getElementById('musicPlayer');
  if (playerEl) {
    playerEl.classList.remove('hiding');
    playerEl.classList.add('show-mini');
  }
}

function applyMusicEnabled(enabled) {
  const playerEl = document.getElementById('musicPlayer');
  if (enabled) {
    playerEl?.classList.remove('music-disabled');
  } else {
    playerEl?.classList.add('music-disabled');
    // Pause and collapse if playing
    if (musicPlayer.audio && !musicPlayer.audio.paused) {
      musicPlayer._userIntendedPlay = false;
      musicPlayer.audio.pause();
    }
    if (musicPlayer.isExpanded) togglePlaylist();
  }
}

function togglePlayPause() {
  if (localStorage.getItem('docflow_music_enabled') === 'false') return;
  if (musicPlayer.currentIndex < 0) {
    if (musicPlayer.tracks.length > 0) playTrack(0);
    return;
  }
  if (musicPlayer.audio.paused) {
    musicPlayer.audio.play().catch(() => {});
  } else {
    musicPlayer._userIntendedPlay = false;
    musicPlayer.audio.pause();
  }
}

function nextTrack() {
  if (musicPlayer.tracks.length === 0) return;
  let next;
  if (musicPlayer.mode === 'shuffle') {
    if (musicPlayer.shuffleOrder.length === 0) {
      shuffleArray(musicPlayer.tracks.length);
    }
    musicPlayer.shufflePos = (musicPlayer.shufflePos + 1) % musicPlayer.shuffleOrder.length;
    next = musicPlayer.shuffleOrder[musicPlayer.shufflePos];
  } else {
    next = (musicPlayer.currentIndex + 1) % musicPlayer.tracks.length;
  }
  playTrack(next);
}

function prevTrack() {
  if (musicPlayer.tracks.length === 0) return;
  if (musicPlayer.audio.currentTime > 3) {
    musicPlayer.audio.currentTime = 0;
    return;
  }
  let prev;
  if (musicPlayer.mode === 'shuffle') {
    musicPlayer.shufflePos = (musicPlayer.shufflePos - 1 + musicPlayer.shuffleOrder.length) % musicPlayer.shuffleOrder.length;
    prev = musicPlayer.shuffleOrder[musicPlayer.shufflePos];
  } else {
    prev = (musicPlayer.currentIndex - 1 + musicPlayer.tracks.length) % musicPlayer.tracks.length;
  }
  playTrack(prev);
}

function cycleMode() {
  const modes = ['loop', 'shuffle', 'single'];
  const modeNames = { loop: '列表循环', shuffle: '随机播放', single: '单曲循环' };
  const idx = modes.indexOf(musicPlayer.mode);
  musicPlayer.mode = modes[(idx + 1) % modes.length];
  localStorage.setItem('docflow_music_mode', musicPlayer.mode);
  updateModeIcon();
  if (musicPlayer.mode === 'shuffle') {
    shuffleArray(musicPlayer.tracks.length);
    musicPlayer.shufflePos = 0;
  }
  // Update tooltip
  const btn = document.getElementById('musicModeBtn');
  if (btn) btn.title = modeNames[musicPlayer.mode];
}

function updateModeIcon() {
  const playerEl = document.getElementById('musicPlayer');
  if (playerEl) playerEl.setAttribute('data-mode', musicPlayer.mode);
}

function togglePlaylist() {
  const playerEl = document.getElementById('musicPlayer');
  if (!playerEl) return;
  musicPlayer.isExpanded = !musicPlayer.isExpanded;
  playerEl.classList.toggle('open', musicPlayer.isExpanded);
  if (musicPlayer.isExpanded) {
    playerEl.classList.remove('hiding');
    playerEl.classList.add('show-mini');
  }
}

function updatePlayPauseIcon() {
  const playIcon = document.querySelector('#musicPlayPause .music-play-icon');
  const pauseIcon = document.querySelector('#musicPlayPause .music-pause-icon');
  if (playIcon) playIcon.style.display = musicPlayer.isPlaying ? 'none' : 'block';
  if (pauseIcon) pauseIcon.style.display = musicPlayer.isPlaying ? 'block' : 'none';
}

function updateTrackName() {
  const nameEl = document.getElementById('musicTrackName');
  if (nameEl && musicPlayer.currentIndex >= 0) {
    nameEl.textContent = musicPlayer.tracks[musicPlayer.currentIndex]?.name || '';
  }
}

function seekTo(e) {
  const wrap = document.getElementById('musicProgressWrap');
  if (!wrap || !musicPlayer.audio.duration) return;
  const rect = wrap.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  musicPlayer.audio.currentTime = ratio * musicPlayer.audio.duration;
  const fill = document.getElementById('musicProgressFill');
  if (fill) fill.style.width = (ratio * 100) + '%';
}

function renderPlaylist() {
  const list = document.getElementById('musicPlaylistList');
  const countEl = document.getElementById('musicPlaylistCount');
  if (!list) return;
  if (countEl) countEl.textContent = musicPlayer.tracks.length + ' 首';
  if (musicPlayer.tracks.length === 0) {
    list.innerHTML = '<div class="music-playlist-empty">将音乐文件放入 music/ 目录</div>';
    return;
  }
  list.innerHTML = musicPlayer.tracks.map((t, i) => {
    const playing = i === musicPlayer.currentIndex;
    return `<div class="music-track-item${playing ? ' playing' : ''}" data-index="${i}">
      <span class="music-track-num">${playing ? '&#9654;' : (i + 1)}</span>
      <span class="music-track-name-pl">${t.name}</span>
      <div class="music-track-eq"><span></span><span></span><span></span><span></span><span></span></div>
    </div>`;
  }).join('');

  list.querySelectorAll('.music-track-item').forEach(item => {
    item.addEventListener('click', () => {
      playTrack(parseInt(item.dataset.index));
    });
  });
}

function formatTime(s) {
  if (!s || !isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

function shuffleArray(n) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  musicPlayer.shuffleOrder = arr;
}

// ── State ──
const state = {
  queues: { doc_to_pdf: [], pdf_to_docx: [], to_markdown: [] },  // per-mode queues
  history: [],
  selectedFile: null,
  nextId: 1,
  polling: {}      // jobId -> intervalId
};
function getQueue() { return state.queues[currentMode] || (state.queues[currentMode] = []); }
const animatedDoneIds = new Set(); // track items that already played completion animation
const renderedHistoryIds = new Set(); // track history items already rendered (skip re-animation)
let lastHistoryPageHash = ''; // track last rendered history data to avoid unnecessary re-renders

// ── History Stack State ──
let historyStackEnabled = true;
let expandedStacks = new Set(); // Track expanded stack IDs
const BATCH_TIME_WINDOW = 5 * 60 * 1000; // 5 minutes in milliseconds
const stackNames = new Map(); // Custom names for collapsed stacks (stackId → name)

// ── Manual Grouping State ──
const manualGroups = new Map();   // groupId → Set<itemId>
const groupNames = new Map();     // groupId → display name
let groupCounter = 0;
let draggedItemId = null;

function assignGroupId(itemIds) {
  const gid = `manual-${++groupCounter}`;
  const members = new Set(itemIds);
  manualGroups.set(gid, members);
  const firstItem = state.history.find(h => h.id === itemIds[0]);
  const defaultName = firstItem ? firstItem.name.split('.')[0] : `分组 ${groupCounter}`;
  groupNames.set(gid, defaultName);
  itemIds.forEach(id => {
    const item = state.history.find(h => h.id === id);
    if (item) item.groupId = gid;
  });
  return gid;
}

function removeFromGroup(itemId) {
  const item = state.history.find(h => h.id === itemId);
  if (!item || !item.groupId) return;
  const gid = item.groupId;
  const members = manualGroups.get(gid);
  if (members) {
    members.delete(itemId);
    if (members.size < 2) {
      // Dissolve group
      members.forEach(id => {
        const m = state.history.find(h => h.id === id);
        if (m) delete m.groupId;
      });
      manualGroups.delete(gid);
      groupNames.delete(gid);
    }
  }
  delete item.groupId;
}

function getGroupName(groupId) {
  if (!groupId) return '';
  return groupNames.get(groupId) || `手动分组 ${groupCounter}`;
}

function matchesSearch(item, query) {
  const q = query.toLowerCase();
  if (item.name.toLowerCase().includes(q)) return true;
  if (item.groupId) {
    const gName = getGroupName(item.groupId);
    if (gName.toLowerCase().includes(q)) return true;
  }
  return false;
}

// ── Mode System ──
let currentMode = 'doc_to_pdf';

const MODE_THEMES = {
  doc_to_pdf: {
    accent: 'oklch(52% 0.08 240)',
    accentLight: 'oklch(93% 0.02 240)',
    accentHover: 'oklch(46% 0.10 240)',
    accentShadow: 'oklch(52% 0.08 240 / 0.08)',
    accentBorder: 'oklch(82% 0.04 240 / 0.3)',
    uploadTitle: '拖放 DOC/DOCX 文件到此处',
    uploadSubtitle: '转换为 PDF — 支持批量转换',
    uploadFormats: ['.doc', '.docx'],
    acceptExts: '.doc,.docx',
  },
  pdf_to_docx: {
    accent: 'oklch(50% 0.10 35)',
    accentLight: 'oklch(93% 0.025 35)',
    accentHover: 'oklch(44% 0.12 35)',
    accentShadow: 'oklch(50% 0.10 35 / 0.08)',
    accentBorder: 'oklch(82% 0.04 35 / 0.3)',
    uploadTitle: '拖放 PDF 文件到此处',
    uploadSubtitle: '转换为 DOCX — 支持批量转换',
    uploadFormats: ['.pdf'],
    acceptExts: '.pdf',
  },
  to_markdown: {
    accent: 'oklch(55% 0.12 150)',
    accentLight: 'oklch(94% 0.02 150)',
    accentHover: 'oklch(48% 0.14 150)',
    accentShadow: 'oklch(55% 0.12 150 / 0.08)',
    accentBorder: 'oklch(82% 0.04 150 / 0.3)',
    uploadTitle: '拖放 PDF/DOC/DOCX 文件到此处',
    uploadSubtitle: '转换为 Markdown — 支持图片提取',
    uploadFormats: ['.pdf', '.doc', '.docx'],
    acceptExts: '.pdf,.doc,.docx',
  }
};

function switchMode(mode) {
  if (mode === currentMode) return;
  currentMode = mode;
  const theme = MODE_THEMES[mode];

  // Update CSS variables (theme color)
  document.documentElement.style.setProperty('--accent', theme.accent);
  document.documentElement.style.setProperty('--accent-light', theme.accentLight);
  document.documentElement.style.setProperty('--accent-hover', theme.accentHover);
  document.documentElement.style.setProperty('--accent-shadow', theme.accentShadow);
  document.documentElement.style.setProperty('--accent-border', theme.accentBorder);

  // Update switcher UI
  const switcher = document.getElementById('modeSwitcher');
  switcher.dataset.mode = mode;
  switcher.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  // Update upload zone
  updateUploadZone();

  // Update file input accept
  document.getElementById('fileInput').accept = theme.acceptExts;

  // Render mode-specific settings
  renderSettingsPanel();
  _applyPanelSettings();
  _bindSettingsListeners();

  // Don't stop old mode's polling — callbacks use item.mode to target correct queue
  animatedDoneIds.clear();
  updateView();
  renderedHistoryIds.clear();
  expandedStacks.clear();
  lastHistoryPageHash = '';

  // Single animation: fade-out → swap content at midpoint → fade-in
  const historyList = document.getElementById('historyList');
  const historyPageList = document.getElementById('historyPageList');
  [historyList, historyPageList].forEach(el => {
    if (!el) return;
    el.classList.remove('mode-history-swap');
    void el.offsetWidth;
    el.classList.add('mode-history-swap');
    el.addEventListener('animationend', () => el.classList.remove('mode-history-swap'), { once: true });
  });
  setTimeout(() => {
    [historyList, historyPageList].forEach(el => {
      if (el) el.innerHTML = '';
    });
    fetchHistory({ skipRender: true }).then(() => {
      renderHistory(document.getElementById('historySearch').value);
      if (currentView === 'history') renderHistoryPage();
    });
  }, 175);

  // Sync new mode's queue with backend active jobs
  fetch(`${API}/api/active-jobs?type=${mode}`).then(r => r.json()).then(data => {
    const activeJobs = data.jobs || [];
    const activeJobIds = new Set(activeJobs.map(j => j.id));
    const queue = getQueue();

    // Remove items from queue that are no longer active on backend
    queue = queue.filter(f => !f.jobId || activeJobIds.has(f.jobId));

    // Add new active jobs not yet in queue
    activeJobs.forEach(job => {
      if (queue.some(f => f.jobId === job.id)) return;
      queue.push({
        id: state.nextId++,
        jobId: job.id,
        name: job.name,
        size: job.sizeFormatted,
        rawSize: job.size,
        status: job.status,
        progress: job.progress || 0,
        pages: 0, pdfSize: 0, docxSize: 0,
        mode: currentMode,
        conversionType: job.conversionType
      });
    });
    state.queues[currentMode] = queue;

    // Restart polling for all pending/processing items in queue
    queue.filter(f => f.status === 'pending' || f.status === 'processing').forEach(f => {
      if (!state.polling[f.jobId]) startPolling(f);
    });

    updateView();
    updateStats();
    if (currentView !== 'convert' && queue.some(f => f.status === 'processing')) switchView('convert');
  }).catch(() => {});
}

function updateUploadZone() {
  const theme = MODE_THEMES[currentMode];
  const title = document.querySelector('.upload-title');
  const subtitle = document.querySelector('.upload-subtitle');
  const formats = document.getElementById('uploadFormats');

  // Crossfade: fade out, update, fade in
  [title, subtitle, formats].forEach(el => {
    if (el) { el.style.transition = 'opacity 0.2s, transform 0.2s'; el.style.opacity = '0'; el.style.transform = 'translateY(4px)'; }
  });
  setTimeout(() => {
    if (title) title.textContent = theme.uploadTitle;
    if (subtitle) subtitle.textContent = theme.uploadSubtitle;
    [title, subtitle].forEach(el => {
      if (el) { el.style.transition = 'opacity 0.3s var(--ease-out-expo), transform 0.3s var(--ease-out-expo)'; el.style.opacity = '1'; el.style.transform = 'translateY(0)'; }
    });
  }, 200);
}

const SETTINGS_CONFIG = {
  doc_to_pdf: [
    {
      title: '输出',
      settings: [
        { key: 'pdfVersion', label: 'PDF 版本', desc: '兼容性级别', type: 'select', options: ['1.7', '1.6', '1.5'] },
        { key: 'pageSize', label: '页面大小', desc: '输出纸张大小', type: 'select', options: ['A4', 'Letter', 'Legal'] },
        { key: 'orientation', label: '方向', type: 'select', options: ['纵向', '横向'] },
      ]
    },
    {
      title: '质量',
      settings: [
        { key: 'imageDpi', label: '图片 DPI', desc: '图片分辨率，600=无损印刷级', type: 'select', options: ['600', '300', '150', '72'] },
        { key: 'embedFonts', label: '嵌入字体', desc: '保留排版样式', type: 'toggle', default: true },
        { key: 'losslessImages', label: '无损图片', desc: '禁用图片压缩，保留原始精度', type: 'toggle', default: false },
      ]
    },
    {
      title: '安全',
      settings: [
        { key: 'passwordProtect', label: '密码保护', desc: '打开时需要密码', type: 'toggle', default: false },
        { key: 'allowPrinting', label: '允许打印', type: 'toggle', default: true },
        { key: 'allowCopying', label: '允许复制', type: 'toggle', default: true },
      ]
    },
    {
      title: '转换后',
      settings: [
        { key: 'autoDownload', label: '自动下载', desc: '完成后自动下载 PDF', type: 'toggle', default: true },
        { key: 'keepHistory', label: '保留历史', desc: '保存转换记录', type: 'toggle', default: true },
      ]
    },
  ],
  pdf_to_docx: [
    {
      title: '布局',
      settings: [
        { key: 'tableMode', label: '表格识别', desc: '严格=网格+无框表格+边框容差放大 | 自动=网格+无框 | 宽松=仅明确边框', type: 'select', options: ['自动', '严格', '宽松'] },
        { key: 'ignoreEdges', label: '忽略页眉页脚', desc: '不转换页眉页脚区域', type: 'toggle', default: false },
      ]
    },
    {
      title: '内容',
      settings: [
        { key: 'ocrEnabled', label: 'OCR 识别', desc: '智能识别扫描页面并转换为可编辑文字（内置 RapidOCR 引擎，中文识别优秀）', type: 'toggle', default: true },
        { key: 'imageDpi', label: '图片质量', desc: '提取图片的分辨率', type: 'select', options: ['300', '150', '72'] },
        { key: 'extractImages', label: '提取图片', desc: '保留文档中的图片', type: 'toggle', default: true },
        { key: 'keepStyle', label: '保留样式', desc: '尽量保持原始排版', type: 'toggle', default: true },
      ]
    },
    {
      title: '转换后',
      settings: [
        { key: 'autoDownload', label: '自动下载', desc: '完成后自动下载 DOCX', type: 'toggle', default: true },
        { key: 'keepHistory', label: '保留历史', desc: '保存转换记录', type: 'toggle', default: true },
      ]
    },
  ],
  to_markdown: [
    {
      title: '输出', _docToPdfOnly: true,
      settings: [
        { key: 'pdfVersion', label: 'PDF 版本', desc: '兼容性级别', type: 'select', options: ['1.7', '1.6', '1.5'] },
        { key: 'pageSize', label: '页面大小', desc: '输出纸张大小', type: 'select', options: ['A4', 'Letter', 'Legal'] },
        { key: 'orientation', label: '方向', type: 'select', options: ['纵向', '横向'] },
      ]
    },
    {
      title: '质量', _docToPdfOnly: true,
      settings: [
        { key: 'imageDpi', label: '图片 DPI', desc: '图片分辨率，600=无损印刷级', type: 'select', options: ['600', '300', '150', '72'] },
        { key: 'embedFonts', label: '嵌入字体', desc: '保留排版样式', type: 'toggle', default: true },
        { key: 'losslessImages', label: '无损图片', desc: '禁用图片压缩，保留原始精度', type: 'toggle', default: false },
      ]
    },
    {
      title: '安全', _docToPdfOnly: true,
      settings: [
        { key: 'passwordProtect', label: '密码保护', desc: '打开时需要密码', type: 'toggle', default: false },
        { key: 'allowPrinting', label: '允许打印', type: 'toggle', default: true },
        { key: 'allowCopying', label: '允许复制', type: 'toggle', default: true },
      ]
    },
    {
      title: '内容',
      settings: [
        { key: 'ocrEnabled', label: 'OCR 识别', desc: '智能识别扫描页面并转换为可编辑文字', type: 'toggle', default: true },
        { key: 'extractImages', label: '提取图片', desc: '提取文档中的图片并保存到同级目录', type: 'toggle', default: true },
      ]
    },
    {
      title: '转换后',
      settings: [
        { key: 'autoDownload', label: '自动下载', desc: '完成后自动下载 Markdown', type: 'toggle', default: true },
        { key: 'keepHistory', label: '保留历史', desc: '保存转换记录', type: 'toggle', default: true },
      ]
    },
  ],
};

// ── Presets ──
const PRESETS_STORAGE_KEY = 'docflow_presets';
const PANEL_SETTINGS_KEY = 'docflow_panel_settings';
const ACTIVE_PRESET_KEY = 'docflow_active_preset';

function _saveActivePreset(name) {
  const all = JSON.parse(localStorage.getItem(ACTIVE_PRESET_KEY) || '{}');
  if (name) { all[currentMode] = name; } else { delete all[currentMode]; }
  localStorage.setItem(ACTIVE_PRESET_KEY, JSON.stringify(all));
}
function _getActivePreset() {
  const all = JSON.parse(localStorage.getItem(ACTIVE_PRESET_KEY) || '{}');
  return all[currentMode] || null;
}

function _savePanelSettings() {
  const settings = getSettings();
  if (!settings || Object.keys(settings).length === 0) return;
  const all = JSON.parse(localStorage.getItem(PANEL_SETTINGS_KEY) || '{}');
  // Preserve _syncedBase metadata from previous save (getSettings reads DOM only)
  if (all[currentMode] && all[currentMode]._syncedBase) {
    settings._syncedBase = all[currentMode]._syncedBase;
  }
  all[currentMode] = settings;
  localStorage.setItem(PANEL_SETTINGS_KEY, JSON.stringify(all));
}

// Flag to distinguish programmatic applySettings from user edits
let _isApplyingSettings = false;

function _applyPanelSettings() {
  const all = JSON.parse(localStorage.getItem(PANEL_SETTINGS_KEY) || '{}');
  let saved = all[currentMode];
  if (saved && Object.keys(saved).length > 0) {
    // For to_markdown: resolve inherited settings from live base presets
    if (currentMode === 'to_markdown') {
      // Determine base preset name: active preset > syncedBase > key matching
      let baseName = null;
      const activeName = _getActivePreset();
      if (activeName) {
        const raw = (_getPresetsForMode('to_markdown'))[activeName];
        if (raw && raw._basePreset) baseName = raw._basePreset;
      }
      if (!baseName && saved._syncedBase && saved._syncedBase.basePreset) {
        baseName = saved._syncedBase.basePreset;
      }
      // Apply live base values — only for keys not manually edited by user
      if (baseName) {
        const base = (_getPresetsForMode('doc_to_pdf'))[baseName];
        if (base) {
          const edited = (saved._syncedBase && saved._syncedBase.userEdited) || {};
          const resolved = { ...saved };
          _DOC_TO_PDF_SETTING_KEYS.forEach(k => {
            if (base[k] === undefined) return;
            if (edited[k]) return; // User manually edited this key — don't override
            resolved[k] = base[k];
          });
          if (saved._syncedBase) resolved._syncedBase = saved._syncedBase;
          saved = resolved;
        }
      }
    }
    _isApplyingSettings = true;
    applySettings(saved);
    _isApplyingSettings = false;
  }
}

function _loadAllPresets() {
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Guard: if stored data is corrupted (e.g. arrays), reset to empty
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch { return {}; }
}
function _getPresetsForMode(mode) {
  const all = _loadAllPresets();
  const modePresets = all[mode];
  // Guard: if mode value is corrupted (e.g. array), ignore it
  if (modePresets && typeof modePresets === 'object' && !Array.isArray(modePresets)) {
    return modePresets;
  }
  return {};
}
function _savePresetsForMode(mode, presets) {
  const all = _loadAllPresets();
  all[mode] = presets;
  localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(all));
}
function _savePreset(mode, name, settings, basePreset) {
  const presets = _getPresetsForMode(mode);
  const entry = { ...settings };
  if (basePreset) entry._basePreset = basePreset;
  presets[name] = entry;
  _savePresetsForMode(mode, presets);
}
function _resolvePreset(preset) {
  if (!preset || !preset._basePreset) return preset;
  const docPresets = _getPresetsForMode('doc_to_pdf');
  const base = docPresets[preset._basePreset];
  if (!base) return preset;
  const resolved = { ...base };
  Object.keys(preset).forEach(k => {
    if (k === '_basePreset') return;
    resolved[k] = preset[k];
  });
  return resolved;
}
function _deletePreset(mode, name) {
  const presets = _getPresetsForMode(mode);
  delete presets[name];
  _savePresetsForMode(mode, presets);
}
function _renamePreset(mode, oldName, newName) {
  const presets = _getPresetsForMode(mode);
  if (presets[oldName]) {
    presets[newName] = presets[oldName];
    delete presets[oldName];
    _savePresetsForMode(mode, presets);
  }
}

function _findMatchingPreset() {
  const mode = currentMode;
  const presets = _getPresetsForMode(mode);
  const current = getSettings();
  const currentKeys = Object.keys(current);
  for (const name of Object.keys(presets)) {
    const p = _resolvePreset(presets[name]);
    if (!p || typeof p !== 'object') continue;
    const pKeys = Object.keys(p).filter(k => k !== '_basePreset');
    if (pKeys.length !== currentKeys.length) continue;
    if (pKeys.every(k => String(p[k]) === String(current[k]))) return name;
  }
  return null;
}

function renderSettingsPanel() {
  _unbindSettingsListeners();
  const panel = document.getElementById('settingsPanel');
  let sections = SETTINGS_CONFIG[currentMode];

  // For to_markdown mode: check if queue has DOC/DOCX input for UI hints
  let hasDocInput = false;
  if (currentMode === 'to_markdown') {
    const queue = getQueue();
    const firstFile = queue[0];
    if (firstFile && firstFile.name) {
      const ext = firstFile.name.split('.').pop().toLowerCase();
      hasDocInput = (ext === 'doc' || ext === 'docx');
    }
    // Always render all sections — DOC→PDF settings are kept in DOM
    // so saved settings and presets persist across mode switches
  }

  // Resolve base preset name for synced sections (to_markdown mode)
  let _syncedBaseName = null;
  if (currentMode === 'to_markdown') {
    const _panelAll = JSON.parse(localStorage.getItem(PANEL_SETTINGS_KEY) || '{}');
    const _panelSaved = _panelAll[currentMode];
    if (_panelSaved && _panelSaved._syncedBase && _panelSaved._syncedBase.basePreset) {
      _syncedBaseName = _panelSaved._syncedBase.basePreset;
    }
  }
  let _syncedBadgeShown = false;

  // Build settings HTML
  let html = sections.map(section => {
    // Add OCR engine status for PDF→DOCX mode or to_markdown mode in the "内容" section
    let extraHtml = '';
    if ((currentMode === 'pdf_to_docx' || currentMode === 'to_markdown') && section.title === '内容' && state.ocrStatus) {
      const ocr = state.ocrStatus;
      let statusClass = 'ocr-status-warning';
      let statusText = '未检测到 OCR 引擎';

      if (ocr.rapidocr) {
        statusClass = 'ocr-status-optimal';
        statusText = `RapidOCR 已就绪（${ocr.chinese_optimized ? '中文优化' : '基础模式'}）`;
      } else if (ocr.tesseract) {
        statusClass = 'ocr-status-ok';
        statusText = 'Tesseract 已就绪（基础模式）';
      }

      extraHtml = `
        <div class="ocr-engine-status ${statusClass}">
          <span class="ocr-status-icon">${ocr.rapidocr ? '⚡' : (ocr.tesseract ? '✓' : '⚠')}</span>
          <span class="ocr-status-text">${statusText}</span>
          ${!ocr.rapidocr && !ocr.tesseract ?
            '<div class="ocr-status-hint">建议安装: <code>pip install rapidocr-onnxruntime</code></div>' : ''}
        </div>
      `;
    }

    // Add image analysis for DOC→PDF mode or to_markdown (DOC input) in the "质量" section
    if ((currentMode === 'doc_to_pdf' || (currentMode === 'to_markdown' && hasDocInput)) && section.title === '质量') {
      const queue = getQueue();
      const currentFile = queue.find(f => f.status === 'pending' || f.status === 'processing');
      if (currentFile && currentFile.imageAnalysis) {
        const analysis = currentFile.imageAnalysis;
        if (analysis.imageCount > 0) {
          extraHtml = `
            <div class="image-analysis-info">
              <div class="analysis-header">文档图片分析</div>
              <div class="analysis-stats">
                <span class="stat-item">图片数量: <strong>${analysis.imageCount}</strong></span>
                ${analysis.maxWidth > 0 ? `<span class="stat-item">最大尺寸: <strong>${analysis.maxWidth}×${analysis.maxHeight}px</strong></span>` : ''}
                <span class="stat-item">图片总大小: <strong>${analysis.totalImageSizeFormatted}</strong></span>
              </div>
              <div class="analysis-recommendation">
                ${analysis.hasHighResImages ?
                  `<span class="recommendation-text">✓ 检测到高分辨率图片，建议使用 600 DPI 以保留细节</span>` :
                  `<span class="recommendation-text">ℹ 图片分辨率适中，300 DPI 即可满足需求</span>`
                }
              </div>
            </div>
          `;
        }
      }
    }

    // For to_markdown: sections with _docToPdfOnly are collapsible (synced from base preset)
    const isSynced = currentMode === 'to_markdown' && section._docToPdfOnly;
    // For to_markdown: mark DOC→PDF-only sections as not-applicable when input is PDF
    // Synced sections are always interactive (user can break sync by editing)
    const isNA = currentMode === 'to_markdown' && section._docToPdfOnly && !hasDocInput && !isSynced;
    const syncDataBaseAttr = isSynced && _syncedBaseName ? ` data-synced-base="${_syncedBaseName}"` : '';

    return `
      <div class="settings-section${isNA ? ' section-na' : ''}${isSynced ? ' section-synced' : ''}" ${isSynced ? `data-synced-section="true"${syncDataBaseAttr}` : ''}>
        <h4${isSynced ? ' class="section-synced-header" title="从 DOC→PDF 预设同步，点击展开编辑"' : ''}>${section.title}${isNA ? ' <span class="na-hint">仅 DOC/DOCX</span>' : ''}</h4>
        ${extraHtml}
        ${section.settings.map(s => {
          if (s.type === 'select') {
            return `
              <div class="setting-row">
                <div>
                  <div class="setting-label">${s.label}</div>
                  ${s.desc ? `<div class="setting-desc">${s.desc}</div>` : ''}
                </div>
                <div class="select-wrap">
                  <select data-key="${s.key}">${s.options.map(o => `<option>${o}</option>`).join('')}</select>
                </div>
              </div>`;
          } else {
            return `
              <div class="setting-row">
                <div>
                  <div class="setting-label">${s.label}</div>
                  ${s.desc ? `<div class="setting-desc">${s.desc}</div>` : ''}
                </div>
                <button class="toggle ${s.default ? 'on' : ''}" data-key="${s.key}" onclick="this.classList.toggle('on')"></button>
              </div>`;
          }
        }).join('')}
      </div>
    `;
  }).join('');

  // Add "adopt DOC→PDF settings" button for to_markdown mode
  let adoptBtnHtml = '';
  if (currentMode === 'to_markdown') {
    adoptBtnHtml = `
      <div class="settings-section">
        <button class="btn-ghost adopt-btn" onclick="_adoptDocToPdfSettings()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M2 12h20"/></svg>
          采用「DOC转PDF」当前设置
        </button>
      </div>
    `;
  }

  const presetBtnHtml = `
    <div class="settings-section preset-trigger-section">
      <button class="preset-open-btn" id="presetOpenBtn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
          <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
        </svg>
        <span>管理预设</span>
      </button>
    </div>
  `;
  panel.innerHTML = presetBtnHtml + adoptBtnHtml + html;

  // Bind preset open button (re-created each render since innerHTML replaces DOM)
  const presetOpenBtn = panel.querySelector('#presetOpenBtn');
  if (presetOpenBtn) {
    presetOpenBtn.addEventListener('click', openPresetModal);
    _updatePresetCountBadge();
    _updateActivePresetBadge();
  }

  renderBgSettings();
}

// ── Preset Modal ──
const MODE_LABELS = { doc_to_pdf: 'DOC→PDF', pdf_to_docx: 'PDF→DOCX', to_markdown: '转MD' };

function _renderPresetInlineSettingsHtml(settings, mode, namespace) {
  const config = SETTINGS_CONFIG[mode] || [];
  return config.map(section => {
    return `
      <div class="pm-inline-section">
        <div class="pm-inline-section-title">${section.title}</div>
        ${section.settings.map(s => {
          const val = settings !== undefined && settings[s.key] !== undefined ? settings[s.key] : (s.type === 'select' ? s.options[0] : (s.default || false));
          if (s.type === 'select') {
            return `
              <div class="pm-inline-row">
                <span class="pm-inline-label">${s.label}</span>
                <div class="select-wrap pm-inline-select">
                  <select data-key="${s.key}" data-pm-ns="${namespace}">${s.options.map(o => `<option ${o === val ? 'selected' : ''}>${o}</option>`).join('')}</select>
                </div>
              </div>`;
          } else {
            return `
              <div class="pm-inline-row">
                <span class="pm-inline-label">${s.label}${s.desc ? `<span class="pm-inline-desc">${s.desc}</span>` : ''}</span>
                <button class="toggle ${val ? 'on' : ''}" data-key="${s.key}" data-pm-ns="${namespace}" onclick="this.classList.toggle('on')"></button>
              </div>`;
          }
        }).join('')}
      </div>
    `;
  }).join('');
}

function _getPresetInlineSettings(container) {
  const settings = {};
  if (!container) return settings;
  container.querySelectorAll('[data-key]').forEach(el => {
    const key = el.dataset.key;
    if (el.tagName === 'SELECT') {
      settings[key] = el.value;
    } else if (el.classList.contains('toggle')) {
      settings[key] = el.classList.contains('on');
    }
  });
  return settings;
}

function _presetSummaryHtml(settings, mode) {
  if (!settings) return '';
  const config = SETTINGS_CONFIG[mode] || [];
  return config.map(section => {
    const tags = section.settings.map(s => {
      const v = settings[s.key];
      if (v === undefined) return '';
      const display = typeof v === 'boolean' ? (v ? '开' : '关') : v;
      return `<span class="preset-summary-tag"><span class="tag-label">${s.label}</span><span class="tag-value">${display}</span></span>`;
    }).filter(Boolean).join('');
    if (!tags) return '';
    return `
      <div class="preset-summary-section">
        <div class="preset-summary-section-title">${section.title}</div>
        <div class="preset-summary-tags">${tags}</div>
      </div>
    `;
  }).join('');
}

function _presetQuickSummaryHtml(settings, mode) {
  if (!settings) return '';
  const config = SETTINGS_CONFIG[mode] || [];
  const quickKeys = ['pageSize', 'orientation', 'imageDpi', 'tableMode', 'ocrEnabled', 'outputFormat'];
  const pills = [];
  config.forEach(section => {
    section.settings.forEach(s => {
      if (quickKeys.includes(s.key) && settings[s.key] !== undefined) {
        const v = settings[s.key];
        const display = typeof v === 'boolean' ? (v ? '开' : '关') : v;
        pills.push(`<span class="preset-summary-pill">${display}</span>`);
      }
    });
  });
  return pills.slice(0, 4).join('');
}

function _presetShowPreview(card, name) {
  const previewEl = card.querySelector('.preset-card-preview');
  if (!previewEl) return;

  if (previewEl.style.display !== 'none') {
    previewEl.style.display = 'none';
    return;
  }

  const mode = currentMode;
  const presets = _getPresetsForMode(mode);
  const presetSettings = presets[name];
  if (!presetSettings) return;

  const currentSettings = getSettings() || {};
  const config = SETTINGS_CONFIG[mode] || [];

  const buildDiff = (showAll) => {
    let html = '';
    config.forEach(section => {
      let sectionRows = '';
      section.settings.forEach(s => {
        const presetVal = presetSettings[s.key];
        const currentVal = currentSettings[s.key];
        if (presetVal === undefined) return;
        const changed = String(presetVal) !== String(currentVal);
        if (!showAll && !changed) return;
        const displayPreset = typeof presetVal === 'boolean' ? (presetVal ? '开' : '关') : presetVal;
        const displayCurrent = typeof currentVal === 'boolean' ? (currentVal ? '开' : '关') : (currentVal || '');
        sectionRows += `
          <div class="preset-diff-row ${changed ? 'preset-diff-changed' : ''}">
            <span class="preset-diff-label">${s.label}</span>
            <span class="preset-diff-current">${displayCurrent}</span>
            <span class="preset-diff-arrow">${changed ? '→' : '='}</span>
            <span class="preset-diff-preset">${displayPreset}</span>
          </div>
        `;
      });
      if (sectionRows) {
        html += `<div class="preset-diff-section"><div class="preset-diff-section-title">${section.title}</div>${sectionRows}</div>`;
      }
    });
    return html;
  };

  previewEl.innerHTML = `
    <div class="preset-preview-header">
      <span>设置变更预览</span>
      <div class="preset-preview-toggle" id="previewToggle-${name}">
        <button class="preset-preview-toggle-btn active" data-filter="changed">仅变更</button>
        <button class="preset-preview-toggle-btn" data-filter="all">全部</button>
      </div>
    </div>
    <div class="preset-preview-diff">${buildDiff(false)}</div>
  `;
  previewEl.style.display = 'block';

  const toggleContainer = previewEl.querySelector(`#previewToggle-${name}`);
  if (toggleContainer) {
    toggleContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.preset-preview-toggle-btn');
      if (!btn) return;
      toggleContainer.querySelectorAll('.preset-preview-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      previewEl.querySelector('.preset-preview-diff').innerHTML = buildDiff(btn.dataset.filter === 'all');
    });
  }
}

// ── Cross-mode preset inheritance for to_markdown ──

const _DOC_TO_PDF_SETTING_KEYS = ['pdfVersion', 'pageSize', 'orientation', 'imageDpi', 'embedFonts', 'losslessImages', 'passwordProtect', 'allowPrinting', 'allowCopying'];

function _renderDocToPdfPresetPickerHtml(namespace) {
  if (currentMode !== 'to_markdown') return '';
  const docPresets = _getPresetsForMode('doc_to_pdf');
  const names = Object.keys(docPresets).filter(k => docPresets[k] && typeof docPresets[k] === 'object');
  if (names.length === 0) return '';
  const ns = namespace || 'create';
  return `
    <div class="pm-base-preset-row">
      <span class="pm-inline-label">继承 DOC→PDF 预设</span>
      <div class="select-wrap pm-inline-select">
        <select id="pmBasePresetSelect${ns !== 'create' ? '-' + ns : ''}" class="pm-base-preset-select">
          <option value="">不继承</option>
          ${names.map(n => `<option value="${n}">${n}</option>`).join('')}
        </select>
      </div>
    </div>
  `;
}

function _toggleDocToPdfSections(form, fold) {
  const config = SETTINGS_CONFIG['to_markdown'] || [];
  const sections = form.querySelectorAll('.pm-inline-section');
  config.forEach((section, i) => {
    if (section._docToPdfOnly && sections[i]) {
      sections[i].classList.toggle('pm-inline-section--folded', fold);
    }
  });
}

function _bindBasePresetPicker(container, settingsContainerId) {
  if (currentMode !== 'to_markdown') return;
  const picker = container.querySelector('.pm-base-preset-select');
  if (!picker) return;
  picker.addEventListener('change', () => {
    const form = document.getElementById(settingsContainerId);
    if (!form) return;
    const presetName = picker.value;
    if (!presetName) {
      _toggleDocToPdfSections(form, false);
      return;
    }
    const docPresets = _getPresetsForMode('doc_to_pdf');
    const base = docPresets[presetName];
    if (!base) return;
    form.querySelectorAll('[data-key]').forEach(el => {
      const key = el.dataset.key;
      if (base[key] !== undefined) {
        if (el.tagName === 'SELECT') {
          el.value = base[key];
        } else if (el.classList.contains('toggle')) {
          el.classList.toggle('on', !!base[key]);
        }
      }
    });
    _toggleDocToPdfSections(form, true);
  });
}

function _importDocToPdfPreset(name) {
  const docPresets = _getPresetsForMode('doc_to_pdf');
  const base = docPresets[name];
  if (!base) return;
  const current = getSettings() || getDefaultSettings('to_markdown');
  const merged = { ...current };
  _DOC_TO_PDF_SETTING_KEYS.forEach(k => { if (base[k] !== undefined) merged[k] = base[k]; });
  // Track which base preset was imported and which keys user has manually edited
  merged._syncedBase = { basePreset: name, userEdited: {} };
  _isApplyingSettings = true;
  applySettings(merged);
  _isApplyingSettings = false;
  // Persist _syncedBase to localStorage (applySettings -> _savePanelSettings may not have preserved it on first import)
  const all = JSON.parse(localStorage.getItem(PANEL_SETTINGS_KEY) || '{}');
  if (all[currentMode]) all[currentMode]._syncedBase = merged._syncedBase;
  localStorage.setItem(PANEL_SETTINGS_KEY, JSON.stringify(all));
  const queue = getQueue();
  queue.forEach(item => {
    if (item.status === 'pending') {
      item.settings = { ...merged };
    }
  });
  showToast(`已导入预设「${name}」的 DOC→PDF 设置`, 'success');
}

function _renderDocToPdfImportSectionHtml() {
  if (currentMode !== 'to_markdown') return '';
  const docPresets = _getPresetsForMode('doc_to_pdf');
  const names = Object.keys(docPresets).filter(k => docPresets[k] && typeof docPresets[k] === 'object');
  if (names.length === 0) return '';
  return `
    <div class="pm-import-section">
      <div class="pm-import-section-title">从 DOC→PDF 预设导入</div>
      ${names.map(n => {
        const s = docPresets[n];
        return `
          <div class="pm-import-card">
            <span class="pm-import-card-name">${n}</span>
            <button class="pm-import-btn" onclick="_importDocToPdfPreset('${n.replace(/'/g, "\\'")}')">导入设置</button>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function _renderPresetModal() {
  const mode = currentMode;
  const presets = _getPresetsForMode(mode);
  const names = Object.keys(presets).filter(k => presets[k] && typeof presets[k] === 'object');
  const body = document.getElementById('presetModalBody');
  if (!body) return;
  const badge = document.getElementById('presetModalModeBadge');
  const modeLabel = document.getElementById('presetModalModeLabel');
  const label = MODE_LABELS[mode] || mode;
  if (badge) badge.textContent = label;
  if (modeLabel) modeLabel.textContent = label;

  const rawSettings = getSettings();
  const currentSettings = (rawSettings && Object.keys(rawSettings).length > 0) ? rawSettings : getDefaultSettings(mode);
  const createHtml = `
    <div class="preset-create" id="presetCreateArea">
      <button class="preset-create-trigger" id="presetCreateTrigger">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        新建预设
      </button>
      <div class="preset-create-form" id="presetCreateForm" style="display:none">
        <div class="preset-create-label">新建预设</div>
        <input type="text" class="preset-create-input" id="presetCreateName" placeholder="输入预设名称..." maxlength="20">
        <div class="preset-create-settings">
          <div class="preset-create-settings-label">输出设置</div>
          ${_renderDocToPdfPresetPickerHtml('create')}
          <div class="pm-inline-settings" id="presetCreateSettings">
            ${_renderPresetInlineSettingsHtml(currentSettings, mode, 'create')}
          </div>
        </div>
        <div class="preset-create-actions">
          <button class="preset-create-btn" id="presetCreateBtn">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20,6 9,17 4,12"/></svg>
            保存
          </button>
          <button class="preset-create-cancel" id="presetCreateCancel">取消</button>
        </div>
      </div>
    </div>
  `;

  if (names.length === 0) {
    body.innerHTML = createHtml + `
      <div class="preset-empty">
        <div class="preset-empty-geo"><span class="preset-empty-circle"></span></div>
        <div class="preset-empty-text">暂无预设</div>
        <div class="preset-empty-hint">调整右侧设置后，在上方输入名称保存</div>
      </div>
    `;
    _bindCreateBtn();
    return;
  }

  const activeName = _findMatchingPreset();

  body.innerHTML = createHtml + `<div class="preset-list-label">已有预设 · ${names.length}</div>` + names.map(name => {
    const raw = presets[name];
    const s = _resolvePreset(raw);
    const inheritsBadge = raw._basePreset ? `<span class="pm-inherits-badge" title="继承自「${raw._basePreset}」">↑ ${raw._basePreset}</span>` : '';
    return `
      <div class="preset-card ${name === activeName ? 'preset-card--active' : ''}" data-preset-name="${name}">
        <span class="preset-card-tick"></span>
        <span class="preset-card-tick"></span>
        <span class="preset-card-tick"></span>
        <div class="preset-card-header">
          <div class="preset-card-name-area">
            ${name === activeName ? '<span class="preset-active-dot" title="当前匹配"></span>' : ''}
            <span class="preset-card-name">${name}</span>
            ${inheritsBadge}
          </div>
          <div class="preset-card-header-right">
            <div class="preset-card-pills">${_presetQuickSummaryHtml(s, mode)}</div>
            <button class="preset-card-expand-btn" title="展开详情">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6,9 12,15 18,9"/></svg>
            </button>
          </div>
        </div>
        <button class="preset-apply-btn">应用此预设</button>
        <div class="preset-card-meta-row">
          <button class="preset-action-btn preset-action-preview" title="预览变更">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="preset-action-btn preset-action-edit" title="编辑设置">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          </button>
          <button class="preset-action-btn preset-action-rename" title="重命名">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="preset-action-btn preset-action-delete" title="删除">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>
        </div>
        <div class="preset-card-details">
          <div class="preset-settings-summary">${_presetSummaryHtml(s, mode)}</div>
        </div>
        <div class="preset-card-preview" style="display:none">
          <div class="preset-preview-header">设置变更预览</div>
          <div class="preset-preview-diff"></div>
        </div>
        <div class="preset-card-editor" style="display:none">
          ${_renderDocToPdfPresetPickerHtml('edit-' + name)}
          <div class="pm-inline-settings">
            ${_renderPresetInlineSettingsHtml(s, mode, 'edit-' + name)}
          </div>
          <div class="preset-card-editor-actions">
            <button class="preset-editor-save-btn">保存修改</button>
            <button class="preset-editor-cancel-btn">取消</button>
          </div>
        </div>
        <svg class="preset-card-apply-check" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20,6 9,17 4,12"/></svg>
      </div>
    `;
  }).join('') + _renderDocToPdfImportSectionHtml();
  _bindCreateBtn();

  // Bind base preset picker for to_markdown create form
  const createArea = document.getElementById('presetCreateArea');
  if (createArea) _bindBasePresetPicker(createArea, 'presetCreateSettings');

  // Bind base preset pickers for to_markdown edit forms
  if (currentMode === 'to_markdown') {
    body.querySelectorAll('.preset-card-editor').forEach(editor => {
      const card = editor.closest('.preset-card');
      const pname = card ? card.dataset.presetName : '';
      if (pname) {
        const settingsContainer = editor.querySelector('.pm-inline-settings');
        if (settingsContainer) {
          settingsContainer.id = 'presetEditSettings-' + pname;
          _bindBasePresetPicker(editor, 'presetEditSettings-' + pname);
        }
      }
    });
  }

  // Add staggered card animation
  const cards = body.querySelectorAll('.preset-card');
  cards.forEach((card, i) => {
    card.style.animationDelay = `${i * 50}ms`;
    card.classList.add('preset-card-enter');
  });
}

function _slideClose(el) {
  return new Promise(resolve => {
    if (!el || el.style.display === 'none') { resolve(); return; }
    el.classList.remove('pm-slide-open');
    el.classList.add('pm-slide-closed');
    const onEnd = () => {
      el.style.display = 'none';
      el.removeEventListener('transitionend', onEnd);
      resolve();
    };
    el.addEventListener('transitionend', onEnd);
  });
}

function _slideOpen(el) {
  return new Promise(resolve => {
    if (!el) { resolve(); return; }
    el.style.display = 'block';
    el.offsetHeight;
    el.classList.remove('pm-slide-closed');
    el.classList.add('pm-slide-open');
    const onEnd = () => {
      el.removeEventListener('transitionend', onEnd);
      resolve();
    };
    el.addEventListener('transitionend', onEnd);
  });
}

function _bindCreateBtn() {
  const trigger = document.getElementById('presetCreateTrigger');
  const form = document.getElementById('presetCreateForm');
  const input = document.getElementById('presetCreateName');
  const btn = document.getElementById('presetCreateBtn');
  const cancel = document.getElementById('presetCreateCancel');
  const settingsContainer = document.getElementById('presetCreateSettings');
  if (!trigger || !form || !input || !btn) return;

  const expand = () => {
    trigger.classList.add('pm-trigger-exit');
    setTimeout(() => {
      trigger.style.display = 'none';
      _slideOpen(form).then(() => input.focus());
    }, 200);
  };

  const collapse = () => {
    input.value = '';
    _slideClose(form).then(() => {
      trigger.style.display = 'flex';
      trigger.classList.remove('pm-trigger-exit');
      trigger.classList.add('pm-trigger-enter');
      setTimeout(() => trigger.classList.remove('pm-trigger-enter'), 350);
    });
  };

  trigger.addEventListener('click', expand);
  if (cancel) cancel.addEventListener('click', collapse);

  const doSave = async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    const existing = _getPresetsForMode(currentMode);
    if (existing[name]) {
      const result = await _pmShowPanel({ type: 'confirm', title: '确认覆盖', message: `预设「${name}」已存在，是否覆盖？`, confirmLabel: '覆盖' });
      if (!result) return;
    }
    // Re-query container from DOM in case the captured reference is stale
    let container = settingsContainer;
    if (!container || !container.isConnected) {
      container = document.getElementById('presetCreateSettings');
    }
    const settings = _getPresetInlineSettings(container);
    if (!settings || Object.keys(settings).length === 0) {
      showToast('无法读取设置', 'warning');
      return;
    }
    const basePresetSelect = container.closest('.preset-create-form')?.querySelector('.pm-base-preset-select');
    const basePresetName = basePresetSelect?.value || '';
    _savePreset(currentMode, name, settings, basePresetName || undefined);
    _renderPresetModal();
    _updatePresetCountBadge();
    showToast(`预设「${name}」已保存`, 'success');
  };

  btn.addEventListener('click', doSave);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
    if (e.key === 'Escape') { collapse(); }
  });
}

function _updatePresetCountBadge() {
  const count = Object.keys(_getPresetsForMode(currentMode)).length;
  const btn = document.getElementById('presetOpenBtn');
  if (!btn) return;
  let badge = btn.querySelector('.preset-count-badge');
  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'preset-count-badge';
      btn.appendChild(badge);
    }
    badge.textContent = count;
  } else if (badge) {
    badge.remove();
  }
}

function _updateActivePresetBadge() {
  const btn = document.getElementById('presetOpenBtn');
  if (!btn) return;
  const name = _getActivePreset();
  let badge = btn.querySelector('.preset-active-indicator');
  if (name) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'preset-active-indicator';
      btn.appendChild(badge);
    }
    badge.textContent = name;
    badge.style.display = '';
    // Dim if current settings no longer match the preset
    const matched = _findMatchingPreset() === name;
    badge.classList.toggle('preset-active-indicator--dimmed', !matched);
  } else if (badge) {
    badge.style.display = 'none';
  }
}

function openPresetModal() {
  const overlay = document.getElementById('presetModalOverlay');
  // Reset pm-panel in case it was left visible from a previous confirm dialog
  const pmPanel = document.getElementById('pmPanel');
  if (pmPanel) {
    pmPanel.classList.remove('pm-panel-visible');
    pmPanel.style.display = 'none';
  }
  overlay.style.display = 'flex';
  // Force reflow for transition
  void overlay.offsetHeight;
  overlay.classList.add('pm-visible');
  _renderPresetModal();
}

function closePresetModal() {
  const overlay = document.getElementById('presetModalOverlay');
  // Also hide pm-panel if it was open
  const pmPanel = document.getElementById('pmPanel');
  if (pmPanel) {
    pmPanel.classList.remove('pm-panel-visible');
    pmPanel.style.display = 'none';
  }

  const closeOverlay = () => {
    overlay.classList.remove('pm-visible');
    overlay.classList.add('pm-closing');
    setTimeout(() => {
      overlay.classList.remove('pm-closing');
      overlay.style.display = 'none';
    }, 400);
  };

  // If create form is expanded, collapse it first before closing modal
  const createForm = document.getElementById('presetCreateForm');
  if (createForm && createForm.classList.contains('pm-slide-open')) {
    _slideClose(createForm).then(closeOverlay);
  } else {
    closeOverlay();
  }
}

function _presetShowInlineRename(card, currentName) {
  const nameEl = card.querySelector('.preset-card-name');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'preset-rename-input';
  input.value = currentName;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const newName = input.value.trim();
    if (newName && newName !== currentName) {
      const existing = _getPresetsForMode(currentMode);
      if (existing[newName]) {
        showToast(`预设「${newName}」已存在`, 'warning');
        _renderPresetModal();
        return;
      }
      _renamePreset(currentMode, currentName, newName);
      showToast(`已重命名为「${newName}」`, 'success');
    }
    _renderPresetModal();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = currentName; input.blur(); }
  });
}

// ── In-Modal Panel (confirm / input) ──
let _pmPanelResolve = null;

function _pmShowPanel(config) {
  return new Promise(resolve => {
    _pmPanelResolve = resolve;
    const panel = document.getElementById('pmPanel');
    const inner = document.getElementById('pmPanelInner');
    const { type, title, message, confirmLabel, danger, placeholder } = config;

    const dangerClass = danger ? ' pm-panel-danger' : '';
    let inputHtml = '';
    if (type === 'input') {
      inputHtml = `<input type="text" class="pm-panel-input" id="pmPanelInput" placeholder="${placeholder || ''}" maxlength="20">`;
    }

    inner.innerHTML = `
      <div class="pm-panel-header">${title}</div>
      <div class="pm-panel-message">${message}</div>
      ${inputHtml}
      <div class="pm-panel-actions">
        <button class="pm-panel-cancel-btn" id="pmPanelCancel">${config.cancelLabel || '取消'}</button>
        <button class="pm-panel-confirm-btn" id="pmPanelConfirm">${confirmLabel || '确定'}</button>
      </div>
    `;
    inner.className = 'pm-panel-inner' + dangerClass;

    panel.style.display = 'flex';
    void panel.offsetHeight;
    panel.classList.add('pm-panel-visible');

    const input = document.getElementById('pmPanelInput');
    if (input) {
      input.focus();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); _pmPanelConfirm(type); }
        if (e.key === 'Escape') { _pmPanelClose(); }
      });
    }

    document.getElementById('pmPanelConfirm').addEventListener('click', () => _pmPanelConfirm(type));
    document.getElementById('pmPanelCancel').addEventListener('click', _pmPanelClose);

    // Escape on document level (only while panel is visible)
    const escHandler = (e) => {
      if (e.key === 'Escape') { _pmPanelClose(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);
  });
}

function _pmPanelConfirm(type) {
  const panel = document.getElementById('pmPanel');
  const input = document.getElementById('pmPanelInput');
  let value = null;
  if (type === 'input' && input) {
    value = input.value.trim();
    if (!value) { input.focus(); return; }
  } else {
    value = 'confirm';
  }
  panel.classList.remove('pm-panel-visible');
  setTimeout(() => { panel.style.display = 'none'; }, 250);
  if (_pmPanelResolve) { _pmPanelResolve(value); _pmPanelResolve = null; }
}

function _pmPanelClose() {
  const panel = document.getElementById('pmPanel');
  panel.classList.remove('pm-panel-visible');
  setTimeout(() => { panel.style.display = 'none'; }, 250);
  if (_pmPanelResolve) { _pmPanelResolve(null); _pmPanelResolve = null; }
}

// ── Preset Modal Event Bindings ──
(function _bindPresetModalEvents() {
  document.addEventListener('DOMContentLoaded', () => {
    // Close button
    document.getElementById('presetModalClose').addEventListener('click', closePresetModal);

    // Click overlay to close
    document.getElementById('presetModalOverlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closePresetModal();
    });

    // Escape to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById('presetModalOverlay').classList.contains('pm-visible')) {
        closePresetModal();
      }
    });

    // Arrow key navigation + Enter to apply
    document.addEventListener('keydown', (e) => {
      const overlay = document.getElementById('presetModalOverlay');
      if (!overlay || !overlay.classList.contains('pm-visible')) return;
      const pmPanel = document.getElementById('pmPanel');
      if (pmPanel && pmPanel.classList.contains('pm-panel-visible')) return;

      const cards = [...overlay.querySelectorAll('.preset-card')];
      if (!cards.length) return;

      const focused = overlay.querySelector('.preset-card--kb-focus');
      let idx = focused ? cards.indexOf(focused) : -1;

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        idx = Math.min(idx + 1, cards.length - 1);
        cards.forEach(c => c.classList.remove('preset-card--kb-focus'));
        cards[idx].classList.add('preset-card--kb-focus');
        cards[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        idx = Math.max(idx - 1, 0);
        cards.forEach(c => c.classList.remove('preset-card--kb-focus'));
        cards[idx].classList.add('preset-card--kb-focus');
        cards[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else if (e.key === 'Enter' && focused) {
        e.preventDefault();
        focused.querySelector('.preset-apply-btn')?.click();
      } else if (e.key === 'e' && focused) {
        e.preventDefault();
        focused.querySelector('.preset-action-edit')?.click();
      }
    });

    // Export
    const exportBtn = document.getElementById('presetExportBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        const presets = _getPresetsForMode(currentMode);
        if (Object.keys(presets).length === 0) {
          showToast('当前模式没有预设可导出', 'warning');
          return;
        }
        const data = JSON.stringify({ mode: currentMode, presets }, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `docflow-presets-${currentMode}-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('预设已导出', 'success');
      });
    }

    // Import
    const importInput = document.getElementById('presetImportFile');
    const importBtn = document.getElementById('presetImportBtn');
    if (importBtn && importInput) {
      importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (!data.presets || typeof data.presets !== 'object') {
            showToast('无效的预设文件', 'warning');
            return;
          }
          const targetMode = data.mode || currentMode;
          const existing = _getPresetsForMode(targetMode);
          const incoming = data.presets;
          const incomingNames = Object.keys(incoming);
          let imported = 0;
          let overwritten = 0;
          for (const name of incomingNames) {
            if (existing[name]) overwritten++;
            else imported++;
            existing[name] = incoming[name];
          }
          _savePresetsForMode(targetMode, existing);
          if (targetMode === currentMode) _renderPresetModal();
          _updatePresetCountBadge();
          showToast(`导入完成：新增 ${imported}，覆盖 ${overwritten}`, 'success');
        } catch {
          showToast('文件解析失败', 'warning');
        }
      };
      reader.readAsText(file);
      importInput.value = '';
    });
    }

    // Delegated events on modal body
    const modalBody = document.getElementById('presetModalBody');
    if (modalBody) {
    modalBody.addEventListener('click', async (e) => {
      const card = e.target.closest('.preset-card');
      if (!card) return;
      const name = card.dataset.presetName;

      // Apply
      if (e.target.closest('.preset-apply-btn')) {
        const presets = _getPresetsForMode(currentMode);
        if (presets[name]) {
          const resolved = _resolvePreset(presets[name]);
          card.classList.add('preset-card--applying');
          setTimeout(() => {
            _isApplyingSettings = true;
            applySettings(resolved);
            _isApplyingSettings = false;
            _saveActivePreset(name);
            // Update all pending queue items with preset settings
            const queue = getQueue();
            queue.forEach(item => {
              if (item.status === 'pending') {
                item.settings = { ...resolved };
              }
            });
            closePresetModal();
            showToast(`已应用预设「${name}」`, 'success');
          }, 400);
        }
        return;
      }

      // Edit (toggle inline editor)
      if (e.target.closest('.preset-action-edit')) {
        const editor = card.querySelector('.preset-card-editor');
        if (editor) {
          const isOpen = editor.classList.contains('pm-slide-open');
          if (isOpen) {
            _slideClose(editor);
          } else {
            card.querySelector('.preset-card-details')?.classList.remove('preset-details-visible');
            _slideOpen(editor);
          }
        }
        return;
      }

      // Save edited preset
      if (e.target.closest('.preset-editor-save-btn')) {
        const editor = card.querySelector('.preset-card-editor');
        if (editor) {
          const settings = _getPresetInlineSettings(editor);
          const existingPresets = _getPresetsForMode(currentMode);
          const oldBase = existingPresets[name]?._basePreset || '';
          const editPicker = editor.querySelector('.pm-base-preset-select');
          const newBase = editPicker?.value || oldBase;
          _savePreset(currentMode, name, settings, newBase || undefined);
          _renderPresetModal();
          showToast(`预设「${name}」已更新`, 'success');
        }
        return;
      }

      // Cancel edit
      if (e.target.closest('.preset-editor-cancel-btn')) {
        const editor = card.querySelector('.preset-card-editor');
        if (editor) _slideClose(editor);
        return;
      }

      // Delete
      if (e.target.closest('.preset-action-delete')) {
        const result = await _pmShowPanel({ type: 'confirm', title: '确认删除', message: `删除预设「${name}」？此操作不可撤销。`, confirmLabel: '删除', danger: true });
        if (result) {
          _deletePreset(currentMode, name);
          if (_getActivePreset() === name) _saveActivePreset(null);
          _renderPresetModal();
          _updatePresetCountBadge();
          _updateActivePresetBadge();
          showToast(`预设「${name}」已删除`, 'info');
        }
        return;
      }

      // Rename (inline)
      if (e.target.closest('.preset-action-rename')) {
        _presetShowInlineRename(card, name);
        return;
      }

      // Preview
      if (e.target.closest('.preset-action-preview')) {
        _presetShowPreview(card, name);
        return;
      }

      // Expand/collapse details
      if (e.target.closest('.preset-card-expand-btn')) {
        const details = card.querySelector('.preset-card-details');
        const expandBtn = card.querySelector('.preset-card-expand-btn');
        if (details && expandBtn) {
          const isVisible = details.classList.contains('preset-details-visible');
          details.classList.toggle('preset-details-visible', !isVisible);
          expandBtn.classList.toggle('preset-card-expanded', !isVisible);
        }
        return;
      }
    });
    }
  });
})();

// ── Background Image & Font Settings ──
let _lastBgState = null;
let _lastFontState = null;

function _isSettingsOpen() {
  const o = document.getElementById('settingsOverlay');
  return o && o.style.display !== 'none';
}

function renderBgSettings() {
  if (!_isSettingsOpen()) return;
  const container = document.getElementById('settingsBody');
  if (!container) return;
  const savedBg = localStorage.getItem('docflow_bg_image');
  const savedFont = localStorage.getItem('docflow_font_name');
  // Find or create the appearance section
  let section = container.querySelector('.sp-appearance-section');
  if (!section) {
    section = document.createElement('div');
    section.className = 'sp-section sp-appearance-section';
    container.insertBefore(section, container.firstChild);
  }
  section.innerHTML = `
    <div class="sp-section-title">外 观</div>
    <div style="margin-bottom:14px">
      <div class="sp-row-label" style="margin-bottom:6px">自定义背景</div>
      <div class="sp-row-desc" style="margin-bottom:8px">为应用设置个性化背景图片</div>
      <div class="bg-preview" id="bgPreview" style="width:100%;height:100px">
        ${savedBg ? `<img src="${savedBg}">` : `<div style="width:100%;height:100%;background:var(--bg)"></div>`}
      </div>
      <div class="bg-actions">
        <button class="bg-btn primary" onclick="document.getElementById('bgFileInput').click()">选择图片</button>
        ${savedBg ? `<button class="bg-btn" onclick="removeBgImage()">移除</button>` : ''}
      </div>
    </div>
    <div>
      <div class="sp-row-label" style="margin-bottom:6px">自定义字体</div>
      <div class="sp-row-desc" style="margin-bottom:8px">导入 TTF / OTF / WOFF / WOFF2 字体文件全局覆盖</div>
      <div style="display:flex;align-items:center;gap:10px">
        <div style="flex:1;padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          ${savedFont || '系统默认字体'}
        </div>
        <div class="bg-actions" style="margin-top:0;flex-shrink:0">
          <button class="bg-btn primary" onclick="document.getElementById('fontFileInput').click()">导入字体</button>
          ${savedFont ? `<button class="bg-btn" onclick="removeCustomFont()">恢复默认</button>` : ''}
        </div>
      </div>
    </div>
  `;
}

function renderMusicSettings() {
  if (!_isSettingsOpen()) return;
  const container = document.getElementById('settingsBody');
  if (!container) return;
  const mode = musicPlayer.mode;
  const modeNames = { loop: '列表循环', shuffle: '随机播放', single: '单曲循环' };
  let section = container.querySelector('.sp-music-section');
  if (!section) {
    section = document.createElement('div');
    section.className = 'sp-section sp-music-section';
    container.appendChild(section);
  }
  const musicEnabled = localStorage.getItem('docflow_music_enabled') !== 'false';
  section.innerHTML = `
    <div class="sp-section-title">音乐播放</div>
    <div class="sp-row">
      <div>
        <div class="sp-row-label">启用音乐</div>
        <div class="sp-row-desc">关闭后隐藏音乐播放器，不影响帮助手册音频</div>
      </div>
      <button class="toggle${musicEnabled ? ' on' : ''}" id="spMusicEnabledToggle"></button>
    </div>
    <div style="margin-bottom:18px;${musicEnabled ? '' : 'opacity:0.4;pointer-events:none;'}">
      <div class="sp-row-label" style="margin-bottom:10px">播放模式</div>
      <div class="sp-mode-group">
        <div class="sp-mode-indicator"></div>
        ${['loop', 'shuffle', 'single'].map(m => `
          <button class="sp-mode-btn${m === mode ? ' active' : ''}" data-mode="${m}">${modeNames[m]}</button>
        `).join('')}
      </div>
    </div>
  `;
  // Position sliding indicator
  const group = section.querySelector('.sp-mode-group');
  const indicator = section.querySelector('.sp-mode-indicator');
  function positionIndicator() {
    const activeBtn = group.querySelector('.sp-mode-btn.active');
    if (!activeBtn || !indicator) return;
    indicator.style.left = activeBtn.offsetLeft + 'px';
    indicator.style.width = activeBtn.offsetWidth + 'px';
  }
  positionIndicator();
  // Bind mode buttons — toggle class + slide, no re-render
  section.querySelectorAll('.sp-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      group.querySelector('.sp-mode-btn.active')?.classList.remove('active');
      btn.classList.add('active');
      positionIndicator();
      musicPlayer.mode = btn.dataset.mode;
      localStorage.setItem('docflow_music_mode', btn.dataset.mode);
      updateModeIcon();
      if (btn.dataset.mode === 'shuffle') {
        shuffleArray(musicPlayer.tracks.length);
        musicPlayer.shufflePos = 0;
      }
      const modeBtn = document.getElementById('musicModeBtn');
      if (modeBtn) modeBtn.title = modeNames[btn.dataset.mode];
    });
  });
  // Bind music enabled toggle
  const musicToggle = section.querySelector('#spMusicEnabledToggle');
  if (musicToggle) {
    musicToggle.addEventListener('click', () => {
      const enabled = musicToggle.classList.toggle('on');
      localStorage.setItem('docflow_music_enabled', enabled);
      applyMusicEnabled(enabled);
      if (!enabled) {
        showToast('音乐播放器已关闭', 'info');
      } else {
        showToast('音乐播放器已开启', 'success');
      }
    });
  }
}

function renderSplashSettings() {
  if (!_isSettingsOpen()) return;
  const container = document.getElementById('settingsBody');
  if (!container) return;
  const current = localStorage.getItem('docflow_splash_animation') || 'constructivist';
  const animations = [
    { id: 'constructivist', name: '构成主义' },
    { id: 'neo', name: '新表现主义' },
    { id: 'maximalist', name: '极繁主义' },
    { id: 'brutalist', name: '新粗野主义' },
    { id: 'bauhaus', name: '包豪斯主义' },
  ];
  let section = container.querySelector('.sp-splash-section');
  if (!section) {
    section = document.createElement('div');
    section.className = 'sp-section sp-splash-section';
    container.appendChild(section);
  }
  section.innerHTML = `
    <div class="sp-section-title">启动动画</div>
    <div style="margin-bottom:4px">
      <div class="sp-row-label" style="margin-bottom:10px">动画风格</div>
      <div class="sp-mode-group">
        <div class="sp-mode-indicator"></div>
        ${animations.map(a => `
          <button class="sp-mode-btn${a.id === current ? ' active' : ''}" data-splash="${a.id}">${a.name}</button>
        `).join('')}
      </div>
      <div class="sp-row-desc" style="margin-top:8px">切换后刷新页面生效</div>
    </div>
  `;
  // Position sliding indicator
  const group = section.querySelector('.sp-mode-group');
  const indicator = section.querySelector('.sp-mode-indicator');
  function positionIndicator() {
    const activeBtn = group.querySelector('.sp-mode-btn.active');
    if (!activeBtn || !indicator) return;
    indicator.style.left = activeBtn.offsetLeft + 'px';
    indicator.style.width = activeBtn.offsetWidth + 'px';
  }
  positionIndicator();
  // Bind buttons
  section.querySelectorAll('.sp-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      const val = btn.dataset.splash;
      group.querySelector('.sp-mode-btn.active')?.classList.remove('active');
      btn.classList.add('active');
      positionIndicator();
      localStorage.setItem('docflow_splash_animation', val);
      document.body.classList.remove('neo-mode', 'maximalist-mode', 'brutalist-mode', 'bauhaus-mode');
      if (val === 'neo') {
        document.body.classList.add('neo-mode');
      } else if (val === 'maximalist') {
        document.body.classList.add('maximalist-mode');
      } else if (val === 'brutalist') {
        document.body.classList.add('brutalist-mode');
      } else if (val === 'bauhaus') {
        document.body.classList.add('bauhaus-mode');
      }
      // Immediately hide all overlays to prevent stale splash blocking interaction
      document.getElementById('loadingOverlay')?.classList.add('hidden');
      document.getElementById('loadingOverlayNeo')?.classList.add('hidden');
      document.getElementById('loadingOverlayMax')?.classList.add('hidden');
      document.getElementById('loadingOverlayBrut')?.classList.add('hidden');
      document.getElementById('loadingOverlayBau')?.classList.add('hidden');
      showToast('启动动画已切换，刷新页面生效', 'success');
    });
  });
}

const PROGRESS_BAR_STYLES = [
  { id: 'constructivist', name: '构成主义' },
  { id: 'neo', name: '新表现主义' },
  { id: 'maximalist', name: '极繁主义' },
  { id: 'brutalist', name: '新粗野主义' },
  { id: 'bauhaus', name: '包豪斯主义' },
];
const PROGRESS_BAR_STORAGE_KEY = 'docflow_progress_bar_style';
let _cachedProgressBarStyle = null;

function _getProgressBarStyle() {
  if (_cachedProgressBarStyle === null) {
    _cachedProgressBarStyle = localStorage.getItem(PROGRESS_BAR_STORAGE_KEY) || 'constructivist';
  }
  return _cachedProgressBarStyle;
}

function renderProgressBarSettings() {
  if (!_isSettingsOpen()) return;
  const container = document.getElementById('settingsBody');
  if (!container) return;
  const current = _getProgressBarStyle();
  let section = container.querySelector('.sp-pbar-section');
  if (!section) {
    section = document.createElement('div');
    section.className = 'sp-section sp-pbar-section';
    container.appendChild(section);
  }
  const segPreview = (style, count) => {
    return Array.from({length: count}, () => '<div class="spp-seg"></div>').join('');
  };
  section.innerHTML = `
    <div class="sp-section-title">进度条样式</div>
    <div style="margin-bottom:4px">
      <div class="sp-row-label" style="margin-bottom:10px">样式选择</div>
      <div class="sp-mode-group">
        <div class="sp-mode-indicator"></div>
        ${PROGRESS_BAR_STYLES.map(a => `
          <button class="sp-mode-btn${a.id === current ? ' active' : ''}" data-pbar="${a.id}">
            <span>${a.name}</span>
            <div class="sp-pbar-preview ${a.id}">${segPreview(a.id, 5)}</div>
          </button>
        `).join('')}
      </div>
      <div class="sp-row-desc" style="margin-top:8px">实时生效，无需刷新</div>
    </div>
  `;
  const group = section.querySelector('.sp-mode-group');
  const indicator = section.querySelector('.sp-mode-indicator');
  function positionIndicator() {
    const activeBtn = group.querySelector('.sp-mode-btn.active');
    if (!activeBtn || !indicator) return;
    indicator.style.left = activeBtn.offsetLeft + 'px';
    indicator.style.width = activeBtn.offsetWidth + 'px';
  }
  positionIndicator();
  section.querySelectorAll('.sp-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      const val = btn.dataset.pbar;
      group.querySelector('.sp-mode-btn.active')?.classList.remove('active');
      btn.classList.add('active');
      positionIndicator();
      _cachedProgressBarStyle = val;
      localStorage.setItem(PROGRESS_BAR_STORAGE_KEY, val);
      renderQueue();
      showToast('进度条样式已切换', 'success');
    });
  });
}

function openSettings() {
  const overlay = document.getElementById('settingsOverlay');
  if (!overlay) return;
  overlay.classList.remove('sp-closing');
  overlay.classList.add('sp-visible');
  const body = document.getElementById('settingsBody');
  if (body) body.innerHTML = '';
  renderBgSettings();
  renderSplashSettings();
  renderProgressBarSettings();
  renderMusicSettings();
}

function closeSettings() {
  const overlay = document.getElementById('settingsOverlay');
  if (!overlay || !overlay.classList.contains('sp-visible') || overlay.classList.contains('sp-closing')) return;
  overlay.classList.add('sp-closing');
  const onEnd = () => {
    overlay.removeEventListener('transitionend', onEnd);
    overlay.classList.remove('sp-visible', 'sp-closing');
  };
  overlay.addEventListener('transitionend', onEnd);
}

function applyBgImage(dataUrl) {
  if (dataUrl) {
    document.body.style.background = `url(${dataUrl}) center/cover no-repeat var(--bg)`;
    document.body.classList.add('custom-bg');
    localStorage.setItem('docflow_bg_image', dataUrl);
  } else {
    document.body.style.background = '';
    document.body.classList.remove('custom-bg');
    localStorage.removeItem('docflow_bg_image');
  }
}

function removeBgImage() {
  applyBgImage(null);
  renderBgSettings();
  showToast('已移除自定义背景');
}

// ── Custom Font ──
function applyCustomFont(fontName, arrayBuffer) {
  document.documentElement.style.setProperty('--font-custom', `'${fontName}'`);
  const fontFace = new FontFace(fontName, arrayBuffer);
  fontFace.load().then((loaded) => {
    document.fonts.add(loaded);
    localStorage.setItem('docflow_font_name', fontName);
    renderBgSettings();
    showToast(`已应用字体: ${fontName}`);
  }).catch((err) => {
    document.documentElement.style.setProperty('--font-custom', ' ');
    showToast('字体文件加载失败: ' + (err.message || '格式不支持'), 'warning');
  });
}

function removeCustomFont() {
  fetch(`${API}/api/font`, { method: 'DELETE' }).then(() => {
    document.documentElement.style.setProperty('--font-custom', ' ');
    localStorage.removeItem('docflow_font_name');
    renderBgSettings();
    showToast('已恢复默认字体');
  });
}

async function loadSavedFont() {
  try {
    const res = await fetch(`${API}/api/font`);
    const data = await res.json();
    if (!data.name) return;
    // CSS variable already set server-side; just register the FontFace
    const fontRes = await fetch(`${API}/api/font-file`);
    if (!fontRes.ok) return;
    const buffer = await fontRes.arrayBuffer();
    const fontFace = new FontFace(data.name, buffer);
    const loaded = await fontFace.load();
    document.fonts.add(loaded);
  } catch { /* server-side CSS var still applies even if FontFace fails */ }
}

function compressImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxW = 1920;
        let w = img.width, h = img.height;
        if (w > maxW) { h = h * maxW / w; w = maxW; }
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Cropper ──
let _cropperState = null;

function openCropper(dataUrl) {
  const img = new Image();
  img.onload = () => {
    const headerH = 48, footerH = 60;
    const bodyW = window.innerWidth;
    const bodyH = window.innerHeight - headerH - footerH;
    const scale = Math.min(bodyW / img.naturalWidth, bodyH / img.naturalHeight, 1);
    const dispW = img.naturalWidth * scale;
    const dispH = img.naturalHeight * scale;

    const modal = document.createElement('div');
    modal.className = 'cropper-modal';
    modal.innerHTML = `
      <div class="cropper-header">
        <span class="cropper-title">裁剪背景图片</span>
        <button class="cropper-close" onclick="onCropperCancel()">&times;</button>
      </div>
      <div class="cropper-body" id="cropperBody">
        <img id="cropperImg" src="${dataUrl}" style="width:${dispW}px;height:${dispH}px">
        <div class="cropper-box" id="cropperBox">
          <div class="cropper-handle tl" data-handle="tl"></div>
          <div class="cropper-handle tr" data-handle="tr"></div>
          <div class="cropper-handle bl" data-handle="bl"></div>
          <div class="cropper-handle br" data-handle="br"></div>
        </div>
      </div>
      <div class="cropper-footer">
        <button class="bg-btn" onclick="onCropperCancel()">取消</button>
        <button class="bg-btn primary" onclick="onCropperConfirm()">裁剪</button>
      </div>
    `;
    document.body.appendChild(modal);

    // Calculate image offset within the flexbox-centered container
    const cropperBody = document.getElementById('cropperBody');
    const cropperImg = document.getElementById('cropperImg');
    const bodyRect = cropperBody.getBoundingClientRect();
    const imgRect = cropperImg.getBoundingClientRect();
    const offsetX = imgRect.left - bodyRect.left;
    const offsetY = imgRect.top - bodyRect.top;

    const boxSize = Math.min(200, dispW * 0.8, dispH * 0.8);
    const boxW = Math.round(boxSize);
    const boxH = Math.round(boxSize);
    const boxX = Math.round(offsetX + (dispW - boxW) / 2);
    const boxY = Math.round(offsetY + (dispH - boxH) / 2);

    const box = document.getElementById('cropperBox');
    box.style.left = boxX + 'px';
    box.style.top = boxY + 'px';
    box.style.width = boxW + 'px';
    box.style.height = boxH + 'px';

    _cropperState = {
      dataUrl, dispW, dispH, scale,
      imgNaturalW: img.naturalWidth, imgNaturalH: img.naturalHeight,
      offsetX, offsetY,
      boxX, boxY, boxW, boxH,
      minSize: 60,
      dragging: false, resizing: false, handle: null,
      startX: 0, startY: 0, startBoxX: 0, startBoxY: 0, startBoxW: 0, startBoxH: 0,
      modal
    };
    initCropperEvents();
  };
  img.src = dataUrl;
}

function initCropperEvents() {
  const s = _cropperState;
  const box = document.getElementById('cropperBox');

  function getXY(e) {
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX, y: t.clientY };
  }

  function onPointerDown(e) {
    const handle = e.target.closest('.cropper-handle');
    if (handle) {
      s.resizing = true;
      s.handle = handle.dataset.handle;
    } else if (e.target === box || box.contains(e.target)) {
      s.dragging = true;
    } else return;
    e.preventDefault();
    const p = getXY(e);
    s.startX = p.x; s.startY = p.y;
    s.startBoxX = s.boxX; s.startBoxY = s.boxY;
    s.startBoxW = s.boxW; s.startBoxH = s.boxH;
  }

  function onPointerMove(e) {
    if (!s.dragging && !s.resizing) return;
    e.preventDefault();
    const p = getXY(e);
    const dx = p.x - s.startX;
    const dy = p.y - s.startY;

    if (s.dragging) {
      const minX = s.offsetX, minY = s.offsetY;
      const maxX = s.offsetX + s.dispW - s.boxW;
      const maxY = s.offsetY + s.dispH - s.boxH;
      s.boxX = clamp(s.startBoxX + dx, minX, maxX);
      s.boxY = clamp(s.startBoxY + dy, minY, maxY);
    } else if (s.resizing) {
      const h = s.handle;
      const minX = s.offsetX, minY = s.offsetY;
      const maxX = s.offsetX + s.dispW, maxY = s.offsetY + s.dispH;
      let newX = s.startBoxX, newY = s.startBoxY;
      let newW = s.startBoxW, newH = s.startBoxH;

      if (h === 'br') {
        newW = clamp(s.startBoxW + dx, s.minSize, maxX - s.startBoxX);
        newH = clamp(s.startBoxH + dy, s.minSize, maxY - s.startBoxY);
      } else if (h === 'bl') {
        newW = clamp(s.startBoxW - dx, s.minSize, s.startBoxX + s.startBoxW - minX);
        newH = clamp(s.startBoxH + dy, s.minSize, maxY - s.startBoxY);
        newX = s.startBoxX + s.startBoxW - newW;
      } else if (h === 'tr') {
        newW = clamp(s.startBoxW + dx, s.minSize, maxX - s.startBoxX);
        newH = clamp(s.startBoxH - dy, s.minSize, s.startBoxY + s.startBoxH - minY);
        newY = s.startBoxY + s.startBoxH - newH;
      } else if (h === 'tl') {
        newW = clamp(s.startBoxW - dx, s.minSize, s.startBoxX + s.startBoxW - minX);
        newH = clamp(s.startBoxH - dy, s.minSize, s.startBoxY + s.startBoxH - minY);
        newX = s.startBoxX + s.startBoxW - newW;
        newY = s.startBoxY + s.startBoxH - newH;
      }
      s.boxX = newX; s.boxY = newY;
      s.boxW = newW; s.boxH = newH;
    }
    updateCropperOverlay();
  }

  function onPointerUp() {
    s.dragging = false; s.resizing = false; s.handle = null;
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') onCropperCancel();
    if (e.key === 'Enter') onCropperConfirm();
  }

  s._onPointerDown = onPointerDown;
  s._onPointerMove = onPointerMove;
  s._onPointerUp = onPointerUp;
  s._onKeyDown = onKeyDown;

  box.addEventListener('mousedown', onPointerDown);
  document.addEventListener('mousemove', onPointerMove);
  document.addEventListener('mouseup', onPointerUp);
  box.addEventListener('touchstart', onPointerDown, { passive: false });
  document.addEventListener('touchmove', onPointerMove, { passive: false });
  document.addEventListener('touchend', onPointerUp);
  document.addEventListener('keydown', onKeyDown);
}

function updateCropperOverlay() {
  const s = _cropperState;
  if (!s) return;
  const box = document.getElementById('cropperBox');
  box.style.left = s.boxX + 'px';
  box.style.top = s.boxY + 'px';
  box.style.width = s.boxW + 'px';
  box.style.height = s.boxH + 'px';
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function onCropperConfirm() {
  const s = _cropperState;
  if (!s) return;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(s.boxW / s.scale);
  canvas.height = Math.round(s.boxH / s.scale);
  const ctx = canvas.getContext('2d');
  const sx = Math.round((s.boxX - s.offsetX) / s.scale);
  const sy = Math.round((s.boxY - s.offsetY) / s.scale);
  const sw = Math.round(s.boxW / s.scale);
  const sh = Math.round(s.boxH / s.scale);
  ctx.drawImage(
    document.getElementById('cropperImg'),
    sx, sy, sw, sh,
    0, 0, canvas.width, canvas.height
  );
  const croppedUrl = canvas.toDataURL('image/jpeg', 0.95);
  applyBgImage(croppedUrl);
  renderBgSettings();
  showToast('背景已更新');
  removeCropper();
}

function onCropperCancel() { removeCropper(); }

function removeCropper() {
  const s = _cropperState;
  if (!s) return;
  const box = document.getElementById('cropperBox');
  if (box) {
    box.removeEventListener('mousedown', s._onPointerDown);
    box.removeEventListener('touchstart', s._onPointerDown);
  }
  document.removeEventListener('mousemove', s._onPointerMove);
  document.removeEventListener('mouseup', s._onPointerUp);
  document.removeEventListener('touchmove', s._onPointerMove);
  document.removeEventListener('touchend', s._onPointerUp);
  document.removeEventListener('keydown', s._onKeyDown);
  s.modal.remove();
  _cropperState = null;
}

document.getElementById('bgFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const dataUrl = await compressImage(file);
  // 检测压缩后尺寸是否超过视口
  const img = new Image();
  img.onload = () => {
    if (img.naturalWidth > window.innerWidth || img.naturalHeight > window.innerHeight) {
      openCropper(dataUrl);
    } else {
      applyBgImage(dataUrl);
      renderBgSettings();
      showToast('背景已更新');
    }
  };
  img.src = dataUrl;
  e.target.value = '';
});

document.getElementById('fontFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const formData = new FormData();
    formData.append('font', file);
    const res = await fetch(`${API}/api/font`, { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || '上传失败', 'warning');
      return;
    }
    // Read file as ArrayBuffer and apply directly
    const buffer = await file.arrayBuffer();
    applyCustomFont(data.name, buffer);
  } catch (err) {
    showToast('上传失败: ' + err.message, 'warning');
  }
  e.target.value = '';
});

// ── Ripple effect for buttons ──
document.addEventListener('mousedown', (e) => {
  const btn = e.target.closest('.btn-ghost, .btn-primary, .upload-btn');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width * 100);
  const y = ((e.clientY - rect.top) / rect.height * 100);
  btn.style.setProperty('--ripple-x', x + '%');
  btn.style.setProperty('--ripple-y', y + '%');
  // Button confirm bounce
  btn.classList.remove('btn-confirm');
  void btn.offsetWidth;
  btn.classList.add('btn-confirm');
});

// ── Stat value bump animation ──
function bumpStat(el) {
  el.classList.remove('bump');
  void el.offsetWidth; // force reflow
  el.classList.add('bump');
  el.addEventListener('animationend', () => el.classList.remove('bump'), { once: true });
}

// ── Count bump animation ──
function bumpCount() {
  const el = document.getElementById('historyCount');
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
  el.addEventListener('animationend', () => el.classList.remove('bump'), { once: true });
}

// ── Fetch history from server ──
async function fetchHistory({ skipRender = false } = {}) {
  try {
    const res = await fetch(`${API}/api/history?type=${currentMode}`);
    const data = await res.json();
    state.history = data.history || [];

    // Clear selected file if it no longer exists in history
    if (state.selectedFile && !state.history.find(h => h.id === state.selectedFile)) {
      state.selectedFile = null;
    }

    if (!skipRender) {
      renderHistory(document.getElementById('historySearch').value);
      if (currentView === 'history') renderHistoryPage();
    }
  } catch (e) {
    console.error('Failed to fetch history:', e);
  }
}

// ── Render history ──
function renderSidebarHistoryItem(h, i) {
  const date = h.finishedAt ? h.finishedAt.split('T')[0] : '';
  const isPdfToDocx = h.conversionType === 'pdf_to_docx';
  const isToMarkdown = h.conversionType === 'to_markdown';
  const size = isPdfToDocx ? (h.docxSizeFormatted || h.inputSizeFormatted || '') : isToMarkdown ? (h.markdownSizeFormatted || h.inputSizeFormatted || '') : (h.pdfSizeFormatted || h.inputSizeFormatted || '');
  const isDone = h.status === 'done';
  const isError = h.status === 'error';
  const ext = h.name.split('.').pop().toUpperCase();
  const iconClass = isError ? 'err' : (isPdfToDocx ? 'doc' : isToMarkdown ? 'md' : 'pdf');
  const iconText = isError ? 'ERR' : ext;
  const statusLabel = { done: '已完成', error: '失败', processing: '处理中', pending: '等待中' }[h.status] || h.status;
  const metaSep = '<span class="meta-sep"></span>';
  const metaText = isError
    ? `<span style="color:var(--danger)">${h.error || '转换失败'}</span>`
    : `<span>${size}</span>${metaSep}<span>${date}</span>`;
  const isNew = !renderedHistoryIds.has(h.id);
  if (isNew) renderedHistoryIds.add(h.id);
  const animStyle = isNew
    ? `animation: slide-in-left 0.35s var(--ease-out-expo) ${i * 0.03}s both`
    : '';
  return `
    <div class="history-item ${state.selectedFile === h.id ? 'active' : ''}"
         onclick="selectHistory('${h.id}')" ${animStyle ? `style="${animStyle}"` : ''}>
      <div class="file-icon ${iconClass}">${iconText}</div>
      <div class="file-info">
        <div class="file-name">${h.name}</div>
        <div class="file-meta">${metaText}</div>
      </div>
      ${isDone ? `<button class="qi-btn download" title="下载" onclick="event.stopPropagation();downloadHistoryFile('${h.id}','${h.name}')" style="width:24px;height:24px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>` : ''}
      <button class="qi-btn remove" title="删除" onclick="event.stopPropagation();deleteHistoryItem('${h.id}')" style="width:24px;height:24px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      <div class="status-dot ${h.status}" title="${statusLabel}"></div>
    </div>
  `;
}

function renderHistory(filter = '') {
  const list = document.getElementById('historyList');
  const filtered = (filter
    ? state.history.filter(h => matchesSearch(h, filter))
    : state.history
  ).filter(h => h.status === 'done' || h.status === 'error');

  // [TODO] Sidebar stacking — reserved for future development
  // if (historyStackEnabled && !filter && filtered.length > 0) {
  //   const batches = groupHistoryByBatch(filtered);
  //   list.innerHTML = batches.map((batch, batchIndex) => { ... }).join('');
  // } else {
  //   list.innerHTML = filtered.map((h, i) => renderSidebarHistoryItem(h, i)).join('');
  // }
  list.innerHTML = filtered.map((h, i) => renderSidebarHistoryItem(h, i)).join('');

  document.getElementById('historyCount').textContent = filtered.length;
}

// [TODO] Sidebar stack toggle — reserved for future development
// function toggleSidebarStack(stackId) {
//   const el = document.querySelector(`.sidebar-stack[data-stack-id="${stackId}"]`);
//   if (expandedStacks.has(stackId)) {
//     expandedStacks.delete(stackId);
//     if (el) {
//       el.classList.remove('expanded');
//       el.classList.add('collapsing');
//       setTimeout(() => renderHistory(document.getElementById('historySearch').value), 300);
//     } else {
//       renderHistory(document.getElementById('historySearch').value);
//     }
//   } else {
//     expandedStacks.add(stackId);
//     renderHistory(document.getElementById('historySearch').value);
//   }
// }

function selectHistory(id) {
  state.selectedFile = id;
  renderHistory(document.getElementById('historySearch').value);
  const item = state.history.find(h => h.id === id);
  if (item) {
    const navDone = state.history.filter(h => h.status === 'done');
    const idx = navDone.findIndex(h => h.id === id);
    const isPdfToDocx = item.conversionType === 'pdf_to_docx';
    const isToMarkdown = item.conversionType === 'to_markdown';
    const sizeStr = isPdfToDocx ? (item.docxSizeFormatted || '') : isToMarkdown ? (item.markdownSizeFormatted || '') : (item.pdfSizeFormatted || '');
    showCenterPreview(item.id, item.name, sizeStr, item.pages || 0,
      { list: navDone.map(h => ({
          jobId: h.id, name: h.name,
          pdfSizeFormatted: h.pdfSizeFormatted, pages: h.pages,
          docxSizeFormatted: h.docxSizeFormatted, conversionType: h.conversionType
        })), index: idx,
        conversionType: item.conversionType });
  }
}

// ── PDF Preview ──
const pdfCache = new Map();
window.addEventListener('beforeunload', () => { pdfCache.clear(); });

async function fetchPdfDoc(jobId, retries = 2, customUrl = null) {
  const cacheKey = customUrl || jobId;
  if (pdfCache.has(cacheKey)) return pdfCache.get(cacheKey);
  const url = customUrl || `${API}/api/preview/${jobId}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) {
        if (!customUrl) {
          state.history = state.history.filter(h => h.id !== jobId);
          if (state.selectedFile === jobId) state.selectedFile = null;
        }
        pdfCache.delete(cacheKey);
        throw new Error('PDF not found');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data }).promise;
      pdfCache.set(cacheKey, doc);
      return doc;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

async function renderPdfPreview(jobId, container, { maxPages = 0, thumbWidth = 0, previewUrl = null } = {}) {
  container.style.padding = '0';
  container.style.aspectRatio = 'auto';
  renderSkeletonPreview(container);
  try {
    const doc = await fetchPdfDoc(jobId, 2, previewUrl);
    const totalPages = maxPages > 0 ? Math.min(maxPages, doc.numPages) : doc.numPages;
    const grid = document.createElement('div');
    grid.className = 'preview-thumbs';
    const dpr = window.devicePixelRatio || 1;

    // Auto-calculate display width from container if not provided
    let displayWidth = thumbWidth;
    if (displayWidth <= 0) {
      const cw = container.clientWidth || 280;
      displayWidth = Math.max(120, cw - 32); // minus padding
    }

    for (let i = 1; i <= totalPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const cssScale = displayWidth / vp.width;
      const renderScale = cssScale * dpr;
      const viewport = page.getViewport({ scale: renderScale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      // 使用CSS控制尺寸，而不是固定像素值
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      canvas.style.display = 'block';
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      const item = document.createElement('div');
      item.className = 'thumb-item';
      item.style.animationDelay = `${(i - 1) * 0.05}s`;
      item.appendChild(canvas);
      const badge = document.createElement('span');
      badge.className = 'thumb-page-num';
      badge.textContent = i;
      item.appendChild(badge);
      item.addEventListener('click', () => openPdfLightbox(jobId, i - 1, previewUrl));
      grid.appendChild(item);
    }

    container.innerHTML = '';
    container.appendChild(grid);
  } catch (e) {
    container.innerHTML = `
      <div class="preview-error">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        <p>无法加载 PDF 预览</p>
        <button class="btn-ghost" onclick="retryPreview('${jobId}', this, '${previewUrl || ''}')" style="margin-top:8px">重试</button>
      </div>`;
  }
}

function retryPreview(jobId, btn, previewUrl) {
  const container = btn.closest('.preview-error').parentElement;
  const url = previewUrl || null;
  pdfCache.delete(url || jobId);
  renderPdfPreview(jobId, container, { thumbWidth: parseInt(container.dataset.thumbWidth) || 200, previewUrl: url });
}

// ── Markdown Preview ──
function _mdToHtml(md) {
  let html = '';
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i].replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
        i++;
      }
      i++; // skip closing ```
      html += `<pre><code class="lang-${lang}">${codeLines.join('\n')}</code></pre>\n`;
      continue;
    }
    // Table
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*[-:]+[-|:\s]+\s*\|?\s*$/.test(lines[i + 1])) {
      const parseRow = r => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const headers = parseRow(line);
      i += 2; // skip header + separator
      let tbl = '<table><thead><tr>' + headers.map(h => `<th>${_mdInline(h)}</th>`).join('') + '</tr></thead><tbody>';
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const cells = parseRow(lines[i]);
        tbl += '<tr>' + cells.map(c => `<td>${_mdInline(c)}</td>`).join('') + '</tr>';
        i++;
      }
      tbl += '</tbody></table>\n';
      html += `<div class="table-wrapper">${tbl}</div>`;
      continue;
    }
    // Heading
    const hMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (hMatch) {
      html += `<h${hMatch[1].length}>${_mdInline(hMatch[2])}</h${hMatch[1].length}>\n`;
      i++; continue;
    }
    // Horizontal rule
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
      html += '<hr>\n'; i++; continue;
    }
    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      html += '<ul>\n';
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        html += `<li>${_mdInline(lines[i].replace(/^\s*[-*+]\s+/, ''))}</li>\n`;
        i++;
      }
      html += '</ul>\n';
      continue;
    }
    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      html += '<ol>\n';
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        html += `<li>${_mdInline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>\n`;
        i++;
      }
      html += '</ol>\n';
      continue;
    }
    // Blockquote
    if (/^\s*>/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      html += `<blockquote>${_mdToHtml(quoteLines.join('\n'))}</blockquote>\n`;
      continue;
    }
    // Empty line
    if (!line.trim()) { i++; continue; }
    // Paragraph
    const paraLines = [];
    while (i < lines.length && lines[i].trim() && !lines[i].trimStart().startsWith('#') &&
           !lines[i].trimStart().startsWith('```') && !/^\s*[-*+]\s+/.test(lines[i]) &&
           !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*>/.test(lines[i]) &&
           !/^\s*([-*_])\s*\1\s*\1/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?\s*[-:]+[-|:\s]+\s*\|?\s*$/.test(lines[i+1]))) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      html += `<p>${_mdInline(paraLines.join('\n'))}</p>\n`;
    }
  }
  return html;
}

function _mdInline(text) {
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => {
      if (alt) return `<figure class="md-figure"><img alt="${alt}" src="${src}"><figcaption>${alt}</figcaption></figure>`;
      return `<img alt="" src="${src}" style="max-width:100%;height:auto">`;
    })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

async function renderMarkdownPreview(jobId, container) {
  try {
    const resp = await fetch(`${API}/api/markdown/${jobId}`);
    if (!resp.ok) throw new Error('fetch failed');
    const { content } = await resp.json();
    if (!content) throw new Error('empty');

    // Rewrite image paths: ![alt](filename_media/x.png) → /api/image/{jobId}/filename_media/x.png
    const processed = content.replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (m, alt, src) => {
        if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('/')) return m;
        return `![${alt}](${API}/api/image/${jobId}/${src})`;
      }
    );

    const rendered = _mdToHtml(processed);
    // HTML-escape for raw view display
    const rawEscaped = processed.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const section = document.createElement('div');
    section.className = 'markdown-preview';
    section.dataset.raw = rawEscaped;
    section.dataset.rendered = rendered;
    section.innerHTML = `
      <div class="md-preview-header">
        <span>Markdown 预览</span>
        <div class="md-view-switch">
          <button class="md-view-opt active" onclick="_toggleMdView(this, true)" title="渲染视图">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            渲染
          </button>
          <button class="md-view-opt" onclick="_toggleMdView(this, false)" title="原始 Markdown">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            原始
          </button>
        </div>
        <div class="md-mindmap-btn-group">
          <button class="md-mindmap-btn" onclick="generateMindmap('${jobId}', 'svg')" title="生成 SVG 脑图">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 3v6m0 6v6m-7.8-16.2 5.1 4.3m5.4 4.6 5.1 4.3m-16.2 0 5.1-4.3m5.4-4.6 5.1-4.3"/></svg>
            脑图 SVG
          </button>
          <button class="md-mindmap-btn" onclick="generateMindmap('${jobId}', 'png')" title="生成 PNG 脑图">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            脑图 PNG
          </button>
        </div>
      </div>
      <div class="md-preview-content">${rendered}</div>
      <pre class="md-raw-source">${rawEscaped}</pre>`;
    container.appendChild(section);
  } catch (e) {
    console.warn('Markdown preview failed:', e);
  }
}

function _toggleMdView(btn, isRendered) {
  const section = btn.closest('.markdown-preview');
  if (!section) return;
  const switchEl = btn.closest('.md-view-switch');
  const preview = section.querySelector('.md-preview-content');
  const raw = section.querySelector('.md-raw-source');
  const showRaw = !isRendered;

  // Update segmented control
  switchEl.classList.toggle('raw', showRaw);
  switchEl.querySelectorAll('.md-view-opt').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  // JS-driven crossfade: fade out current → swap display → fade in target
  const current = showRaw ? preview : raw;
  const target = showRaw ? raw : preview;

  current.style.transition = 'opacity 0.15s ease-out';
  current.style.opacity = '0';

  setTimeout(() => {
    current.style.display = 'none';
    current.style.transition = '';
    current.style.opacity = '';

    target.style.display = 'block';
    target.style.opacity = '0';
    target.style.transition = 'opacity 0.2s ease-out';
    // Force reflow
    void target.offsetHeight;
    target.style.opacity = '1';

    setTimeout(() => {
      target.style.transition = '';
    }, 220);
  }, 160);
}

// ── Mindmap Generation ──
let _mindmapCheckCache = null;

async function _checkMindmapAvailability() {
  if (_mindmapCheckCache) return _mindmapCheckCache;
  try {
    const res = await fetch(`${API}/api/mindmap-check`);
    _mindmapCheckCache = await res.json();
  } catch {
    _mindmapCheckCache = { node: false, kmind: false };
  }
  return _mindmapCheckCache;
}

async function generateMindmap(jobId, format) {
  const avail = await _checkMindmapAvailability();
  if (!avail.node) {
    showToast('需要安装 Node.js 才能生成脑图', 'warning');
    return;
  }
  if (!avail.kmind) {
    showToast('脑图模块未找到', 'warning');
    return;
  }

  // Find the matching buttons and set loading state
  const btns = document.querySelectorAll(`.md-mindmap-btn[onclick*="'${jobId}'"]`);
  btns.forEach(b => b.classList.add('generating'));

  const label = format.toUpperCase();
  showToast(`正在生成${label}脑图...`, 'info');

  try {
    const res = await fetch(`${API}/api/mindmap/${jobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || '脑图生成失败', 'error');
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Derive filename from response headers or default
    const disp = res.headers.get('content-disposition') || '';
    const fnMatch = disp.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    a.download = fnMatch ? decodeURIComponent(fnMatch[1]) : `mindmap.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`${label} 脑图已下载`, 'success');
  } catch (e) {
    showToast('脑图生成失败: ' + e.message, 'error');
  } finally {
    btns.forEach(b => b.classList.remove('generating'));
  }
}

async function openPdfLightbox(jobId, startPage = 0, customUrl = null) {
  let doc;
  try { doc = await fetchPdfDoc(jobId, 2, customUrl); } catch { return; }
  const totalPages = doc.numPages;
  let current = startPage;

  // Zoom state
  let zoomLevel = 1;
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 4;
  const ZOOM_STEP = 0.25;

  const overlay = document.createElement('div');
  overlay.className = 'pdf-lightbox';
  document.body.style.overflow = 'hidden';

  const canvasContainer = document.createElement('div');
  canvasContainer.className = 'lb-canvas-container';

  const canvas = document.createElement('canvas');
  canvas.className = 'lb-canvas';
  canvasContainer.appendChild(canvas);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'lb-close';
  closeBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'lb-nav lb-prev';
  prevBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>';

  const nextBtn = document.createElement('button');
  nextBtn.className = 'lb-nav lb-next';
  nextBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>';

  const info = document.createElement('div');
  info.className = 'lb-info';

  // Zoom controls
  const zoomControls = document.createElement('div');
  zoomControls.className = 'lb-zoom-controls';
  zoomControls.innerHTML = `
    <button class="lb-zoom-btn lb-zoom-out" title="缩小 (Ctrl+滚轮向下)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
    <span class="lb-zoom-level">100%</span>
    <button class="lb-zoom-btn lb-zoom-in" title="放大 (Ctrl+滚轮向上)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
    <button class="lb-zoom-btn lb-zoom-reset" title="重置缩放 (Ctrl+0)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
    </button>
  `;

  overlay.append(canvasContainer, closeBtn, prevBtn, nextBtn, info, zoomControls);
  document.body.appendChild(overlay);

  // Show zoom hint for first-time users
  if (!localStorage.getItem('docflow_zoom_hint_shown')) {
    const zoomHint = document.createElement('div');
    zoomHint.className = 'lb-zoom-hint';
    zoomHint.textContent = 'Ctrl+滚轮 缩放 | 双击 快速放大 | Ctrl+0 重置';
    overlay.appendChild(zoomHint);

    // Auto-hide after 3 seconds
    setTimeout(() => {
      zoomHint.style.opacity = '0';
      zoomHint.style.transition = 'opacity 0.3s ease';
      setTimeout(() => zoomHint.remove(), 300);
    }, 3000);

    localStorage.setItem('docflow_zoom_hint_shown', '1');
  }

  function updateZoomUI() {
    const zoomLevelEl = zoomControls.querySelector('.lb-zoom-level');
    zoomLevelEl.textContent = `${Math.round(zoomLevel * 100)}%`;

    // Update canvas transform with pan
    updateCanvasTransform();

    // Update cursor based on zoom level
    if (zoomLevel > 1) {
      canvasContainer.style.cursor = 'grab';
    } else {
      canvasContainer.style.cursor = 'default';
    }
  }

  function setZoom(newZoom) {
    const oldZoom = zoomLevel;
    zoomLevel = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    // Reset pan when zoom level changes significantly
    if (Math.abs(zoomLevel - 1) < 0.1) {
      resetPan();
    }
    // Use animation for large zoom changes
    const zoomDiff = Math.abs(zoomLevel - oldZoom);
    updateCanvasTransform(zoomDiff > 0.5);
    updateZoomUI();
  }

  function zoomIn() {
    setZoom(zoomLevel + ZOOM_STEP);
  }

  function zoomOut() {
    setZoom(zoomLevel - ZOOM_STEP);
  }

  function resetZoom() {
    zoomLevel = 1;
    resetPan();
    updateCanvasTransform(true);
    updateZoomUI();
  }

  async function renderPage(idx) {
    canvas.classList.add('page-exit');
    await new Promise(r => setTimeout(r, 150));
    const page = await doc.getPage(idx + 1);
    const vp = page.getViewport({ scale: 1 });
    const cssScale = Math.min((window.innerWidth * 0.9) / vp.width, (window.innerHeight * 0.82) / vp.height);
    const dpr = window.devicePixelRatio || 1;
    const renderScale = cssScale * dpr;
    const viewport = page.getViewport({ scale: renderScale });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = (vp.width * cssScale) + 'px';
    canvas.style.height = (vp.height * cssScale) + 'px';
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    canvas.classList.remove('page-exit');
    canvas.classList.add('page-enter');
    canvas.addEventListener('animationend', () => canvas.classList.remove('page-enter'), { once: true });
    info.textContent = `${idx + 1} / ${totalPages}`;
    prevBtn.disabled = idx === 0;
    nextBtn.disabled = idx === totalPages - 1;

    // Reset zoom and pan on page change with animation
    zoomLevel = 1;
    panX = 0;
    panY = 0;
    lastPanX = 0;
    lastPanY = 0;
    updateCanvasTransform(true);
    updateZoomUI();
  }

  function close() {
    overlay.classList.add('lb-closing');
    document.body.style.overflow = '';
    setTimeout(() => overlay.remove(), 200);
  }

  // Event listeners
  closeBtn.addEventListener('click', close);
  prevBtn.addEventListener('click', () => { if (current > 0) { current--; renderPage(current); } });
  nextBtn.addEventListener('click', () => { if (current < totalPages - 1) { current++; renderPage(current); } });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Zoom controls
  zoomControls.querySelector('.lb-zoom-in').addEventListener('click', zoomIn);
  zoomControls.querySelector('.lb-zoom-out').addEventListener('click', zoomOut);
  zoomControls.querySelector('.lb-zoom-reset').addEventListener('click', resetZoom);

  // Ctrl + Mouse Wheel zoom
  canvasContainer.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();

      // Calculate zoom direction
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      const newZoom = zoomLevel + delta;

      // Zoom towards mouse position
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const percentX = mouseX / rect.width;
      const percentY = mouseY / rect.height;

      setZoom(newZoom);

      // Adjust transform origin for smooth zoom
      canvas.style.transformOrigin = `${percentX * 100}% ${percentY * 100}%`;
    }
  }, { passive: false });

  // Keyboard shortcuts
  document.addEventListener('keydown', function handler(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', handler);
    }
    if (e.key === 'ArrowLeft' && current > 0) {
      current--;
      renderPage(current);
    }
    if (e.key === 'ArrowRight' && current < totalPages - 1) {
      current++;
      renderPage(current);
    }

    // Zoom keyboard shortcuts (only when Ctrl is held)
    if (e.ctrlKey || e.metaKey) {
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomIn();
      }
      if (e.key === '-') {
        e.preventDefault();
        zoomOut();
      }
      if (e.key === '0') {
        e.preventDefault();
        resetZoom();
      }
    }
  });

  // Double-click to toggle zoom
  canvas.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (zoomLevel === 1) {
      // Zoom to 200% at click position
      const rect = canvas.getBoundingClientRect();
      const percentX = ((e.clientX - rect.left) / rect.width) * 100;
      const percentY = ((e.clientY - rect.top) / rect.height) * 100;
      canvas.style.transformOrigin = `${percentX}% ${percentY}%`;
      setZoom(2);
    } else {
      resetZoom();
    }
  });

  // Pan when zoomed (drag to move)
  let isDragging = false;
  let startX, startY;
  let panX = 0, panY = 0;
  let lastPanX = 0, lastPanY = 0;

  function updateCanvasTransform(animate = false) {
    if (animate) {
      canvas.style.transition = 'transform 0.2s ease-out';
      setTimeout(() => {
        canvas.style.transition = 'transform 0.15s ease-out';
      }, 200);
    }
    canvas.style.transform = `scale(${zoomLevel}) translate(${panX}px, ${panY}px)`;
  }

  function resetPan() {
    panX = 0;
    panY = 0;
    lastPanX = 0;
    lastPanY = 0;
  }

  canvasContainer.addEventListener('mousedown', (e) => {
    if (zoomLevel > 1 && !e.target.closest('button')) {
      isDragging = true;
      canvasContainer.style.cursor = 'grabbing';
      startX = e.clientX;
      startY = e.clientY;
      lastPanX = panX;
      lastPanY = panY;
      e.preventDefault();
    }
  });

  canvasContainer.addEventListener('mousemove', (e) => {
    if (isDragging) {
      const deltaX = (e.clientX - startX) / zoomLevel;
      const deltaY = (e.clientY - startY) / zoomLevel;
      panX = lastPanX + deltaX;
      panY = lastPanY + deltaY;

      // Apply boundary limits
      const containerRect = canvasContainer.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const maxPanX = (canvasRect.width - containerRect.width) / (2 * zoomLevel);
      const maxPanY = (canvasRect.height - containerRect.height) / (2 * zoomLevel);

      panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
      panY = Math.max(-maxPanY, Math.min(maxPanY, panY));

      updateCanvasTransform();
    }
  });

  canvasContainer.addEventListener('mouseup', () => {
    isDragging = false;
    canvasContainer.style.cursor = zoomLevel > 1 ? 'grab' : 'default';
  });

  canvasContainer.addEventListener('mouseleave', () => {
    isDragging = false;
    canvasContainer.style.cursor = zoomLevel > 1 ? 'grab' : 'default';
  });

  // Touch support for mobile devices
  let touchStartX, touchStartY;
  let initialDistance = 0;
  let initialZoom = 1;

  canvasContainer.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1 && zoomLevel > 1) {
      // Single touch for panning
      isDragging = true;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      lastPanX = panX;
      lastPanY = panY;
    } else if (e.touches.length === 2) {
      // Pinch to zoom
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      initialDistance = Math.sqrt(dx * dx + dy * dy);
      initialZoom = zoomLevel;
    }
  }, { passive: true });

  canvasContainer.addEventListener('touchmove', (e) => {
    if (isDragging && e.touches.length === 1) {
      e.preventDefault();
      const deltaX = (e.touches[0].clientX - touchStartX) / zoomLevel;
      const deltaY = (e.touches[0].clientY - touchStartY) / zoomLevel;
      panX = lastPanX + deltaX;
      panY = lastPanY + deltaY;

      // Apply boundary limits
      const containerRect = canvasContainer.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const maxPanX = (canvasRect.width - containerRect.width) / (2 * zoomLevel);
      const maxPanY = (canvasRect.height - containerRect.height) / (2 * zoomLevel);

      panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
      panY = Math.max(-maxPanY, Math.min(maxPanY, panY));

      updateCanvasTransform();
    } else if (e.touches.length === 2) {
      // Pinch zoom
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const scale = distance / initialDistance;
      setZoom(initialZoom * scale);
    }
  }, { passive: false });

  canvasContainer.addEventListener('touchend', () => {
    isDragging = false;
    initialDistance = 0;
  });

  renderPage(current);
}

function selectQueueItem(id) {
  const item = getQueue().find(f => f.id === id);
  if (!item || item.status !== 'done') return;
  const navDone = getQueue().filter(f => f.status === 'done');
  const idx = navDone.findIndex(f => f.id === id);
  const isPdfToDocx = item.conversionType === 'pdf_to_docx';
  const isToMarkdown = item.conversionType === 'to_markdown';
  const sizeStr = isPdfToDocx
    ? (item.docxSize ? formatSize(item.docxSize) : '')
    : isToMarkdown
    ? (item.markdownSize ? formatSize(item.markdownSize) : '')
    : (item.pdfSize ? formatSize(item.pdfSize) : '');
  showCenterPreview(item.jobId, item.name, sizeStr, item.pages || 0,
    { list: navDone.map(f => ({
        jobId: f.jobId, name: f.name,
        pdfSize: f.pdfSize, pages: f.pages, docxSize: f.docxSize,
        markdownSize: f.markdownSize, markdownSizeFormatted: f.markdownSizeFormatted,
        conversionType: f.conversionType
      })), index: idx,
      conversionType: item.conversionType });
}

// ── Center Preview ──
let _previewReturnView = 'convert';
let _currentPreviewJobId = null;
let _currentPreviewConvType = null;
let _previewNavList = [];
let _previewNavIndex = -1;

function renderSkeletonPreview(container) {
  container.innerHTML = `
    <div class="skeleton-preview">
      ${Array.from({length: 6}, () => `
        <div class="skeleton-thumb">
          <div class="skel-line w60"></div>
          <div class="skel-line w100"></div>
          <div class="skel-line w80"></div>
          <div class="skel-line w100"></div>
          <div class="skel-line w55"></div>
        </div>
      `).join('')}
    </div>`;
}

async function showCenterPreview(jobId, name, size, pages, navContext) {
  _previewReturnView = currentView === 'preview' ? _previewReturnView : currentView;
  _currentPreviewJobId = jobId;

  // Determine conversion type
  const convType = (navContext && navContext.conversionType) || 'doc_to_pdf';
  const isPdfToDocx = convType === 'pdf_to_docx';
  const isToMarkdown = convType === 'to_markdown';
  _currentPreviewConvType = convType;
  const outputLabel = isPdfToDocx ? 'DOCX' : isToMarkdown ? 'MD' : 'PDF';

  // Setup nav state
  if (navContext) {
    _previewNavList = navContext.list || [];
    _previewNavIndex = navContext.index != null ? navContext.index : -1;
  } else {
    _previewNavList = [];
    _previewNavIndex = -1;
  }
  _updateNavButtons();

  switchView('preview');
  document.getElementById('previewViewName').textContent = name;
  document.getElementById('previewViewBadge').textContent = outputLabel;

  const meta = document.getElementById('previewViewMeta');
  meta.innerHTML = `
    <div class="preview-meta-row"><span class="label">文件大小</span><span class="value">${size || '—'}</span></div>
    <div class="preview-meta-row"><span class="label">页数</span><span class="value">${pages || '—'}</span></div>
    <div class="preview-meta-row"><span class="label">格式</span><span class="value">${outputLabel}</span></div>
  `;

  // Render source PDF thumbnails, then append markdown preview for to_markdown
  const thumb = document.getElementById('previewViewThumb');
  if (jobId) {
    const previewUrl = isPdfToDocx ? `${API}/api/preview-docx/${jobId}` : null;
    await renderPdfPreview(jobId, thumb, { thumbWidth: 180, previewUrl });
    if (isToMarkdown) {
      await renderMarkdownPreview(jobId, thumb);
    }
  }

  // Fetch fresh metadata
  if (jobId) {
    fetch(`${API}/api/metadata/${jobId}`)
      .then(r => { if (!r.ok) return null; return r.json(); })
      .then(m => {
        if (m) {
          if (isPdfToDocx) {
            meta.innerHTML = `
              <div class="preview-meta-row"><span class="label">文件大小</span><span class="value">${m.sizeFormatted || '—'}</span></div>
              <div class="preview-meta-row"><span class="label">格式</span><span class="value">DOCX</span></div>
            `;
          } else if (isToMarkdown) {
            meta.innerHTML = `
              <div class="preview-meta-row"><span class="label">Markdown 大小</span><span class="value">${m.sizeFormatted || '—'}</span></div>
              ${m.pages ? `<div class="preview-meta-row"><span class="label">源 PDF 页数</span><span class="value">${m.pages}</span></div>` : ''}
              <div class="preview-meta-row"><span class="label">格式</span><span class="value">Markdown</span></div>
            `;
          } else if (m.pages) {
            meta.innerHTML = `
              <div class="preview-meta-row"><span class="label">文件大小</span><span class="value">${m.sizeFormatted}</span></div>
              <div class="preview-meta-row"><span class="label">页数</span><span class="value">${m.pages}</span></div>
              <div class="preview-meta-row"><span class="label">格式</span><span class="value">${m.pdfVersion || 'PDF'}</span></div>
              ${m.title ? `<div class="preview-meta-row"><span class="label">标题</span><span class="value">${m.title}</span></div>` : ''}
            `;
          }
        }
      })
      .catch(() => {});
  }

  // Download button
  const actions = document.getElementById('previewViewActions');
  actions.innerHTML = `
    <div class="pv-actions">
      <button class="btn-primary" onclick="downloadHistoryFile('${jobId}','${name}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        下载 ${outputLabel}
      </button>
    </div>
  `;
  _syncToolbarDownload();

  // Load file-specific settings and bind listeners (only for doc_to_pdf / to_markdown)
  if (!isPdfToDocx) {
    // Snapshot current panel defaults before overwriting
    _panelSettingsSnapshot = getSettings();

    // Load settings from queue item (search all modes)
    let currentItem = null;
    for (const mode of Object.keys(state.queues)) {
      const queue = state.queues[mode] || [];
      currentItem = queue.find(f => f.jobId === jobId);
      if (currentItem) break;
    }

    // Also check localStorage for persisted settings
    const savedSettings = JSON.parse(localStorage.getItem('docflow_file_settings') || '{}');
    const settingsToApply = currentItem?.settings || savedSettings[jobId] || getDefaultSettings(convType);

    console.log('Loading settings for jobId:', jobId, 'Found:', !!currentItem, 'Settings:', settingsToApply);
    applySettings(settingsToApply, true);
    _prevSettings = JSON.parse(JSON.stringify(settingsToApply));
    _bindSettingsListeners();
  }
}

function goBackFromPreview() {
  _currentPreviewJobId = null;
  _unbindSettingsListeners();
  switchView(_previewReturnView);
}

function showDetailPreview(id) {
  const item = state.history.find(h => h.id === id);
  if (!item) return;
  const navDone = state.history.filter(h => h.status === 'done');
  const idx = navDone.findIndex(h => h.id === id);
  const isPdfToDocx = item.conversionType === 'pdf_to_docx';
  const isToMarkdown = item.conversionType === 'to_markdown';
  const sizeStr = isPdfToDocx ? (item.docxSizeFormatted || '') : isToMarkdown ? (item.markdownSizeFormatted || '') : (item.pdfSizeFormatted || '');
  showCenterPreview(item.id, item.name, sizeStr, item.pages || 0,
    { list: navDone.map(h => ({
        jobId: h.id, name: h.name,
        pdfSizeFormatted: h.pdfSizeFormatted, pages: h.pages,
        docxSizeFormatted: h.docxSizeFormatted,
        markdownSizeFormatted: h.markdownSizeFormatted, markdownSize: h.markdownSize,
        conversionType: h.conversionType
      })), index: idx,
      conversionType: item.conversionType });
}

// ── Preview Navigation ──
function _updateNavButtons() {
  const prev = document.getElementById('previewNavPrev');
  const next = document.getElementById('previewNavNext');
  if (!prev || !next) return;
  prev.disabled = _previewNavIndex <= 0;
  next.disabled = _previewNavIndex < 0 || _previewNavIndex >= _previewNavList.length - 1;
}

function previewNavPrev() {
  if (_previewNavIndex <= 0) return;
  _previewNavIndex--;
  _navigateToPreviewItem();
}

function previewNavNext() {
  if (_previewNavIndex >= _previewNavList.length - 1) return;
  _previewNavIndex++;
  _navigateToPreviewItem();
}

async function _navigateToPreviewItem() {
  const item = _previewNavList[_previewNavIndex];
  if (!item) return;
  _currentPreviewJobId = item.jobId || item.id;
  _currentPreviewConvType = item.conversionType || 'doc_to_pdf';
  _updateNavButtons();

  const isPdfToDocx = item.conversionType === 'pdf_to_docx';
  const isToMarkdown = item.conversionType === 'to_markdown';
  const outputLabel = isPdfToDocx ? 'DOCX' : isToMarkdown ? 'MD' : 'PDF';

  document.getElementById('previewViewName').textContent = item.name;
  document.getElementById('previewViewBadge').textContent = outputLabel;
  // Use converted DOCX rendered as PDF for preview
  const previewUrl = isPdfToDocx ? `${API}/api/preview-docx/${_currentPreviewJobId}` : null;
  pdfCache.delete(previewUrl || _currentPreviewJobId);

  const thumb = document.getElementById('previewViewThumb');
  await renderPdfPreview(_currentPreviewJobId, thumb, { thumbWidth: 180, previewUrl });
  if (isToMarkdown) {
    await renderMarkdownPreview(_currentPreviewJobId, thumb);
  }

  // Update metadata
  const meta = document.getElementById('previewViewMeta');
  const sizeStr = isPdfToDocx
    ? (item.docxSizeFormatted || (item.docxSize ? formatSize(item.docxSize) : '—'))
    : isToMarkdown
    ? (item.markdownSizeFormatted || (item.markdownSize ? formatSize(item.markdownSize) : '—'))
    : (item.pdfSizeFormatted || (item.pdfSize ? formatSize(item.pdfSize) : '—'));
  meta.innerHTML = `
    <div class="preview-meta-row"><span class="label">文件大小</span><span class="value">${sizeStr}</span></div>
    <div class="preview-meta-row"><span class="label">格式</span><span class="value">${outputLabel}</span></div>
  `;
  fetch(`${API}/api/metadata/${_currentPreviewJobId}`)
    .then(r => { if (!r.ok) return null; return r.json(); })
    .then(m => {
      if (m) {
        if (isPdfToDocx) {
          meta.innerHTML = `
            <div class="preview-meta-row"><span class="label">文件大小</span><span class="value">${m.sizeFormatted || '—'}</span></div>
            <div class="preview-meta-row"><span class="label">格式</span><span class="value">DOCX</span></div>
          `;
        } else if (isToMarkdown) {
          meta.innerHTML = `
            <div class="preview-meta-row"><span class="label">Markdown 大小</span><span class="value">${m.sizeFormatted || '—'}</span></div>
            ${m.pages ? `<div class="preview-meta-row"><span class="label">源 PDF 页数</span><span class="value">${m.pages}</span></div>` : ''}
            <div class="preview-meta-row"><span class="label">格式</span><span class="value">Markdown</span></div>
          `;
        } else if (m.pages) {
          meta.innerHTML = `
            <div class="preview-meta-row"><span class="label">文件大小</span><span class="value">${m.sizeFormatted}</span></div>
            <div class="preview-meta-row"><span class="label">页数</span><span class="value">${m.pages}</span></div>
            <div class="preview-meta-row"><span class="label">格式</span><span class="value">${m.pdfVersion || 'PDF'}</span></div>
            ${m.title ? `<div class="preview-meta-row"><span class="label">标题</span><span class="value">${m.title}</span></div>` : ''}
          `;
        }
      }
    })
    .catch(() => {});
  // Update download button
  const actions = document.getElementById('previewViewActions');
  actions.innerHTML = `
    <div class="pv-actions">
      <button class="btn-primary" onclick="downloadHistoryFile('${_currentPreviewJobId}','${item.name.replace(/'/g, "\\'")}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        下载 ${outputLabel}
      </button>
    </div>
  `;
  _syncToolbarDownload();

  // Load file-specific settings and bind listeners (only for doc_to_pdf / to_markdown)
  if (!isPdfToDocx) {
    // Unbind listeners before loading new settings to prevent triggering reconvert
    _unbindSettingsListeners();

    // Load settings from queue item (search all modes)
    let currentItem = null;
    for (const mode of Object.keys(state.queues)) {
      const queue = state.queues[mode] || [];
      currentItem = queue.find(f => f.jobId === _currentPreviewJobId);
      if (currentItem) break;
    }

    // Also check localStorage for persisted settings
    const savedSettings = JSON.parse(localStorage.getItem('docflow_file_settings') || '{}');
    const settingsToApply = currentItem?.settings || savedSettings[_currentPreviewJobId] || getDefaultSettings(_currentPreviewConvType);

    applySettings(settingsToApply, true);
    _prevSettings = JSON.parse(JSON.stringify(settingsToApply));
    _bindSettingsListeners();
  }
}

// ── Settings Change → Reconvert ──
let _settingsChangeTimeout = null;
let _settingsListenersBound = false;
let _prevSettings = null;

function _bindSettingsListeners() {
  _unbindSettingsListeners();
  _settingsListenersBound = true;
  document.querySelectorAll('#settingsPanel select[data-key]').forEach(sel => {
    sel._prevReconvertHandler = () => {
      _markSyncedKeyIfManual(sel);
      _savePanelSettings(); _updateActivePresetBadge(); _onSettingsChange();
    };
    sel.addEventListener('change', sel._prevReconvertHandler);
  });
  document.querySelectorAll('#settingsPanel button.toggle[data-key]').forEach(btn => {
    btn._prevReconvertHandler = () => {
      _markSyncedKeyIfManual(btn);
      _savePanelSettings(); _updateActivePresetBadge(); _onSettingsChange();
    };
    btn.addEventListener('click', btn._prevReconvertHandler);
  });
  // Synced section headers: click to toggle fold/unfold
  document.querySelectorAll('#settingsPanel .section-synced-header').forEach(h4 => {
    h4.style.cursor = 'pointer';
    h4._syncedToggleHandler = () => {
      const section = h4.closest('.settings-section');
      if (section) section.classList.toggle('section-folded');
    };
    h4.addEventListener('click', h4._syncedToggleHandler);
  });
}

// Mark a key as manually edited if it's in a synced section (stops sync for that key)
function _markSyncedKeyIfManual(el) {
  if (_isApplyingSettings) return;
  const section = el.closest('.settings-section');
  if (!section || !section.dataset.syncedSection) return;
  const key = el.dataset.key;
  if (!key) return;
  const all = JSON.parse(localStorage.getItem(PANEL_SETTINGS_KEY) || '{}');
  const saved = all[currentMode];
  if (saved && saved._syncedBase) {
    if (!saved._syncedBase.userEdited) saved._syncedBase.userEdited = {};
    saved._syncedBase.userEdited[key] = true;
    localStorage.setItem(PANEL_SETTINGS_KEY, JSON.stringify(all));
  }
  // Remove synced badge and marker so the section no longer appears synced
  section.classList.remove('section-synced');
  delete section.dataset.syncedSection;
  delete section.dataset.syncedBase;
  const badge = section.querySelector('.sync-hint');
  if (badge) badge.remove();
  const h4 = section.querySelector('h4');
  if (h4) {
    h4.classList.remove('section-synced-header');
    h4.style.cursor = '';
    h4.removeAttribute('title');
  }
}

function _unbindSettingsListeners() {
  if (!_settingsListenersBound) return;
  _settingsListenersBound = false;
  document.querySelectorAll('#settingsPanel select[data-key]').forEach(sel => {
    if (sel._prevReconvertHandler) {
      sel.removeEventListener('change', sel._prevReconvertHandler);
      delete sel._prevReconvertHandler;
    }
  });
  document.querySelectorAll('#settingsPanel button.toggle[data-key]').forEach(btn => {
    if (btn._prevReconvertHandler) {
      btn.removeEventListener('click', btn._prevReconvertHandler);
      delete btn._prevReconvertHandler;
    }
  });
  document.querySelectorAll('#settingsPanel .section-synced-header').forEach(h4 => {
    if (h4._syncedToggleHandler) {
      h4.removeEventListener('click', h4._syncedToggleHandler);
      delete h4._syncedToggleHandler;
    }
  });
  if (_settingsChangeTimeout) { clearTimeout(_settingsChangeTimeout); _settingsChangeTimeout = null; }
}

function _onSettingsChange() {
  const settings = getSettings();

  if (_currentPreviewJobId) {
    // Preview view: save to specific queue item
    let currentItem = null;
    for (const mode of Object.keys(state.queues)) {
      const queue = state.queues[mode] || [];
      currentItem = queue.find(f => f.jobId === _currentPreviewJobId);
      if (currentItem) break;
    }
    if (currentItem) {
      currentItem.settings = settings;
      const savedSettings = JSON.parse(localStorage.getItem('docflow_file_settings') || '{}');
      savedSettings[_currentPreviewJobId] = settings;
      localStorage.setItem('docflow_file_settings', JSON.stringify(savedSettings));
    }
  } else {
    // Convert view: update all pending AND processing items in current mode
    const queue = getQueue();
    queue.forEach(item => {
      if (item.status === 'pending' || item.status === 'processing') {
        item.settings = { ...settings };
      }
    });
  }

  // Debounce rapid changes (e.g., toggling multiple settings)
  if (_settingsChangeTimeout) clearTimeout(_settingsChangeTimeout);

  // If a reconvert is already in progress, block and show warning
  if (_reconvertPollId) {
    showToast('当前有任务正在重新生成，设置已保存', 'warning', {
      actions: [
        { label: '自动应用', onClick: (t) => { _pendingReconvertNeeded = true; dismissToast(t); showToast('当前转换完成后将自动应用新设置', 'info'); } },
        { label: '忽略更改', onClick: (t) => {
          _pendingReconvertNeeded = false;
          // Restore previous settings to UI
          if (_prevSettings) { _isApplyingSettings = true; applySettings(_prevSettings); _isApplyingSettings = false; }
          // Revert queue item settings
          for (const mode of Object.keys(state.queues)) {
            const queue = state.queues[mode] || [];
            const item = queue.find(f => f.jobId === _currentPreviewJobId);
            if (item) { item.settings = JSON.parse(JSON.stringify(_prevSettings)); break; }
          }
          // Revert localStorage
          const saved = JSON.parse(localStorage.getItem('docflow_file_settings') || '{}');
          saved[_currentPreviewJobId] = _prevSettings;
          localStorage.setItem('docflow_file_settings', JSON.stringify(saved));
          dismissToast(t);
        } }
      ]
    });
    return;
  }

  // Only trigger reconvert if we're in preview view
  if (_currentPreviewJobId) {
    _settingsChangeTimeout = setTimeout(() => _triggerReconvert(), 600);
  }
}

let _reconvertPollId = null;
let _pendingReconvertNeeded = false;
let _panelSettingsSnapshot = null;

async function _triggerReconvert() {
  const jobId = _currentPreviewJobId;
  if (!jobId) return;
  const isPdfToDocx = _currentPreviewConvType === 'pdf_to_docx';
  const isToMarkdown = _currentPreviewConvType === 'to_markdown';
  // Use converted DOCX rendered as PDF for preview
  const reconvertPreviewUrl = isPdfToDocx ? `${API}/api/preview-docx/${jobId}` : null;
  const outputLabel = isPdfToDocx ? 'DOCX' : isToMarkdown ? 'Markdown' : 'PDF';

  const settings = getSettings();
  // Save as revert target — "忽略更改" will restore to these in-progress settings
  _prevSettings = JSON.parse(JSON.stringify(settings));
  const thumb = document.getElementById('previewViewThumb');
  renderSkeletonPreview(thumb);

  let toastHandle = showToast(`正在重新生成 ${outputLabel}...`, 'info', { progress: 0 });
  // Dismiss any previous reconvert poll
  if (_reconvertPollId) { clearInterval(_reconvertPollId); _reconvertPollId = null; }

  try {
    const res = await fetch(`${API}/api/reconvert/${jobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    const data = await res.json();
    if (!res.ok) {
      if (toastHandle) toastHandle.dismiss();
      showToast(data.error || '重新转换失败', 'error');
      if (jobId === _currentPreviewJobId) {
        renderPdfPreview(jobId, thumb, { thumbWidth: 180, previewUrl: reconvertPreviewUrl });
        if (isToMarkdown) renderMarkdownPreview(jobId, thumb);
      }
      return;
    }
  } catch (e) {
    if (toastHandle) toastHandle.dismiss();
    showToast('请求失败: ' + e.message, 'error');
    if (jobId === _currentPreviewJobId) {
      renderPdfPreview(jobId, thumb, { thumbWidth: 180, previewUrl: reconvertPreviewUrl });
      if (isToMarkdown) renderMarkdownPreview(jobId, thumb);
    }
    return;
  }

  // Poll progress
  const pollStart = Date.now();
  _reconvertPollId = setInterval(async () => {
    try {
      const res = await fetch(`${API}/api/status/${jobId}`);
      const st = await res.json();
      if (st.status === 'done') {
        clearInterval(_reconvertPollId);
        _reconvertPollId = null;
        if (toastHandle) toastHandle.dismiss();
        showToast(`${outputLabel} 重新生成完成`, 'success');
        // Refresh preview
        const cacheKey = reconvertPreviewUrl || jobId;
        pdfCache.delete(cacheKey);
        if (jobId === _currentPreviewJobId) {
          renderPdfPreview(jobId, thumb, { thumbWidth: 180, previewUrl: reconvertPreviewUrl });
          if (isToMarkdown) renderMarkdownPreview(jobId, thumb);
          // Update metadata
          const meta = document.getElementById('previewViewMeta');
          fetch(`${API}/api/metadata/${jobId}`)
            .then(r => { if (!r.ok) return null; return r.json(); })
            .then(m => {
              if (m) {
                if (isToMarkdown) {
                  meta.innerHTML = `
                    <div class="preview-meta-row"><span class="label">Markdown 大小</span><span class="value">${m.sizeFormatted || '—'}</span></div>
                    ${m.pages ? `<div class="preview-meta-row"><span class="label">源 PDF 页数</span><span class="value">${m.pages}</span></div>` : ''}
                    <div class="preview-meta-row"><span class="label">格式</span><span class="value">Markdown</span></div>
                  `;
                } else if (m.pages) {
                  meta.innerHTML = `
                    <div class="preview-meta-row"><span class="label">文件大小</span><span class="value">${m.sizeFormatted}</span></div>
                    <div class="preview-meta-row"><span class="label">页数</span><span class="value">${m.pages}</span></div>
                    <div class="preview-meta-row"><span class="label">格式</span><span class="value">${m.pdfVersion || 'PDF'}</span></div>
                    ${m.title ? `<div class="preview-meta-row"><span class="label">标题</span><span class="value">${m.title}</span></div>` : ''}
                  `;
                }
              }
            })
            .catch(() => {});
        }
        fetchHistory();
        // Auto-trigger reconvert if settings changed during processing
        if (_pendingReconvertNeeded && jobId === _currentPreviewJobId) {
          _pendingReconvertNeeded = false;
          _settingsChangeTimeout = setTimeout(() => _triggerReconvert(), 300);
        } else {
          _pendingReconvertNeeded = false;
        }
      } else if (st.status === 'error') {
        clearInterval(_reconvertPollId);
        _reconvertPollId = null;
        if (toastHandle) toastHandle.dismiss();
        showToast('重新生成失败: ' + (st.error || ''), 'error');
        if (jobId === _currentPreviewJobId) {
          renderPdfPreview(jobId, thumb, { thumbWidth: 180, previewUrl: reconvertPreviewUrl });
          if (isToMarkdown) renderMarkdownPreview(jobId, thumb);
        }
        // Auto-trigger reconvert if settings changed during processing
        if (_pendingReconvertNeeded && jobId === _currentPreviewJobId) {
          _pendingReconvertNeeded = false;
          _settingsChangeTimeout = setTimeout(() => _triggerReconvert(), 300);
        } else {
          _pendingReconvertNeeded = false;
        }
      } else if (st.status === 'processing') {
        if (!toastHandle) {
          toastHandle = showToast(`重新生成中... ${st.progress || 0}%`, 'info', { progress: st.progress || 0 });
        } else {
          toastHandle.update(`重新生成中... ${st.progress || 0}%`, st.progress || 0);
        }
      }
    } catch (e) { /* network error, keep polling */ }
  }, 600);
}

// ── File handling ──
const fileInput = document.getElementById('fileInput');
const uploadZone = document.getElementById('uploadZone');
const dragOverlay = document.getElementById('dragOverlay');

fileInput.addEventListener('change', (e) => {
  addFiles(Array.from(e.target.files));
  fileInput.value = '';
});

// Drag and drop
let dragCounter = 0;
document.addEventListener('dragenter', (e) => {
  if (currentView !== 'convert') return;
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) dragOverlay.classList.add('visible');
});
document.addEventListener('dragleave', (e) => {
  if (currentView !== 'convert') return;
  e.preventDefault();
  dragCounter--;
  if (dragCounter === 0) dragOverlay.classList.remove('visible');
});
document.addEventListener('dragover', (e) => {
  if (currentView !== 'convert') return;
  e.preventDefault();
});
document.addEventListener('drop', (e) => {
  if (currentView !== 'convert') {
    e.preventDefault();
    return;
  }
  e.preventDefault();
  dragCounter = 0;
  dragOverlay.classList.remove('visible');
  const theme = MODE_THEMES[currentMode];
  const files = Array.from(e.dataTransfer.files).filter(f => {
    const lower = f.name.toLowerCase();
    return theme.uploadFormats.some(ext => lower.endsWith(ext));
  });
  if (files.length) addFiles(files);
  else showToast(`仅支持 ${theme.uploadFormats.join(' 和 ')} 文件`, 'warning');
});

async function addFiles(files) {
  const theme = MODE_THEMES[currentMode];
  const valid = files.filter(f => {
    const lower = f.name.toLowerCase();
    return theme.uploadFormats.some(ext => lower.endsWith(ext));
  });
  if (!valid.length) {
    showToast(`未找到有效的 ${theme.uploadFormats.join('/')} 文件`, 'warning');
    return;
  }

  // Upload files to server (with retry for server startup)
  const formData = new FormData();
  valid.forEach(f => formData.append('files', f));
  formData.append('mode', currentMode);

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      showToast('正在上传文件...', 'info');
      const res = await fetch(`${API}/api/upload`, { method: 'POST', body: formData });
      const data = await res.json();

      if (!res.ok) {
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        showToast(data.error || '上传失败', 'warning');
        return;
      }

      // Add returned jobs to queue
      const savedSettings = JSON.parse(localStorage.getItem('docflow_file_settings') || '{}');
      (data.jobs || []).forEach(job => {
        const queueItem = {
          id: state.nextId++,
          jobId: job.id,
          name: job.name,
          size: job.sizeFormatted,
          rawSize: job.size,
          status: 'pending',
          progress: 0,
          pages: 0,
          pdfSize: 0,
          docxSize: 0,
          mode: currentMode,
          conversionType: job.conversionType || 'doc_to_pdf',
          imageAnalysis: job.imageAnalysis || null,
          settings: savedSettings[job.id] || getSettings(),
        };

        // Show image quality recommendation for DOCX files
        if (queueItem.imageAnalysis && queueItem.imageAnalysis.imageCount > 0) {
          const analysis = queueItem.imageAnalysis;
          const hasHighRes = analysis.hasHighResImages;
          const recommendedDpi = analysis.recommendedDpi;

          showToast(
            `检测到 ${analysis.imageCount} 张图片` +
            (hasHighRes ? `（最高 ${analysis.maxWidth}×${analysis.maxHeight}px）` : '') +
            `，建议使用 ${recommendedDpi} DPI` +
            (hasHighRes ? ' 以保留细节' : ''),
            'info',
            { duration: 4000 }
          );

          // Auto-adjust DPI setting if user hasn't manually set it
          if (hasHighRes && recommendedDpi > 300) {
            const dpiSelect = document.querySelector('[data-key="imageDpi"]');
            if (dpiSelect && dpiSelect.value === '300') {
              dpiSelect.value = String(recommendedDpi);
              showToast(`已自动调整图片 DPI 至 ${recommendedDpi}`, 'info');
            }
          }
        }

        getQueue().push(queueItem);
      });

      updateView();
      updateStats();
      renderSettingsPanel();
      _applyPanelSettings();
      _bindSettingsListeners();
      showToast(`已上传 ${data.jobs.length} 个文件，点击"全部转换"开始`, 'success');
      return;
    } catch (e) {
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      showToast('上传失败: ' + e.message, 'warning');
    }
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function updateView() {
  const hasFiles = getQueue().length > 0;
  const uploadZone = document.getElementById('uploadZone');
  const fileQueue = document.getElementById('fileQueue');

  if (hasFiles) {
    uploadZone.style.display = 'none';
    fileQueue.style.display = 'flex';
    fileQueue.classList.add('visible');
  } else {
    fileQueue.classList.remove('visible');
    fileQueue.style.display = 'none';
    uploadZone.style.display = 'flex';
    uploadZone.classList.remove('transitioning-out');
  }

  // Safety net: hide history placeholder when not in history view
  if (currentView !== 'history') {
    const hp = document.getElementById('historyPlaceholder');
    if (hp) hp.style.display = 'none';
  }

  renderQueue();
  updateStats();
}

function renderQueue() {
  const list = document.getElementById('queueList');
  const count = document.getElementById('queueCount');
  count.textContent = `(${getQueue().length})`;
  const pbarStyle = _getProgressBarStyle();
  const queue = getQueue();

  if (!queue.length) {
    const theme = MODE_THEMES[currentMode];
    list.innerHTML = `
      <div class="queue-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <h4>队列中暂无文件</h4>
        <p>${theme.uploadTitle.replace('拖放', '拖放').replace('到此处', '到此处')}或点击浏览</p>
      </div>
    `;
    return;
  }

  // Remove empty state when queue has items
  const emptyEl = list.querySelector('.queue-empty');
  if (emptyEl) emptyEl.remove();

  // Build a map of existing DOM elements by item ID
  const existingEls = {};
  list.querySelectorAll('.queue-item').forEach(el => {
    existingEls[el.dataset.id] = el;
  });

  // Helper: build full queue-item HTML for an item
  function buildItemHTML(item, i) {
    const isDone = item.status === 'done';
    const alreadyAnimated = animatedDoneIds.has(item.id);
    if (isDone && !alreadyAnimated) animatedDoneIds.add(item.id);
    const isPdfToDocx = item.conversionType === 'pdf_to_docx';
    const isToMarkdown = item.conversionType === 'to_markdown';
    const displaySize = isDone
      ? (isPdfToDocx ? (item.docxSize ? formatSize(item.docxSize) : item.size) : isToMarkdown ? (item.markdownSize ? formatSize(item.markdownSize) : item.size) : (item.pdfSize ? formatSize(item.pdfSize) : item.size))
      : item.size;
    const inputExt = item.name.split('.').pop().toUpperCase();
    const outputLabel = isPdfToDocx ? 'DOCX' : isToMarkdown ? 'MD' : 'PDF';
    const iconClass = isPdfToDocx ? 'pdf-to-docx' : isToMarkdown ? 'md' : (item.name.endsWith('.doc') ? 'doc' : 'pdf');
    const isNew = !existingEls[item.id];
    const skipEntryAnim = !isNew || alreadyAnimated;
    const entryStyle = skipEntryAnim
      ? `animation: none; opacity: 1; transform: none`
      : `animation-delay: ${i * 0.05}s`;
    return `
    <div class="queue-item ${item.status}${isDone && alreadyAnimated ? ' no-celebrate' : ''}" data-id="${item.id}" data-status="${item.status}"
         ${isDone ? `onclick="selectQueueItem(${item.id})" style="cursor:pointer;${entryStyle}"` : `style="${entryStyle}"`}>
      <div class="qi-icon ${iconClass}">
        ${inputExt}
      </div>
      <div class="qi-info">
        <div class="qi-name">${item.name}</div>
        <div class="qi-meta">
          <span>${displaySize}</span>
          <span>${inputExt} → ${outputLabel}</span>
          ${item.status === 'done' && !isPdfToDocx && item.pages ? `<span>${item.pages} 页</span>` : ''}
        </div>
      </div>
      ${item.status === 'processing' ? `
        <div class="qi-progress">
          <div class="progress-bar ${pbarStyle} active${[25,50,75,100].includes(item.progress) ? ' milestone' : ''}" data-progress="${item.progress}">
            ${Array.from({length: 9}, (_, j) => {
              const thresholds = [11, 22, 33, 44, 55, 66, 77, 88, 100];
              const filled = item.progress >= thresholds[j] ? ' filled' : '';
              return `<div class="progress-seg${filled}"></div>`;
            }).join('')}
          </div>
          <div class="progress-label">
            <span class="pct-digits">${item.progress}</span><span class="pct-sign">%</span>
          </div>
        </div>
      ` : item.status === 'done' ? `
        <div class="qi-progress">
          <div class="progress-bar ${pbarStyle} complete${alreadyAnimated ? ' no-celebrate' : ''}">
            ${Array.from({length: 9}, () => `<div class="progress-seg filled"></div>`).join('')}
          </div>
          <div class="progress-label">
            <span class="pct-digits">100</span><span class="pct-sign">%</span>
          </div>
        </div>
      ` : item.status === 'error' ? `
        <span class="qi-status error" title="${item.error || ''}">失败</span>
      ` : `
        <span class="qi-status pending">等待中</span>
      `}
      <div class="qi-actions">
        ${item.status === 'done' ? `
          <button class="qi-btn zoom" title="预览${outputLabel}" onclick="event.stopPropagation();selectQueueItem(${item.id})">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
          </button>
          <button class="qi-btn download" title="下载${outputLabel}" onclick="event.stopPropagation();downloadFile(${item.id})">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
        ` : ''}
        <button class="qi-btn remove" title="移除" onclick="event.stopPropagation();removeFromQueue(${item.id})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
  `;
  }

  const frag = document.createDocumentFragment();
  const processedIds = new Set();

  queue.forEach((item, i) => {
    const el = existingEls[item.id];
    const oldStatus = el ? el.dataset.status : null;
    processedIds.add(String(item.id));

    if (!el) {
      // New item — create and append
      const temp = document.createElement('div');
      temp.innerHTML = buildItemHTML(item, i);
      frag.appendChild(temp.firstElementChild);
    } else if (oldStatus !== item.status) {
      // Status changed — replace element (animation restarts for new status)
      el.dataset.status = item.status;
      const temp = document.createElement('div');
      temp.innerHTML = buildItemHTML(item, i);
      el.replaceWith(temp.firstElementChild);
    } else if (item.status === 'processing') {
      // Still processing — update progress in place (no DOM replacement)
      el.dataset.status = item.status;
      const bar = el.querySelector('.progress-bar');
      if (bar) {
        const isMilestone = [25, 50, 75, 100].includes(item.progress);
        bar.dataset.progress = item.progress;
        bar.classList.toggle('milestone', isMilestone);
        const segs = el.querySelectorAll('.progress-seg');
        const thresholds = [11, 22, 33, 44, 55, 66, 77, 88, 100];
        segs.forEach((seg, j) => {
          seg.classList.toggle('filled', item.progress >= thresholds[j]);
        });
        const digits = el.querySelector('.pct-digits');
        if (digits) digits.textContent = item.progress;
      }
    }
    // done/error with no status change — leave DOM untouched (animation plays to completion)
  });

  // Remove items no longer in queue
  Object.keys(existingEls).forEach(id => {
    if (!processedIds.has(id)) existingEls[id].remove();
  });

  list.appendChild(frag);
}

function updateStats() {
  const statFiles = document.getElementById('statFiles');
  const statSize = document.getElementById('statSize');
  const statConverted = document.getElementById('statConverted');

  const prevFiles = statFiles.textContent;
  const prevConverted = statConverted.textContent;
  const prevSize = statSize.textContent;

  statFiles.textContent = getQueue().length;
  const totalSize = getQueue().reduce((s, f) => s + f.rawSize, 0);
  statSize.textContent = formatSize(totalSize);
  statConverted.textContent = getQueue().filter(f => f.status === 'done').length;

  if (prevFiles !== statFiles.textContent) bumpStat(statFiles);
  if (prevSize !== statSize.textContent) bumpStat(statSize);
  if (prevConverted !== statConverted.textContent) bumpStat(statConverted);

  const hasProcessing = getQueue().some(f => f.status === 'processing');
  const hasPending = getQueue().some(f => f.status === 'pending' || f.status === 'error');
  const hasDone = getQueue().some(f => f.status === 'done');
  document.getElementById('convertAllBtn').disabled = hasProcessing || !hasPending;
  document.getElementById('downloadAllBtn').style.display = hasDone ? 'inline-flex' : 'none';
}

// ── Get current settings from the panel ──
function getSettings() {
  const settings = {};
  document.querySelectorAll('#settingsPanel [data-key]').forEach(el => {
    const key = el.dataset.key;
    if (el.tagName === 'SELECT') {
      settings[key] = el.value;
    } else if (el.classList.contains('toggle')) {
      settings[key] = el.classList.contains('on');
    }
  });
  return settings;
}

function getDefaultSettings(mode) {
  const settings = {};
  const config = SETTINGS_CONFIG[mode] || [];
  config.forEach(section => {
    section.settings.forEach(s => {
      if (s.type === 'select') {
        settings[s.key] = s.options[0]; // First option is default
      } else if (s.type === 'toggle') {
        settings[s.key] = s.default !== undefined ? s.default : false;
      }
    });
  });
  return settings;
}

function _adoptDocToPdfSettings() {
  const all = JSON.parse(localStorage.getItem(PANEL_SETTINGS_KEY) || '{}');
  const docToPdfSettings = all['doc_to_pdf'];
  if (!docToPdfSettings || Object.keys(docToPdfSettings).length === 0) {
    showToast('未找到「DOC转PDF」的设置，请先在该模式下配置', 'warning');
    return;
  }
  _isApplyingSettings = true;
  applySettings(docToPdfSettings);
  _isApplyingSettings = false;
  // Update all pending queue items with adopted settings
  const queue = getQueue();
  queue.forEach(item => {
    if (item.status === 'pending') {
      item.settings = { ...docToPdfSettings };
    }
  });
  showToast('已采用「DOC转PDF」的当前设置', 'success');
}

function applySettings(settings, skipSave) {
  document.querySelectorAll('#settingsPanel [data-key]').forEach(el => {
    const key = el.dataset.key;
    if (settings[key] === undefined) return;
    if (el.tagName === 'SELECT') {
      el.value = settings[key];
    } else if (el.classList.contains('toggle')) {
      if (settings[key]) {
        el.classList.add('on');
      } else {
        el.classList.remove('on');
      }
    }
  });
  if (!skipSave) _savePanelSettings();
}

// ── Real conversion via API ──
async function convertAll() {
  const pending = getQueue().filter(f => f.status === 'pending' || f.status === 'error');
  if (!pending.length) return;

  document.getElementById('convertAllBtn').disabled = true;

  // Fire all conversion requests in parallel (with retry for server startup)
  const promises = pending.map(async (item) => {
    // Use file-specific settings, fallback to current UI settings
    const settings = item.settings && Object.keys(item.settings).length > 0
      ? item.settings
      : getSettings();

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const res = await fetch(`${API}/api/convert/${item.jobId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings)
        });
        const data = await res.json();

        if (!res.ok) {
          item.status = 'error';
          item.error = data.error || '转换失败';
          return;
        } else {
          item.status = 'processing';
          item.progress = 0;
          startPolling(item);
          return;
        }
      } catch (e) {
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        item.status = 'error';
        item.error = e.message;
      }
    }
  });

  await Promise.allSettled(promises);
  renderQueue();
  updateStats();
}

function startPolling(item) {
  const itemMode = item.mode || currentMode;
  let progressToast = null;
  let toastShown = false;
  const toastDelay = setTimeout(() => {
    toastShown = true;
    progressToast = showToast(`正在转换 ${item.name}...`, 'info', { progress: 0 });
  }, 2000);

  const intervalId = setInterval(async () => {
    try {
      const res = await fetch(`${API}/api/status/${item.jobId}`);
      const data = await res.json();

      item.progress = data.progress || 0;
      item.status = data.status;

      // Update progress toast
      if (toastShown && progressToast && data.status === 'processing') {
        progressToast.update(`正在转换 ${item.name}... ${data.progress || 0}%`, data.progress || 0);
      }

      if (data.status === 'done') {
        item.progress = 100;
        if (data.conversionType === 'pdf_to_docx') {
          item.docxSize = data.docxSize;
        } else if (data.conversionType === 'to_markdown') {
          item.markdownSize = data.markdownSize;
        } else {
          item.pages = data.pages;
          item.pdfSize = data.pdfSize;
        }
        clearInterval(intervalId);
        delete state.polling[item.jobId];
        clearTimeout(toastDelay);
        if (progressToast) progressToast.dismiss();
        showToast(`${item.name} 转换成功`, 'success');
        bumpCount();
        fetchHistory();

        // Auto-download if enabled (check item settings, fallback to panel state)
        const itemSettings = item.settings || {};
        const panelSettings = getSettings();
        const autoDownload = itemSettings.autoDownload !== undefined
          ? itemSettings.autoDownload
          : panelSettings.autoDownload;
        if (autoDownload !== false) {
          downloadFile(item.id);
        }
        // Auto-switch back to convert view if no more processing in the job's mode
        const jobQueue = state.queues[itemMode] || [];
        if (!jobQueue.some(f => f.status === 'processing')) {
          if (_autoReturnToConvert && currentView !== 'convert' && itemMode === currentMode) switchView('convert');
          _autoReturnToConvert = false;
        }
        // Re-render the job's mode queue if it's not the current mode
        if (itemMode !== currentMode) {
          // Queue re-render will happen when user switches back
        } else {
          renderQueue();
        }
        updateStats();
      } else if (data.status === 'error') {
        item.error = data.error;
        clearInterval(intervalId);
        delete state.polling[item.jobId];
        clearTimeout(toastDelay);
        if (progressToast) progressToast.dismiss();
        showToast(`${item.name} 转换失败`, 'error');
        // Auto-switch back to convert view if no more processing in the job's mode
        const jobQueue = state.queues[itemMode] || [];
        if (!jobQueue.some(f => f.status === 'processing')) {
          if (_autoReturnToConvert && currentView !== 'convert' && itemMode === currentMode) switchView('convert');
          _autoReturnToConvert = false;
        }
        if (itemMode === currentMode) {
          renderQueue();
        }
        updateStats();
      } else {
        // Still processing — render queue for the job's mode
        if (itemMode === currentMode) {
          renderQueue();
          updateStats();
        }
      }
    } catch (e) {
      // Network error — keep polling
    }
  }, 600);

  state.polling[item.jobId] = intervalId;
}

function removeFromQueue(id) {
  const item = getQueue().find(f => f.id === id);

  // Stop polling if active
  if (item && item.jobId && state.polling[item.jobId]) {
    clearInterval(state.polling[item.jobId]);
    delete state.polling[item.jobId];
  }

  // Delete server-side files if conversion is done
  if (item && item.jobId && item.status === 'done') {
    fetch(`${API}/api/history/${item.jobId}`, { method: 'DELETE' }).catch(() => {});
  }

  // Remove from state and update UI immediately
  state.queues[currentMode] = getQueue().filter(f => f.id !== id);

  const el = document.querySelector(`.queue-item[data-id="${id}"]`);
  if (el) {
    el.classList.add('removing');
    // Fallback: ensure removal even if animation doesn't fire
    const cleanup = () => { if (el.parentNode) el.remove(); };
    el.addEventListener('animationend', cleanup, { once: true });
    setTimeout(cleanup, 400);
  }

  updateView();
  if (currentMode === 'to_markdown') {
    renderSettingsPanel();
    _applyPanelSettings();
    _bindSettingsListeners();
  }
}

async function clearQueue() {
  // Stop all polling
  Object.values(state.polling).forEach(id => clearInterval(id));
  state.polling = {};
  animatedDoneIds.clear();
  dismissAllToasts();

  // Only stop polling for current mode's items
  const currentJobIds = new Set(getQueue().filter(f => f.jobId).map(f => f.jobId));
  currentJobIds.forEach(jid => {
    if (state.polling[jid]) { clearInterval(state.polling[jid]); delete state.polling[jid]; }
  });

  const items = document.querySelectorAll('.queue-item');
  items.forEach((el, i) => {
    el.style.animation = `queue-item-out 0.3s var(--ease-out-expo) ${i * 0.04}s forwards`;
  });
  const totalDelay = items.length * 0.04 + 0.3;
  setTimeout(() => {
    state.queues[currentMode] = [];
    updateView();
    if (currentMode === 'to_markdown') {
      renderSettingsPanel();
      _applyPanelSettings();
      _bindSettingsListeners();
    }
  }, totalDelay * 1000);
}

async function downloadFile(id) {
  const item = getQueue().find(f => f.id === id);
  if (!item || !item.jobId) return;

  const isPdfToDocx = item.conversionType === 'pdf_to_docx';
  const isToMarkdown = item.conversionType === 'to_markdown';
  const outputExt = isPdfToDocx ? '.docx' : isToMarkdown ? '.zip' : '.pdf';
  const downloadName = item.name.replace(/\.(doc|docx|pdf)$/i, outputExt);

  try {
    showToast(`正在下载 ${downloadName}...`, 'info');
    const res = await fetch(`${API}/api/download/${item.jobId}`);
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || '下载失败', 'warning');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('下载已开始', 'success');
  } catch (e) {
    showToast('下载失败: ' + e.message, 'warning');
  }
}

// ── Nav switching ──
let currentView = 'convert';
let _panelCollapsed = false;
let _autoReturnToConvert = false;

const VIEW_ORDER = ['convert', 'history', 'preview'];

function switchView(viewName) {
  if (viewName === currentView) return;

  const prevView = currentView;

  // Cleanup when leaving preview
  if (currentView === 'preview') {
    _currentPreviewJobId = null;
    _currentPreviewConvType = null;
    _unbindSettingsListeners();
    _pendingReconvertNeeded = false;
    if (_reconvertPollId) { clearInterval(_reconvertPollId); _reconvertPollId = null; }
    // Restore panel defaults that were snapshotted before entering preview
    if (_panelSettingsSnapshot) {
      _isApplyingSettings = true;
      applySettings(_panelSettingsSnapshot);
      _isApplyingSettings = false;
      _panelSettingsSnapshot = null;
    }
    // Reset sidebar collapse state
    _panelCollapsed = false;
    const sb = document.getElementById('previewViewSidebar');
    if (sb) { sb.classList.remove('collapsed'); }
    const body = sb?.closest('.preview-view-body');
    if (body) { body.style.gridTemplateColumns = ''; }
    const expBtn = document.getElementById('sidebarExpandBtn');
    if (expBtn) { expBtn.classList.add('hidden'); }
  }

  currentView = viewName;

  // Update nav buttons and slide indicator
  document.querySelectorAll('.topbar-nav button').forEach(b => {
    b.classList.toggle('active', b.dataset.view === viewName);
  });
  updateNavRefraction();

  // Animate current view out, then show target
  const currentEl = document.getElementById(prevView + 'View');
  const targetId = viewName + 'View';
  const target = document.getElementById(targetId);

  function showTarget() {
    document.querySelectorAll('.view-container').forEach(v => {
      v.classList.add('hidden');
      v.classList.remove('view-enter', 'view-exit');
    });
    if (target) {
      target.classList.remove('hidden');
      void target.offsetWidth;
      target.classList.add('view-enter');
    }
    // Ensure history page DOM is fresh when switching to it
    if (viewName === 'history') {
      lastHistoryPageHash = '';
      renderHistoryPage();
    }
  }

  if (currentEl && !currentEl.classList.contains('hidden')) {
    currentEl.classList.remove('view-enter');
    void currentEl.offsetWidth;
    currentEl.classList.add('view-exit');
    currentEl.addEventListener('animationend', function handler() {
      currentEl.removeEventListener('animationend', handler);
      showTarget();
    });
  } else {
    showTarget();
  }

  updateLayout();
  _syncToolbarDownload();

  // Auto-switch back to convert view when background conversions finish
  // Don't set when entering preview — user is deliberately viewing content
  if (viewName !== 'convert' && viewName !== 'preview' && getQueue().some(f => f.status === 'processing')) {
    _autoReturnToConvert = true;
  }
  if (viewName === 'convert' || viewName === 'preview') {
    _autoReturnToConvert = false;
  }
}

function toggleSidebarCollapse() {
  _panelCollapsed = !_panelCollapsed;
  const sidebar = document.getElementById('previewViewSidebar');
  const expandBtn = document.getElementById('sidebarExpandBtn');
  if (sidebar) {
    sidebar.classList.toggle('collapsed', _panelCollapsed);
    const body = sidebar.closest('.preview-view-body');
    if (body) {
      body.style.gridTemplateColumns = _panelCollapsed ? '1fr 0px' : '';
    }
  }
  if (expandBtn) {
    expandBtn.classList.toggle('hidden', !_panelCollapsed);
  }
  _syncToolbarDownload();
}

function _syncToolbarDownload() {
  const previewBtn = document.getElementById('toolbarDownloadBtn');
  const historyBtn = document.getElementById('historyToolbarDownloadBtn');
  const isPreview = currentView === 'preview';
  const isHistory = currentView === 'history';
  const sidebarCollapsed = _panelCollapsed;
  const dlSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

  function syncBtn(btn, shouldShow) {
    if (!btn) return;
    const isCurrentlyHidden = btn.style.display === 'none';
    if (shouldShow) {
      btn.classList.remove('hidden');
      if (btn.classList.contains('anim-exit')) {
        btn.classList.remove('anim-exit');
        btn.style.display = '';
      }
      if (isCurrentlyHidden) {
        btn.style.display = '';
        btn.classList.add('anim-enter');
      }
    } else {
      if (isCurrentlyHidden) return;
      if (btn.classList.contains('anim-exit')) return;
      btn.classList.remove('anim-enter');
      btn.classList.add('anim-exit');
      btn.addEventListener('animationend', function handler() {
        btn.removeEventListener('animationend', handler);
        btn.style.display = 'none';
        btn.classList.remove('anim-exit');
        btn.classList.add('hidden');
      });
    }
  }

  // Preview toolbar download
  if (previewBtn) {
    const showPreview = sidebarCollapsed && isPreview && _currentPreviewJobId;
    if (showPreview) {
      const isPdfToDocx = _currentPreviewConvType === 'pdf_to_docx';
      const isToMd = _currentPreviewConvType === 'to_markdown';
      const label = isPdfToDocx ? 'DOCX' : isToMd ? 'MD' : 'PDF';
      let itemName = '';
      if (_previewNavList[_previewNavIndex]) {
        itemName = _previewNavList[_previewNavIndex].name || '';
      }
      previewBtn.className = 'btn-primary toolbar-download-btn';
      previewBtn.innerHTML = `${dlSvg} 下载 ${label}`;
      previewBtn.onclick = () => downloadHistoryFile(_currentPreviewJobId, itemName);
    }
    syncBtn(previewBtn, showPreview);
  }

  // History toolbar download
  if (historyBtn) {
    const showHistory = sidebarCollapsed && isHistory && _currentPreviewJobId;
    if (showHistory) {
      const isPdfToDocx = _currentPreviewConvType === 'pdf_to_docx';
      const isToMd = _currentPreviewConvType === 'to_markdown';
      const label = isPdfToDocx ? 'DOCX' : isToMd ? 'MD' : 'PDF';
      let itemName = '';
      if (_previewNavList[_previewNavIndex]) {
        itemName = _previewNavList[_previewNavIndex].name || '';
      }
      historyBtn.className = 'btn-primary toolbar-download-btn';
      historyBtn.innerHTML = `${dlSvg} 下载 ${label}`;
      historyBtn.onclick = () => downloadHistoryFile(_currentPreviewJobId, itemName);
    }
    syncBtn(historyBtn, showHistory);
  }
}

function updateLayout() {
  const sidebar = document.querySelector('.sidebar');
  const panel = document.querySelector('.panel');
  const panelContent = document.getElementById('panelContent');
  const historyPanel = document.getElementById('historyDetailPanel');
  const settingsPanel = document.getElementById('settingsPanel');

  const showHistory = currentView === 'history';
  const showSettings = currentView === 'convert' || currentView === 'preview';

  if (showHistory) {
    sidebar.style.display = 'none';
    panel.style.display = 'flex';
    document.querySelector('.app').style.gridTemplateColumns = '1fr 340px';
    document.querySelector('.app').classList.add('no-sidebar');
  } else if (currentView === 'preview') {
    sidebar.style.display = 'none';
    panel.style.display = 'flex';
    document.querySelector('.app').style.gridTemplateColumns = '1fr 340px';
    document.querySelector('.app').classList.add('no-sidebar');
  } else {
    sidebar.style.display = '';
    panel.style.display = '';
    document.querySelector('.app').style.gridTemplateColumns = '';
    document.querySelector('.app').classList.remove('no-sidebar');
  }

  // Crossfade panel content
  panelContent.classList.remove('panel-fade-in', 'panel-fade-out');
  void panelContent.offsetWidth;
  panelContent.classList.add('panel-fade-out');

  // Set panel visibility and render history page immediately (don't wait for animation)
  historyPanel.style.display = showHistory ? 'block' : 'none';
  settingsPanel.style.display = showSettings ? 'block' : 'none';
  const historyPlaceholder = document.getElementById('historyPlaceholder');
  if (historyPlaceholder) {
    historyPlaceholder.style.display = showHistory && !state.selectedFile ? 'block' : 'none';
  }
  if (showHistory) {
    lastHistoryPageHash = '';
    renderHistoryPage();
  }

  panelContent.addEventListener('animationend', function handler() {
    panelContent.removeEventListener('animationend', handler);

    panelContent.classList.remove('panel-fade-out');
    void panelContent.offsetWidth;
    panelContent.classList.add('panel-fade-in');
  });
}

document.querySelectorAll('.topbar-nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    switchView(btn.dataset.view);
  });
});

function updateNavRefraction() {
  const nav = document.getElementById('topbarNav');
  const slider = document.getElementById('navRefraction');
  if (!nav || !slider) return;
  const activeBtn = nav.querySelector(`button[data-view="${currentView}"]`);
  if (!activeBtn) return;
  const navRect = nav.getBoundingClientRect();
  const btnRect = activeBtn.getBoundingClientRect();
  slider.style.width = btnRect.width + 'px';
  slider.style.transform = `translateX(${btnRect.left - navRect.left - 3}px)`;
}
updateNavRefraction();

// ── Toast system ──
const _toastDedup = new Map();
const _toastMaxVisible = 5;

function showToast(message, type = 'info', options = {}) {
  const container = document.getElementById('toastContainer');
  const icons = {
    success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    warning: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };

  // Dedup: skip identical message within 2s
  const dedupKey = `${type}:${message}`;
  if (_toastDedup.has(dedupKey)) return;
  _toastDedup.set(dedupKey, true);
  setTimeout(() => _toastDedup.delete(dedupKey), 2000);

  // Enforce max visible limit
  const existing = container.querySelectorAll('.toast:not(.leaving)');
  if (existing.length >= _toastMaxVisible) {
    dismissToast(existing[0]);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const hasProgress = options.progress != null;
  const hasActions = Array.isArray(options.actions) && options.actions.length > 0;
  const actionsHtml = hasActions
    ? `<div class="toast-actions">${options.actions.map((a, i) => `<button class="toast-action-btn" data-action-idx="${i}">${a.label}</button>`).join('')}</div>`
    : '';
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <span class="toast-msg">${message}</span>
    ${actionsHtml}
    ${hasProgress ? `<div class="toast-progress-bar" style="width:${options.progress}%"></div>` : ''}
    <button class="toast-dismiss" onclick="event.stopPropagation();dismissToast(this.parentElement)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;
  if (!hasActions) toast.addEventListener('click', () => dismissToast(toast));
  container.appendChild(toast);

  // Bind action buttons
  if (hasActions) {
    options.actions.forEach((a, i) => {
      const btn = toast.querySelector(`[data-action-idx="${i}"]`);
      if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); a.onClick(toast); });
    });
  }

  // Auto-dismiss after 3s (unless progress or action toast)
  if (!hasProgress && !hasActions) {
    setTimeout(() => dismissToast(toast), 3000);
  }

  // Return handle for progress toasts
  if (hasProgress) {
    return {
      update(msg, pct) {
        const msgEl = toast.querySelector('.toast-msg');
        if (msgEl) msgEl.textContent = msg;
        const bar = toast.querySelector('.toast-progress-bar');
        if (bar) bar.style.width = `${pct}%`;
      },
      dismiss() { dismissToast(toast); }
    };
  }
}

function dismissToast(toast) {
  if (!toast || toast.classList.contains('leaving')) return;
  toast.classList.add('leaving');
  setTimeout(() => toast.remove(), 350);
}

function dismissAllToasts() {
  document.querySelectorAll('.toast:not(.leaving)').forEach(t => dismissToast(t));
}

// ── Convert Mini-Toast ──
// ── Keyboard shortcuts ──
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    dragOverlay.classList.remove('visible');
    dragCounter = 0;
  }
});

// ── History search ──
document.getElementById('historySearch').addEventListener('input', (e) => {
  renderHistory(e.target.value);
});

// ── Clear all history ──
async function clearAllHistory() {
  const modeLabel = currentMode === 'pdf_to_docx' ? 'PDF → DOCX' : 'DOC → PDF';
  if (!confirm(`确定要清除「${modeLabel}」的所有历史记录吗？此操作不可撤销。`)) return;

  const sidebarList = document.getElementById('historyList');
  const pageList = document.getElementById('historyPageList');
  const sidebarBtn = document.querySelector('.sidebar-clear-btn');
  const pageBtn = document.getElementById('historyPageClearBtn');

  // Collect items from whichever view is visible
  const sidebarItems = sidebarList.querySelectorAll('.history-item');
  const pageItems = pageList.querySelectorAll('.history-card, .history-stack');
  const allItems = [...sidebarItems, ...pageItems];

  if (allItems.length > 0) {
    if (sidebarBtn) sidebarBtn.classList.add('clearing');
    if (pageBtn) pageBtn.classList.add('clearing');
    const delay = Math.min(40, 600 / allItems.length);
    allItems.forEach((item, i) => {
      // Measure height for collapse animation
      const rect = item.getBoundingClientRect();
      item.style.setProperty('--h', rect.height + 'px');
      item.style.animationDelay = `${i * delay}ms`;
      item.style.animationDuration = '0.35s';
      item.style.animationTimingFunction = 'var(--ease-out-expo)';
      item.style.animationFillMode = 'forwards';
      item.style.transition = 'none';
      item.style.pointerEvents = 'none';
      const isCard = item.classList.contains('history-card') || item.classList.contains('history-stack');
      item.style.animationName = isCard ? 'card-clear-sweep' : 'clear-sweep';
    });
    await new Promise(r => setTimeout(r, allItems.length * delay + 370));
    if (sidebarBtn) sidebarBtn.classList.remove('clearing');
    if (pageBtn) pageBtn.classList.remove('clearing');
  }

  try {
    const res = await fetch(`${API}/api/history?type=${currentMode}`, { method: 'DELETE' });
    if (res.ok) {
      state.history = [];
      state.selectedFile = null;
      manualGroups.clear();
      groupNames.clear();
      groupCounter = 0;
      renderedHistoryIds.clear();
      lastHistoryPageHash = '';
      renderHistory();
      renderHistoryPage();

      showToast('历史记录已清除', 'success');
    }
  } catch (e) {
    showToast('清除失败: ' + e.message, 'warning');
  }
}

// ── Download from history sidebar ──
async function downloadHistoryFile(jobId, name) {
  try {
    const res = await fetch(`${API}/api/download/${jobId}`);
    if (res.status === 404) {
      showToast('文件不存在，可能已被删除', 'warning');
      state.history = state.history.filter(h => h.id !== jobId);
      renderHistory(document.getElementById('historySearch').value);
      if (currentView === 'history') renderHistoryPage();
      return;
    }
    if (!res.ok) { showToast('下载失败', 'warning'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Let browser use Content-Disposition header from server for correct filename
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    showToast('下载失败: ' + e.message, 'warning');
  }
}

// ── Download all completed PDFs as ZIP ──
async function downloadAll() {
  const doneCount = getQueue().filter(f => f.status === 'done').length;
  if (!doneCount) return;

  showToast(`正在打包 ${doneCount} 个文件...`, 'info');
  try {
    const res = await fetch(`${API}/api/download-all?type=${currentMode}`);
    if (!res.ok) { showToast('打包下载失败', 'warning'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'docflow_batch.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('打包下载已开始', 'success');
  } catch (e) {
    showToast('下载失败: ' + e.message, 'warning');
  }
}


// ── History Page Rendering ──
let historyFilter = 'all';
let historySearchQuery = '';

function filterHistoryPage(status) {
  historyFilter = status;
  document.querySelectorAll('.history-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === status);
  });
  renderHistoryPage();
}

// Alias for inline onclick
window.filterHistory = filterHistoryPage;

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const now = new Date();
  const date = new Date(dateStr);
  const diff = Math.floor((now - date) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  if (diff < 604800) return Math.floor(diff / 86400) + '天前';
  return dateStr.split('T')[0];
}

function clearHistorySearch() {
  document.getElementById('historyPageSearch').value = '';
  historySearchQuery = '';
  document.getElementById('historySearchClear').classList.remove('visible');
  renderHistoryPage();
}

// ── History Stack Functions ──

function toggleHistoryStack() {
  historyStackEnabled = !historyStackEnabled;
  const btn = document.getElementById('stackToggleBtn');
  const text = document.getElementById('stackToggleText');
  if (historyStackEnabled) {
    btn.classList.add('active');
    btn.style.background = 'var(--accent-light)';
    btn.style.color = 'var(--accent)';
    btn.style.borderColor = 'var(--accent)';
    text.textContent = '堆叠中';
  } else {
    btn.classList.remove('active');
    btn.style.background = '';
    btn.style.color = '';
    btn.style.borderColor = '';
    text.textContent = '堆叠';
    expandedStacks.clear();
  }
  renderHistoryPage();
}

function toggleStackExpand(stackId) {
  const isExpanding = !expandedStacks.has(stackId);

  if (isExpanding) {
    expandedStacks.add(stackId);
  } else {
    expandedStacks.delete(stackId);
  }

  // Always do a clean innerHTML re-render — avoids stale inline styles
  // (e.g. folder.style.display from a previous expand) conflicting with
  // CSS animations after view-switch DOM regeneration.
  lastHistoryPageHash = '';
  renderHistoryPage();
}

// ── Stack Rename Functions ──

function startRenameStack(el) {
  el.contentEditable = 'true';
  el.focus();
  // Select all text
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function finishRenameStack(el) {
  el.contentEditable = 'false';
  const stackId = el.dataset.stackId;
  const newName = el.textContent.trim();
  if (newName) {
    stackNames.set(stackId, newName);
  } else {
    // Revert to default if empty
    el.textContent = stackNames.get(stackId) || `转换批次 ${stackId.replace('stack-', '')}`;
    stackNames.delete(stackId);
  }
}

function handleRenameKeydown(e, el) {
  if (e.key === 'Enter') {
    e.preventDefault();
    el.blur();
  } else if (e.key === 'Escape') {
    const stackId = el.dataset.stackId;
    el.textContent = stackNames.get(stackId) || `转换批次 ${stackId.replace('stack-', '')}`;
    el.blur();
  }
}

function groupHistoryByBatch(historyItems) {
  if (!historyItems.length) return [];

  // Separate items with manual groupId from ungrouped
  const grouped = new Map(); // groupId → [items]
  const ungrouped = [];

  historyItems.forEach(h => {
    if (h.groupId && manualGroups.has(h.groupId)) {
      if (!grouped.has(h.groupId)) grouped.set(h.groupId, []);
      grouped.get(h.groupId).push(h);
    } else {
      ungrouped.push(h);
    }
  });

  const batches = [];

  // Manual groups first (sorted by most recent item)
  const sortedGroupIds = [...grouped.keys()].sort((a, b) => {
    const aTime = new Date(grouped.get(a)[0].finishedAt || 0).getTime();
    const bTime = new Date(grouped.get(b)[0].finishedAt || 0).getTime();
    return bTime - aTime;
  });
  sortedGroupIds.forEach(gid => {
    batches.push(grouped.get(gid));
  });

  // Time-based batching for ungrouped items
  if (ungrouped.length) {
    const sorted = [...ungrouped].sort((a, b) => {
      const timeA = a.finishedAt ? new Date(a.finishedAt).getTime() : 0;
      const timeB = b.finishedAt ? new Date(b.finishedAt).getTime() : 0;
      return timeB - timeA;
    });
    let currentBatch = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const prevTime = new Date(sorted[i - 1].finishedAt || 0).getTime();
      const currTime = new Date(sorted[i].finishedAt || 0).getTime();
      if (prevTime - currTime <= BATCH_TIME_WINDOW) {
        currentBatch.push(sorted[i]);
      } else {
        batches.push(currentBatch);
        currentBatch = [sorted[i]];
      }
    }
    batches.push(currentBatch);
  }

  return batches;
}

function formatStackTime(items) {
  if (!items.length) return '';
  const latest = items[0].finishedAt;
  if (!latest) return '';
  return timeAgo(latest);
}

function renderHistoryPage() {
  const list = document.getElementById('historyPageList');
  let filtered = state.history;

  if (historyFilter !== 'all') {
    filtered = filtered.filter(h => h.status === historyFilter);
  }
  if (historySearchQuery) {
    filtered = filtered.filter(h => matchesSearch(h, historySearchQuery));
  }

  // Update stats
  const total = state.history.length;
  const doneCount = state.history.filter(h => h.status === 'done').length;
  const errorCount = state.history.filter(h => h.status === 'error').length;
  const rate = total > 0 ? Math.round(doneCount / total * 100) : 0;
  const totalSize = state.history.reduce((s, h) => s + (h.inputSize || 0), 0);

  // 统计栏已移除，只更新标题计数
  document.getElementById('historyTitleCount').textContent = total;

  // Update filter counts
  document.getElementById('filterCountAll').textContent = total;
  document.getElementById('filterCountDone').textContent = doneCount;
  document.getElementById('filterCountError').textContent = errorCount;

  // Update search clear button visibility
  const clearBtn = document.getElementById('historySearchClear');
  if (clearBtn) clearBtn.classList.toggle('visible', !!historySearchQuery);

  // Skip card list re-render if data hasn't changed (prevents backdrop-filter flicker)
  const dataHash = filtered.map(h => `${h.id}:${h.status}:${h.pages || 0}:${h.groupId || ''}`).join('|')
    + `#${historyFilter}#${historySearchQuery}#${state.selectedFile}#${historyStackEnabled}#${[...expandedStacks].join(',')}`;
  if (dataHash === lastHistoryPageHash) return;
  lastHistoryPageHash = dataHash;

  if (!filtered.length) {
    list.innerHTML = `
      <div class="history-empty">
        <div class="empty-icon">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <h4>${historySearchQuery || historyFilter !== 'all' ? '没有匹配的记录' : '暂无转换历史'}</h4>
        <p>${historySearchQuery || historyFilter !== 'all' ? '尝试调整搜索或筛选条件' : '完成文件转换后，记录将显示在这里'}</p>
      </div>
    `;
    return;
  }

  // If stacking is enabled, group by batch
  if (historyStackEnabled && !historySearchQuery) {
    const batches = groupHistoryByBatch(filtered);
    list.innerHTML = batches.map((batch, batchIndex) => {
      const stackId = `stack-${batchIndex}`;
      const isExpanded = expandedStacks.has(stackId);
      const itemCount = batch.length;

      // Only show stack UI if batch has multiple items
      if (itemCount === 1) {
        return renderHistoryCard(batch[0], 0, batchIndex);
      }

      const displayName = stackNames.get(stackId) || `转换批次 ${batchIndex + 1}`;
      const latestTime = formatStackTime(batch);
      const hasDocToPdf = batch.some(h => h.conversionType === 'doc_to_pdf');
      const hasPdfToDocx = batch.some(h => h.conversionType === 'pdf_to_docx');
      const hasToMarkdown = batch.some(h => h.conversionType === 'to_markdown');
      const typeTags = [];
      if (hasDocToPdf) typeTags.push('<span class="stack-folder-tag">DOC→PDF</span>');
      if (hasPdfToDocx) typeTags.push('<span class="stack-folder-tag">PDF→DOCX</span>');
      if (hasToMarkdown) typeTags.push('<span class="stack-folder-tag">→MD</span>');

      const folderIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="9" y1="14" x2="15" y2="14" opacity="0.5"/></svg>`;

      return `
        <div class="history-stack ${isExpanded ? 'expanded' : 'collapsed'}" data-stack-id="${stackId}">
          <button class="stack-expand-btn" onclick="toggleStackExpand('${stackId}')">
            ${isExpanded ? '收起' : `展开 ${itemCount}`}
          </button>
          <div class="history-stack-items">
            ${batch.map((h, i) => renderHistoryCard(h, i, batchIndex * 100 + i)).join('')}
          </div>
          ${!isExpanded ? `
          <div class="stack-folder" onclick="toggleStackExpand('${stackId}')">
            <div class="stack-folder-icon">${folderIcon}</div>
            <div class="stack-folder-info">
              <span class="stack-folder-name" contenteditable="false" spellcheck="false"
                    data-stack-id="${stackId}"
                    onclick="event.stopPropagation()"
                    ondblclick="startRenameStack(this)"
                    onblur="finishRenameStack(this)"
                    onkeydown="handleRenameKeydown(event, this)">${displayName}</span>
              <span class="stack-folder-meta">${itemCount} 个文件 · ${latestTime}</span>
            </div>
            <div class="stack-folder-tags">${typeTags.join('')}</div>
          </div>
          ` : ''}
        </div>
      `;
    }).join('');
  } else {
    // Normal flat list rendering
    list.innerHTML = filtered.map((h, i) => renderHistoryCard(h, i, i)).join('');
  }
}

function renderHistoryCard(h, index, globalIndex) {
  const isError = h.status === 'error';
  const isDone = h.status === 'done';
  const isPdfToDocx = h.conversionType === 'pdf_to_docx';
  const isToMarkdown = h.conversionType === 'to_markdown';
  const ext = h.name.split('.').pop().toLowerCase();
  const iconClass = isError ? 'err' : (isPdfToDocx ? 'doc' : isToMarkdown ? 'md' : 'pdf');
  const iconText = isError ? 'ERR' : (isPdfToDocx ? 'PDF' : isToMarkdown ? 'MD' : ext.toUpperCase());
  const ago = timeAgo(h.finishedAt);
  const outputSize = isPdfToDocx ? (h.docxSizeFormatted || '—') : isToMarkdown ? (h.markdownSizeFormatted || '—') : (h.pdfSizeFormatted || '—');
  const pages = h.pages || '—';
  const selected = state.selectedFile === h.id;
  const directionLabel = isPdfToDocx ? 'PDF→DOCX' : 'DOC→PDF';

  const isNewCard = !renderedHistoryIds.has(h.id);
  return `
    <div class="history-card ${selected ? 'selected' : ''}"
         data-id="${h.id}"
         data-group-id="${h.groupId || ''}"
         draggable="true"
         ondragstart="onCardDragStart(event,'${h.id}')"
         ondragover="onCardDragOver(event,'${h.id}')"
         ondragleave="onCardDragLeave(event,'${h.id}')"
         ondrop="onCardDrop(event,'${h.id}')"
         onclick="selectHistoryPage('${h.id}')"
         ${isNewCard ? `style="animation-delay: ${Math.min(globalIndex * 0.015, 0.15)}s"` : 'style="animation: none"'}>
      <div class="hc-icon ${iconClass}">${iconText}</div>
      <div class="hc-info">
        <div class="hc-name">${h.groupId && historySearchQuery ? `<span class="hc-group-prefix">${getGroupName(h.groupId)}-</span>` : ''}${h.name}${h.groupId && !historyStackEnabled ? `<span class="hc-group-badge">${getGroupName(h.groupId)}</span>` : ''}</div>
        <div class="hc-meta">
          ${isError ? `<span class="hc-error-text">${h.error || '转换失败'}</span>` : `<span class="time-ago">${directionLabel} · ${ago}</span>`}
        </div>
      </div>
      <div class="hc-size-from">${outputSize}</div>
      <div class="hc-pages">${isPdfToDocx ? '—' : `<span class="pages-num">${pages}</span> 页`}</div>
      <div class="hc-time">${ago || '—'}</div>
      <div class="hc-actions">
        ${isDone ? `
          <button class="qi-btn download" title="下载" onclick="event.stopPropagation();downloadHistoryFile('${h.id}','${h.name}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
        ` : ''}
        <button class="qi-btn remove" title="删除" onclick="event.stopPropagation();deleteHistoryItem('${h.id}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
  `;
}

function selectHistoryPage(id) {
  state.selectedFile = id;
  // Toggle selected class on existing DOM elements for smooth transition
  document.querySelectorAll('.history-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.id === id);
  });
  showHistoryDetail(id);
}

function showHistoryDetail(id) {
  const item = state.history.find(h => h.id === id);
  if (!item) return;

  const historyPlaceholder = document.getElementById('historyPlaceholder');
  if (historyPlaceholder) historyPlaceholder.style.display = 'none';

  _currentPreviewJobId = item.id;
  _currentPreviewConvType = item.conversionType || 'doc_to_pdf';

  const panel = document.getElementById('historyDetailContent');
  const isError = item.status === 'error';
  const isDone = item.status === 'done';
  const isPdfToDocx = item.conversionType === 'pdf_to_docx';
  const isToMarkdown = item.conversionType === 'to_markdown';
  const ext = item.name.split('.').pop().toLowerCase();
  const iconClass = isError ? 'err' : (isPdfToDocx ? 'doc' : isToMarkdown ? 'md' : 'pdf');
  const iconText = isError ? 'ERR' : (isPdfToDocx ? 'PDF' : isToMarkdown ? 'MD' : ext.toUpperCase());
  const statusLabel = { done: '已完成', error: '失败', processing: '处理中', pending: '等待中' }[item.status];
  const ago = timeAgo(item.finishedAt);
  const outputLabel = isPdfToDocx ? 'DOCX' : isToMarkdown ? 'MD' : 'PDF';
  const outputSize = isPdfToDocx ? (item.docxSizeFormatted || '—') : isToMarkdown ? (item.markdownSizeFormatted || '—') : (item.pdfSizeFormatted || '—');

  // Calculate compression ratio
  let compressionText = '';
  if (isDone && item.inputSize) {
    const outputSizeBytes = isPdfToDocx ? item.docxSize : isToMarkdown ? item.markdownSize : item.pdfSize;
    if (outputSizeBytes) {
      const ratio = Math.round((1 - outputSizeBytes / item.inputSize) * 100);
      compressionText = ratio > 0 ? `压缩 ${ratio}%` : `增大 ${Math.abs(ratio)}%`;
    }
  }

  // Determine conversion direction text
  let directionText = 'DOC → PDF';
  if (isPdfToDocx) directionText = 'PDF → DOCX';
  else if (isToMarkdown) {
    const srcExt = ext;
    directionText = (srcExt === 'pdf') ? 'PDF → Markdown' : `${srcExt.toUpperCase()} → Markdown`;
  }

  panel.innerHTML = `
    <div class="history-detail-header">
      <div class="hd-icon ${iconClass}">${iconText}</div>
      <div class="hd-info">
        <h3>${item.name}</h3>
        <div class="hd-meta">${item.inputSizeFormatted || ''} ${ago ? '· ' + ago : ''}</div>
      </div>
      ${isDone ? `<button class="qi-btn zoom" title="放大预览" onclick="showDetailPreview('${item.id}')" style="width:28px;height:28px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg></button>` : ''}
    </div>

    ${isDone ? `
    <div class="detail-preview">
      <div id="detailPdfPreview"></div>
      <div class="detail-preview-label">${isPdfToDocx ? '源 PDF 预览' : isToMarkdown ? '源 PDF 预览' : 'PDF 预览'} · 点击缩略图放大</div>
    </div>
    ${isToMarkdown ? '<div id="detailMarkdownPreview"></div>' : ''}
    ` : ''}

    <div class="detail-section">
      <h4>文件信息</h4>
      <div class="detail-row">
        <span class="dr-label">原始大小</span>
        <span class="dr-value">${item.inputSizeFormatted || '—'}</span>
      </div>
      <div class="detail-row">
        <span class="dr-label">${outputLabel} 大小</span>
        <span class="dr-value">${outputSize}</span>
      </div>
      ${compressionText ? `
      <div class="detail-row">
        <span class="dr-label">压缩率</span>
        <span class="dr-value compression">${compressionText}</span>
      </div>
      ` : ''}
      ${!isPdfToDocx ? `
      <div class="detail-row">
        <span class="dr-label">页数</span>
        <span class="dr-value">${item.pages || '—'}</span>
      </div>
      ` : ''}
      <div class="detail-row">
        <span class="dr-label">转换方向</span>
        <span class="dr-value">${directionText}</span>
      </div>
    </div>

    <div class="detail-section">
      <h4>转换信息</h4>
      <div class="detail-row">
        <span class="dr-label">状态</span>
        ${item.status === 'done'
          ? `<img src="/icon.png" alt="已完成" style="height:28px;width:auto">`
          : item.status === 'error'
          ? `<img src="/icon01.png" alt="失败" style="height:28px;width:auto">`
          : `<span class="dr-value qi-status ${item.status}" style="font-size:12px">${statusLabel}</span>`
        }
      </div>
      ${item.finishedAt ? `
      <div class="detail-row">
        <span class="dr-label">完成时间</span>
        <span class="dr-value">${item.finishedAt.replace('T', ' ').substring(0, 19)}</span>
      </div>
      ` : ''}
      ${item.error ? `
      <div class="detail-row">
        <span class="dr-label">错误</span>
        <span class="dr-value" style="color:var(--danger);font-size:12px">${item.error}</span>
      </div>
      ` : ''}
    </div>

    <div class="detail-actions">
      ${isDone ? `
        <button class="btn-primary" onclick="downloadHistoryFile('${item.id}','${item.name}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          下载 ${outputLabel}
        </button>
      ` : ''}
      <button class="btn-ghost" onclick="deleteHistoryItem('${item.id}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        删除记录
      </button>
    </div>
  `;

  // Render real PDF preview for done items
  if (isDone && item.id) {
    const previewContainer = document.getElementById('detailPdfPreview');
    if (previewContainer) {
      // Use converted DOCX rendered as PDF for preview (PDF→DOCX jobs)
      const previewUrl = isPdfToDocx ? `${API}/api/preview-docx/${item.id}` : null;
      renderPdfPreview(item.id, previewContainer, { thumbWidth: 160, previewUrl });
    }
    // Render markdown preview for to_markdown items
    if (isToMarkdown) {
      const mdContainer = document.getElementById('detailMarkdownPreview');
      if (mdContainer) {
        renderMarkdownPreview(item.id, mdContainer);
      }
    }
  }

  _syncToolbarDownload();
}

async function deleteHistoryItem(id) {
  // Animate the card/item out first
  const card = document.querySelector(`.history-card[data-id="${id}"]`);
  const sidebarItem = document.querySelector(`.history-item[onclick*="${id}"]`);
  const el = card || sidebarItem;
  if (el) {
    if (card) {
      const rect = el.getBoundingClientRect();
      el.style.setProperty('--h', rect.height + 'px');
    }
    el.classList.add('deleting');
    await new Promise(r => setTimeout(r, 350));
  }

  try {
    const res = await fetch(`${API}/api/history/${id}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      removeFromGroup(id);
      state.history = state.history.filter(h => h.id !== id);
      if (state.selectedFile === id) {
        state.selectedFile = null;
        document.getElementById('historyDetailContent').innerHTML = '';
        document.getElementById('historyDetailPanel').style.display = 'none';
        const historyPlaceholder = document.getElementById('historyPlaceholder');
        if (historyPlaceholder && currentView === 'history') historyPlaceholder.style.display = 'block';
      }
      // Remove element directly from DOM instead of full re-render
      if (el) el.remove();
      // Update counters without re-rendering the list
      const total = state.history.length;
      const doneCount = state.history.filter(h => h.status === 'done').length;
      const errorCount = state.history.filter(h => h.status === 'error').length;
      document.getElementById('historyCount').textContent = state.history.filter(h => h.status === 'done' || h.status === 'error').length;
      document.getElementById('historyTitleCount').textContent = total;
      document.getElementById('filterCountAll').textContent = total;
      document.getElementById('filterCountDone').textContent = doneCount;
      document.getElementById('filterCountError').textContent = errorCount;
      // If list is now empty, show empty state
      const pageList = document.getElementById('historyPageList');
      if (total === 0 && pageList) {
        pageList.innerHTML = `
          <div class="history-empty">
            <div class="empty-icon">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            </div>
            <h4>暂无转换历史</h4>
            <p>完成文件转换后，记录将显示在这里</p>
          </div>
        `;
      }
      showToast('记录已删除', 'success');
    }
  } catch (e) {
    showToast('删除失败: ' + e.message, 'warning');
  }
}

// ── History page search ──
document.getElementById('historyPageSearch').addEventListener('input', (e) => {
  historySearchQuery = e.target.value;
  renderHistoryPage();
});

// ── Init ──
async function init() {
  updateUploadZone();
  renderSettingsPanel();
  _applyPanelSettings();
  _bindSettingsListeners();
  renderBgSettings();
  updateView();

  // Settings panel
  document.getElementById('settingsBtn')?.addEventListener('click', openSettings);
  document.getElementById('settingsClose')?.addEventListener('click', closeSettings);
  document.getElementById('settingsOverlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'settingsOverlay') closeSettings();
  });

  // Initialize stack toggle button state
  if (historyStackEnabled) {
    const btn = document.getElementById('stackToggleBtn');
    const text = document.getElementById('stackToggleText');
    if (btn) {
      btn.classList.add('active');
      btn.style.background = 'var(--accent-light)';
      btn.style.color = 'var(--accent)';
      btn.style.borderColor = 'var(--accent)';
    }
    if (text) text.textContent = '堆叠中';
  }

  // Background & font already applied before init(); skip duplicate call

  const isNeo = document.body.classList.contains('neo-mode');
  const isMax = document.body.classList.contains('maximalist-mode');
  const isBrut = document.body.classList.contains('brutalist-mode');
  const isBau = document.body.classList.contains('bauhaus-mode');
  const overlay = isBau
    ? document.getElementById('loadingOverlayBau')
    : isBrut
      ? document.getElementById('loadingOverlayBrut')
      : isMax
        ? document.getElementById('loadingOverlayMax')
        : isNeo
          ? document.getElementById('loadingOverlayNeo')
          : document.getElementById('loadingOverlay');
  const t0 = Date.now();

  if (!isNeo && !isMax && !isBrut && !isBau) {
    // ── Constructivist animation phases ──

    // Phase 3: Deconstructivist Fragment Explosion (300ms - 1500ms)
    overlay.querySelectorAll('.lo-frag').forEach((el, i) => {
      const delays = [0.3, 0.45, 0.6, 0.75, 0.9, 0.5, 0.65, 1.05, 0.8, 1.2, 1.35, 1.5];
      const delay = delays[i] || (0.3 + i * 0.12);
      el.style.animationDelay = `${delay}s, ${delay + 0.8}s`;
    });
  }

  // Update status text during animation phases
  const statusSelector = isBau ? '.bau-status' : isBrut ? '.brut-status' : isMax ? '.max-status' : isNeo ? '.neo-status' : '.lo-status';
  setTimeout(() => {
    const statusEl = document.querySelector(statusSelector);
    if (statusEl) statusEl.textContent = 'capture';
  }, 2400);

  setTimeout(() => {
    const statusEl = document.querySelector(statusSelector);
    if (statusEl) statusEl.textContent = 'ready';
  }, 2800);

  // Wait for font + engine check + history in parallel
  // Font already started loading before init(); just wait for it
  const fontPromise = document.fonts.ready;
  const enginePromise = (async () => {
    try {
      const res = await fetch(`${API}/api/engine`);
      const data = await res.json();
      if (!data.wordAvailable) {
        showToast('未检测到 Microsoft Word — 转换功能不可用', 'warning');
      }
      // Store OCR engine status for settings panel
      state.ocrStatus = data.ocr;
    } catch {
      showToast('无法连接到服务器', 'warning');
    }
  })();
  const historyPromise = fetchHistory();

  // Preload help documentation content during startup
  const helpPreloadPromise = (async () => {
    const fileMap = {
      'doc_to_pdf': 'help_docs/doc_to_pdf.md',
      'pdf_to_docx': 'help_docs/pdf_to_docx.md',
      'to_markdown': 'help_docs/to_markdown.md'
    };

    for (const [mode, filePath] of Object.entries(fileMap)) {
      try {
        const response = await fetch(filePath);
        if (response.ok) {
          const md = await response.text();
          // Store parsed content in memory for instant display
          if (!window._helpCache) window._helpCache = {};
          window._helpCache[mode] = parseMarkdown(md);
        }
      } catch (e) {
        // Silently fail - will retry when user opens help
      }
    }

    // 预加载帮助音频
    try {
      if (!window._helpAudioPreload) {
        window._helpAudioPreload = new Audio('/READ.mp3');
        window._helpAudioPreload.loop = true;
        window._helpAudioPreload.preload = 'auto';
        
        // 等待音频加载完成
        await new Promise((resolve) => {
          const onCanPlay = () => {
            resolve();
            window._helpAudioPreload.removeEventListener('canplay', onCanPlay);
            window._helpAudioPreload.removeEventListener('canplaythrough', onCanPlay);
            window._helpAudioPreload.removeEventListener('error', onError);
          };
          const onError = () => {
            resolve(); // 即使加载失败也继续
            window._helpAudioPreload.removeEventListener('canplay', onCanPlay);
            window._helpAudioPreload.removeEventListener('canplaythrough', onCanPlay);
            window._helpAudioPreload.removeEventListener('error', onError);
          };
          window._helpAudioPreload.addEventListener('canplay', onCanPlay);
          window._helpAudioPreload.addEventListener('canplaythrough', onCanPlay);
          window._helpAudioPreload.addEventListener('error', onError);
          window._helpAudioPreload.load();
          
          // 超时处理
          setTimeout(resolve, 3000);
        });
      }
    } catch (e) {
      // 音频预加载失败，不影响主流程
    }
  })();

  // Wait for all critical tasks including help preloading
  await Promise.all([fontPromise, enginePromise, historyPromise, helpPreloadPromise]);

  // Ensure minimum display time for full animation sequence
  const elapsed = Date.now() - t0;
  const minDisplay = 3000;
  if (elapsed < minDisplay) {
    await new Promise(r => setTimeout(r, minDisplay - elapsed));
  }

  // Graceful exit: fade out overlay
  overlay.classList.add('hidden');
}

// ── Apply saved background & font immediately (before init) ──
// These must run before init() so they take effect even if init throws.
(function applySavedAppearance() {
  const savedBg = localStorage.getItem('docflow_bg_image');
  if (savedBg) applyBgImage(savedBg);
  // Font: server injects @font-face CSS server-side; also register via FontFace API for reliability
  loadSavedFont();
})();
// Apply splash animation mode immediately (before init) to avoid flash
const splashMode = localStorage.getItem('docflow_splash_animation');
if (splashMode === 'neo') {
  document.body.classList.add('neo-mode');
} else if (splashMode === 'maximalist') {
  document.body.classList.add('maximalist-mode');
} else if (splashMode === 'brutalist') {
  document.body.classList.add('brutalist-mode');
} else if (splashMode === 'bauhaus') {
  document.body.classList.add('bauhaus-mode');
}
// Start music player setup during splash screen (parallel with fonts/engine/history)
initMusicPlayer();

init();

// ── History Card Drag-and-Drop ──
function onCardDragStart(event, itemId) {
  draggedItemId = itemId;
  event.dataTransfer.setData('text/plain', itemId);
  event.dataTransfer.effectAllowed = 'move';
  event.stopPropagation();
  requestAnimationFrame(() => {
    const card = document.querySelector(`.history-card[data-id="${itemId}"]`);
    if (card) card.classList.add('dragging');
  });
}

function onCardDragOver(event, targetId) {
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = 'move';
  if (!draggedItemId || draggedItemId === targetId) return;
  const sourceItem = state.history.find(h => h.id === draggedItemId);
  const targetItem = state.history.find(h => h.id === targetId);
  if (sourceItem && targetItem && sourceItem.groupId && sourceItem.groupId === targetItem.groupId) return;
  const target = event.currentTarget;
  if (target) target.classList.add('drag-over');
}

function onCardDragLeave(event, targetId) {
  event.stopPropagation();
  const target = event.currentTarget;
  if (target) target.classList.remove('drag-over');
}

function onCardDrop(event, targetId) {
  event.preventDefault();
  event.stopPropagation();
  const sourceId = event.dataTransfer.getData('text/plain') || draggedItemId;
  if (!sourceId || sourceId === targetId) return;

  const sourceItem = state.history.find(h => h.id === sourceId);
  const targetItem = state.history.find(h => h.id === targetId);
  if (!sourceItem || !targetItem) return;

  // Clean up visual state
  document.querySelectorAll('.history-card.dragging').forEach(el => el.classList.remove('dragging'));
  document.querySelectorAll('.history-card.drag-over').forEach(el => el.classList.remove('drag-over'));

  const sourceGid = sourceItem.groupId;
  const targetGid = targetItem.groupId;

  if (!sourceGid && !targetGid) {
    // Both ungrouped → create new group
    assignGroupId([sourceId, targetId]);
    showToast('已合并到新分组', 'success');
  } else if (sourceGid && !targetGid) {
    // Source in group, target not → add target to source's group
    const members = manualGroups.get(sourceGid);
    if (members) {
      members.add(targetId);
      targetItem.groupId = sourceGid;
    }
    showToast('已添加到分组', 'success');
  } else if (!sourceGid && targetGid) {
    // Source ungrouped, target in group → add source to target's group
    const members = manualGroups.get(targetGid);
    if (members) {
      members.add(sourceId);
      sourceItem.groupId = targetGid;
    }
    showToast('已添加到分组', 'success');
  } else if (sourceGid !== targetGid) {
    // Both in different groups → merge smaller into larger
    const sourceMembers = manualGroups.get(sourceGid);
    const targetMembers = manualGroups.get(targetGid);
    if (sourceMembers && targetMembers) {
      const [bigMembers, bigGid, smallMembers, smallGid] =
        sourceMembers.size >= targetMembers.size
          ? [sourceMembers, sourceGid, targetMembers, targetGid]
          : [targetMembers, targetGid, sourceMembers, sourceGid];
      smallMembers.forEach(id => {
        const item = state.history.find(h => h.id === id);
        if (item) {
          item.groupId = bigGid;
          bigMembers.add(id);
        }
      });
      manualGroups.delete(smallGid);
      groupNames.delete(smallGid);
    }
    showToast('已合并分组', 'success');
  }
  // Same group → no-op

  draggedItemId = null;
  lastHistoryPageHash = '';
  renderHistoryPage();
  renderHistory(document.getElementById('historySearch').value);
}

// Drop on page list background → ungroup
document.addEventListener('DOMContentLoaded', () => {
  const pageList = document.getElementById('historyPageList');
  if (pageList) {
    pageList.addEventListener('dragover', (e) => {
      if (draggedItemId && e.target === pageList) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }
    });
    pageList.addEventListener('drop', (e) => {
      if (e.target === pageList && draggedItemId) {
        e.preventDefault();
        const item = state.history.find(h => h.id === draggedItemId);
        if (item && item.groupId) {
          removeFromGroup(draggedItemId);
          showToast('已从分组中移除', 'success');
          draggedItemId = null;
          lastHistoryPageHash = '';
          renderHistoryPage();
          renderHistory(document.getElementById('historySearch').value);
        } else {
          draggedItemId = null;
        }
      }
    });
  }
});

// Clean up dragging state on drag end
document.addEventListener('dragend', () => {
  document.querySelectorAll('.history-card.dragging').forEach(el => el.classList.remove('dragging'));
  document.querySelectorAll('.history-card.drag-over').forEach(el => el.classList.remove('drag-over'));
  draggedItemId = null;
});

// ── Help Modal ──
let _currentHelpMode = 'doc_to_pdf';
let _helpCloseTimer = null;

// Enhanced markdown parser
function parseMarkdown(md) {
  // First, escape HTML to prevent XSS
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Headers (h4, h3, h2, h1 - order matters!)
  html = html
    .replace(/^#### (.*$)/gim, '<h4>$1</h4>')
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>');

  // Horizontal rule
  html = html.replace(/^---$/gim, '<hr>');

  // Bold and italic
  html = html
    .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/___(.*?)___/g, '<strong><em>$1</em></strong>')
    .replace(/__(.*?)__/g, '<strong>$1</strong>')
    .replace(/_(.*?)_/g, '<em>$1</em>');

  // Code - inline
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Code blocks
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

  // Lists - unordered
  // Process list items
  const listItemRegex = /^(\s*)[-*+]\s+(.*)$/gim;
  const lines = html.split('\n');
  let inList = false;
  let listIndent = 0;
  let result = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(\s*)[-*+]\s+(.*)$/);

    if (match) {
      const indent = match[1].length;
      const content = match[2];

      if (!inList) {
        result.push('<ul>');
        inList = true;
        listIndent = indent;
      }
      result.push(`<li>${content}</li>`);
    } else {
      if (inList && line.trim() !== '') {
        result.push('</ul>');
        inList = false;
      }
      result.push(line);
    }
  }
  if (inList) result.push('</ul>');
  html = result.join('\n');

  // Blockquotes
  html = html.replace(/^>\s*(.*$)/gim, '<blockquote>$1</blockquote>');

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Paragraphs - wrap lines that aren't already wrapped in block elements
  const blockElements = 'h1|h2|h3|h4|h5|h6|ul|ol|li|blockquote|pre|hr|div|p';
  const blockRegex = new RegExp(`^<(${blockElements})`, 'i');

  const paraLines = html.split('\n');
  let inParagraph = false;
  let paraResult = [];

  for (let line of paraLines) {
    const trimmed = line.trim();

    if (trimmed === '') {
      if (inParagraph) {
        paraResult.push('</p>');
        inParagraph = false;
      }
      paraResult.push('');
    } else if (blockRegex.test(trimmed)) {
      if (inParagraph) {
        paraResult.push('</p>');
        inParagraph = false;
      }
      paraResult.push(line);
    } else {
      if (!inParagraph) {
        paraResult.push('<p>');
        inParagraph = true;
      }
      paraResult.push(line);
    }
  }
  if (inParagraph) paraResult.push('</p>');

  html = paraResult.join('\n');

  // Clean up multiple consecutive empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/\n{3,}/g, '\n\n');

  return html;
}



async function loadHelpContent(mode, animate = true) {
  const contentEl = document.getElementById('helpContent');
  if (!contentEl) return;

  // Reset zoom on document switch
  _helpZoomLevel = 1;
  contentEl.style.transform = '';

  const fileMap = {
    'doc_to_pdf': 'help_docs/doc_to_pdf.md',
    'pdf_to_docx': 'help_docs/pdf_to_docx.md',
    'to_markdown': 'help_docs/to_markdown.md'
  };
  
  // 检查是否是首次加载和当前内容状态
  const isFirstLoad = !contentEl.innerHTML.trim();
  const isFromChangelog = !isFirstLoad && contentEl.querySelector('.changelog-neo');

  // 更新日志内容 - 新表现主义风格
  const changelogContent = {
    'changelog': {
      title: 'CHANGELOG',
      subtitle: '版本演进',
      versions: [
        {
          version: 'V3.1',
          date: '5.13',
          badge: 'LATEST',
          items: [
            { icon: '🎨', text: '新增 5 种异形进度条样式（构成主义 / 新表现主义 / 极繁主义 / 新粗野主义 / 包豪斯主义），设置面板实时切换' },
            { icon: '🐛', text: '修复 PDF→DOCX 重新转换后预览仍显示旧版本的问题' },
            { icon: '🐛', text: '修复转 MD 模式设置面板输出/质量/安全区域无法交互的问题' },
            { icon: '✨', text: '移除转 MD 模式同步区域的「已同步」标记，界面更简洁' },
          ]
        },
        {
          version: 'V3.0',
          date: '5.13',
          badge: 'MAJOR',
          items: [
            { icon: '📝', text: '新增「转 Markdown」模式 — PDF/DOC/DOCX → Markdown 全格式支持' },
            { icon: '🧠', text: '集成 kmind 思维导图生成，支持 SVG/PNG 两种输出格式' },
            { icon: '🔍', text: 'Markdown 源码/渲染双视图预览' },
            { icon: '⚙️', text: '新增三模式设置面板（DOC→PDF / PDF→DOCX / 转 MD）' },
            { icon: '🔧', text: '修复文件设置未正确继承面板默认值的 Bug' },
            { icon: '🔧', text: '修复预览时后台转换完成强制切换回队列视图的问题' },
            { icon: '🎬', text: '优化工具栏下载按钮入场/退场动画（弹簧曲线 + animationend 事件驱动）' },
            { icon: '🌐', text: '脑图输出注入 CJK 字体栈，修复中文字体重叠问题' },
            { icon: '📐', text: '脑图渲染视口扩大至 2400×1600，改善布局空间' },
            { icon: '📖', text: '新增「转 Markdown」模式帮助文档' },
          ]
        },
        {
          version: 'V2.3',
          date: '5.12',
          items: [
            { icon: '🏗️', text: '预设模态框构成主义UI/UX全面重构' },
            { icon: '🐛', text: '修复保存预设到localStorage的Bug（数据类型校验）' },
            { icon: '🎬', text: '新建预设展开/收起动画匹配已有卡片动画模式' },
            { icon: '🌀', text: '模态框关闭过渡动画优化（柔和减速曲线）' },
            { icon: '💾', text: '设置面板持久化 — 刷新页面后保留当前设置' },
            { icon: '🖱️', text: '拖放上传功能限制仅在转换视图生效' }
          ]
        },
        {
          version: 'V2.2',
          date: '5.10',
          items: [
            { icon: '✨', text: '全新新表现主义设计风格' },
            { icon: '🎭', text: '添加更新日志专属切换动画' },
            { icon: '📖', text: 'Markdown 文档新表现主义样式' },
            { icon: '🔧', text: '修复帮助按钮音频播放问题' },
            { icon: '🎨', text: '优化帮助模态框滚动条效果' }
          ]
        },
        {
          version: 'V2.1',
          date: '5.9',
          badge: 'FEATURE',
          items: [
            { icon: '🔒', text: '完善所有设置项功能（DOC→PDF 密码保护、权限控制、PDF 版本）' },
            { icon: '📜', text: '优化预览视图滚动体验' },
            { icon: '🔊', text: '添加音频帮助播放功能' },
            { icon: '⬇️', text: '修复自动下载设置不生效问题' },
            { icon: '🎨', text: '优化帮助模态框设计' }
          ]
        },
        {
          version: 'V2.0',
          date: '5.8',
          badge: 'MAJOR',
          items: [
            { icon: '🎨', text: '全新界面设计' },
            { icon: '🔄', text: '支持 DOC/DOCX ↔ PDF 双向转换' },
            { icon: '🔍', text: '智能 OCR 引擎（RapidOCR + Tesseract）' },
            { icon: '📊', text: '表格结构检测与重建' },
            { icon: '🖼️', text: 'PDF/DOCX 预览功能' },
            { icon: '📜', text: '转换历史管理' },
            { icon: '🔤', text: '自定义字体支持' },
            { icon: '🔐', text: 'PDF 安全控制（密码保护、权限管理）' }
          ]
        },
        {
          version: 'V1.0',
          date: '5.7',
          badge: 'INITIAL',
          items: [
            { icon: '🚀', text: '初始版本发布' },
            { icon: '📝', text: '支持 DOC/DOCX 转 PDF' },
            { icon: '📁', text: '基础文件管理功能' },
            { icon: '⚡', text: '批量文件转换' },
            { icon: '📈', text: '实时进度显示' }
          ]
        }
      ]
    }
  };

  const filePath = fileMap[mode];
  
  // 如果是更新日志模式，渲染新表现主义风格内容
  if (mode === 'changelog') {
    const isFromOtherMode = !isFirstLoad && !contentEl.querySelector('.changelog-neo');
    
    // 如果是从其他模式切换到更新日志，添加离开动画
    if (animate && !isFirstLoad && contentEl.innerHTML.trim()) {
      if (isFromOtherMode) {
        // 其他模式 -> 更新日志：先让当前内容执行普通离开动画
        contentEl.classList.add('switching-out');
        await new Promise(r => setTimeout(r, 300));
      } else {
        // 已经在更新日志内切换，使用普通切换
        contentEl.classList.add('switching-out');
        await new Promise(r => setTimeout(r, 300));
      }
    }
    
    contentEl.scrollTop = 0;
    
    // 生成新表现主义风格的更新日志HTML（包含背景元素）
    const data = changelogContent['changelog'];
    let html = `
      <div class="changelog-neo">
        <div class="changelog-header-neo">
          <div class="changelog-slash"></div>
          <h1 class="changelog-title">${data.title}</h1>
          <span class="changelog-subtitle">${data.subtitle}</span>
          <div class="changelog-fragments">
            <span class="changelog-frag frag-1"></span>
            <span class="changelog-frag frag-2"></span>
            <span class="changelog-frag frag-3"></span>
          </div>
        </div>
        <div class="changelog-timeline">
    `;
    
    data.versions.forEach((ver, idx) => {
      html += `
        <div class="changelog-version" style="--delay: ${idx * 0.15}s">
          <div class="version-marker">
            <span class="version-dot"></span>
            <span class="version-line"></span>
          </div>
          <div class="version-content">
            <div class="version-header">
              <span class="version-number">${ver.version}</span>
              <span class="version-date">${ver.date}</span>
              ${ver.badge ? `<span class="version-badge badge-${ver.badge.toLowerCase()}">${ver.badge}</span>` : ''}
            </div>
            <ul class="version-items">
              ${ver.items.map(item => `
                <li class="version-item">
                  <span class="item-icon">${item.icon}</span>
                  <span class="item-text">${item.text}</span>
                </li>
              `).join('')}
            </ul>
          </div>
        </div>
      `;
    });
    
    html += `
        </div>
        <div class="changelog-footer-neo">
          <div class="footer-stroke"></div>
          <span class="footer-text">EVOLUTION NEVER STOPS</span>
        </div>
      </div>
      
      <!-- 新表现主义背景元素（放在changelog-neo之后以便CSS选择器生效） -->
      <div class="changelog-bg-orbs ${isFirstLoad || isFromOtherMode ? 'active' : ''}">
        <div class="changelog-orb orb-1"></div>
        <div class="changelog-orb orb-2"></div>
        <div class="changelog-orb orb-3"></div>
      </div>
      <div class="changelog-noise-overlay"></div>
      <div class="changelog-geo-fragments">
        <div class="geo-fragment frag-triangle"></div>
        <div class="geo-fragment frag-square"></div>
        <div class="geo-fragment frag-circle"></div>
        <div class="geo-fragment frag-line"></div>
        <div class="geo-fragment frag-diamond"></div>
      </div>
    `;
    
    contentEl.innerHTML = html;
    
    // 触发新表现主义进入动画
    if (isFirstLoad || isFromOtherMode) {
      // 首次加载或从其他模式进入：使用专属进入动画
      contentEl.classList.remove('switching-out', 'reveal-ready', 'revealing');
      contentEl.classList.add('changelog-entering');
      
      // 动画结束后添加静态类，保持最终状态
      setTimeout(() => {
        contentEl.classList.add('changelog-entered');
        contentEl.classList.remove('changelog-entering');
      }, 1000);
    } else {
      // 已经在更新日志内：使用普通切换动画
      contentEl.classList.remove('switching-out');
      contentEl.classList.add('switching-in');
      setTimeout(() => contentEl.classList.remove('switching-in'), 400);
    }
    return;
  }
  
  // 如果从更新日志切换到其他模式，先执行更新日志离开动画
  if (isFromChangelog && animate) {
    contentEl.classList.add('changelog-leaving');
    await new Promise(r => setTimeout(r, 500));
    contentEl.classList.remove('changelog-leaving', 'changelog-entered');
    // 立即清空内容，避免闪现
    contentEl.innerHTML = '';
  } else if (animate && !isFirstLoad && contentEl.innerHTML.trim()) {
    // 非更新日志切换：执行普通离开动画
    contentEl.classList.add('switching-out');
    await new Promise(r => setTimeout(r, 300));
  }

  if (!filePath) return;

  // Check if content is already cached from startup preload
  if (isFirstLoad && window._helpCache && window._helpCache[mode]) {
    // Use cached content for instant display - no skeleton needed
    contentEl.innerHTML = window._helpCache[mode];
    contentEl.classList.add('reveal-ready');

    // Wait for modal assembly to mostly complete, then reveal content
    await new Promise(r => setTimeout(r, 300));
    contentEl.classList.add('revealing');

    // Clean up reveal classes after animation completes
    setTimeout(() => {
      contentEl.classList.remove('reveal-ready', 'revealing');
    }, 1200);
    return;
  }

  // Show skeleton on first load (fallback if not cached)
  if (isFirstLoad) {
    contentEl.innerHTML = `
      <div class="hm-skeleton">
        <div class="hm-skel-line"></div>
        <div class="hm-skel-line"></div>
        <div class="hm-skel-line"></div>
        <div class="hm-skel-line"></div>
        <div class="hm-skel-line"></div>
        <div class="hm-skel-line"></div>
        <div class="hm-skel-line"></div>
        <div class="hm-skel-line"></div>
        <div class="hm-skel-line"></div>
        <div class="hm-skel-line"></div>
      </div>
    `;
    // Let skeleton render, then start fetching
    await new Promise(r => setTimeout(r, 50));
  }

  try {
    const response = await fetch(filePath);
    if (!response.ok) throw new Error('Failed to load');
    const md = await response.text();

    // Reset scroll position
    contentEl.scrollTop = 0;

    if (isFirstLoad) {
      // First load: coordinate reveal with modal assembly
      // Modal body finishes around 750ms from open. Wait for that.
      const html = parseMarkdown(md);
      contentEl.innerHTML = html;
      contentEl.classList.add('reveal-ready');

      // Wait for modal assembly to mostly complete, then reveal content
      await new Promise(r => setTimeout(r, 500));
      contentEl.classList.add('revealing');

      // Clean up reveal classes after animation completes
      setTimeout(() => {
        contentEl.classList.remove('reveal-ready', 'revealing');
        // 初始化帮助演示组件
        const demoContainer = contentEl.querySelector('.help-demo-container');
        if (demoContainer) {
          initHelpDemo(demoContainer);
        }
      }, 1200);
    } else {
      // Mode switching: update content then animate in
      contentEl.innerHTML = parseMarkdown(md);
      contentEl.classList.remove('switching-out', 'changelog-leaving');
      contentEl.classList.add('switching-in');
      setTimeout(() => contentEl.classList.remove('switching-in'), 400);

      // 初始化帮助演示组件
      const demoContainer = contentEl.querySelector('.help-demo-container');
      if (demoContainer) {
        initHelpDemo(demoContainer);
      }
    }

  } catch (e) {
    contentEl.innerHTML = `<p style="color: var(--danger);">无法加载帮助文档</p>`;
    contentEl.classList.remove('switching-out', 'reveal-ready', 'revealing');
  }
}

function switchHelpMode(mode) {
  if (_currentHelpMode === mode) return; // Don't reload same mode
  _currentHelpMode = mode;

  // 切换文档时自动退出演示模式
  if (_demoModeActive) {
    toggleDemoMode();
  }

  // Update tab states with animation
  document.querySelectorAll('.hm-tab').forEach(tab => {
    const isActive = tab.dataset.mode === mode;
    tab.classList.toggle('active', isActive);
    // Add subtle scale animation to active tab
    if (isActive) {
      tab.style.transform = 'scale(0.95)';
      setTimeout(() => tab.style.transform = '', 150);
    }
  });

  // Load content with animation
  loadHelpContent(mode, true);
}

let _helpRestoreFocus = null;

async function openHelp() {
  // Cancel any pending close cleanup
  if (_helpCloseTimer) { clearTimeout(_helpCloseTimer); _helpCloseTimer = null; }

  const overlay = document.getElementById('helpModalOverlay');
  const contentEl = document.getElementById('helpContent');
  const modal = overlay ? overlay.querySelector('.help-modal') : null;

  // Save focus for restoration
  _helpRestoreFocus = document.activeElement;

  // Pause music player
  if (musicPlayer.audio && !musicPlayer.audio.paused) {
    musicPlayer._wasPlayingBeforeHelp = true;
    musicPlayer.audio.pause();
  } else {
    musicPlayer._wasPlayingBeforeHelp = false;
  }

  // Show modal first
  overlay.classList.remove('closing');
  overlay.classList.add('visible');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';

  // Focus the modal
  if (modal) {
    modal.setAttribute('tabindex', '-1');
    setTimeout(() => modal.focus(), 50);
  }

  // Clear content initially for smooth animation
  if (contentEl) {
    contentEl.innerHTML = '';
    contentEl.classList.remove('reveal-ready', 'revealing');
  }

  // Load initial content based on current conversion mode
  const currentMode = state.mode || 'doc_to_pdf';
  _currentHelpMode = ''; // Reset to force reload
  switchHelpMode(currentMode);

  // Play help audio loop
  // 使用预加载的音频（如果存在）
  if (window._helpAudioPreload && !helpAudio) {
    helpAudio = window._helpAudioPreload;
  }

  if (!helpAudio) {
    helpAudio = new Audio('/READ.mp3');
    helpAudio.loop = true;
    helpAudio.preload = 'auto';
  }

  // 确保音频已解锁（等待解锁完成）
  await unlockAudio();

  // 尝试播放音频的函数
  const tryPlayAudio = async () => {
    try {
      // 如果音频正在播放，先停止
      if (!helpAudio.paused) {
        helpAudio.pause();
      }
      helpAudio.currentTime = 0;
      await helpAudio.play();
    } catch (err) {
      console.log('音频播放被阻止:', err);
    }
  };

  // 检查音频是否已加载，如果未加载则等待加载完成
  if (helpAudio.readyState >= 2) {
    // 音频已加载，直接播放
    tryPlayAudio();
  } else {
    // 音频未加载，等待 canplay 事件
    const onCanPlay = () => {
      tryPlayAudio();
      helpAudio.removeEventListener('canplay', onCanPlay);
      helpAudio.removeEventListener('canplaythrough', onCanPlay);
    };
    helpAudio.addEventListener('canplay', onCanPlay);
    helpAudio.addEventListener('canplaythrough', onCanPlay);

    // 同时开始加载
    helpAudio.load();

    // 设置超时，如果加载失败也能继续
    setTimeout(() => {
      helpAudio.removeEventListener('canplay', onCanPlay);
      helpAudio.removeEventListener('canplaythrough', onCanPlay);
      // 尝试播放，即使可能还没加载完
      tryPlayAudio();
    }, 1000);
  }
}

function closeHelp(e) {
  if (e && e.target !== e.currentTarget) return;
  const overlay = document.getElementById('helpModalOverlay');
  overlay.classList.add('closing');
  overlay.classList.remove('visible');
  overlay.setAttribute('aria-hidden', 'true');
  // Clean up content and state after close animation
  _helpCloseTimer = setTimeout(() => {
    _helpCloseTimer = null;
    overlay.classList.remove('closing');
    const contentEl = document.getElementById('helpContent');
    if (contentEl) {
      contentEl.classList.remove('reveal-ready', 'revealing');
      contentEl.innerHTML = '';
    }
    // Restore focus
    if (_helpRestoreFocus && _helpRestoreFocus.focus) {
      _helpRestoreFocus.focus();
      _helpRestoreFocus = null;
    }
  }, 400);
  document.body.style.overflow = '';

  // Stop help audio
  if (helpAudio) {
    helpAudio.pause();
    helpAudio.currentTime = 0;
  }

  // Resume music player if it was playing before help
  if (musicPlayer._wasPlayingBeforeHelp && musicPlayer.audio) {
    musicPlayer.audio.play().catch(() => {});
    musicPlayer._wasPlayingBeforeHelp = false;
  }
}

// 帮助演示组件步骤控制
let _currentDemoStep = 0;
const _demoSteps = ['file', 'settings', 'convert', 'complete'];
const _stepTitles = ['选择文件', '配置设置', '开始转换', '下载完成'];
const _stepDurations = { file: 3800, settings: 5800, convert: 5200, complete: 4800 };

let _demoCleanupFn = null;

function initHelpDemo(container) {
  if (!container) return;

  // ── Cleanup previous instance (memory leak fix) ──
  if (_demoCleanupFn) { _demoCleanupFn(); _demoCleanupFn = null; }

  const dots = container.querySelectorAll('.demo-step-dot');
  const contents = container.querySelectorAll('.demo-step-content');
  const visuals = container.querySelectorAll('.demo-step-visual');
  const prevBtn = container.querySelector('.demo-btn-prev');
  const nextBtn = container.querySelector('.demo-btn-next');
  const pauseBtn = container.querySelector('.demo-pause-btn');
  const pctEl = container.querySelector('#mockPct');
  const cursor = container.querySelector('#mockCursor');
  const cursorLabel = cursor ? cursor.querySelector('.mock-cursor-label') : null;
  const visualPanel = container.querySelector('.hm-demo-visual-panel');
  const announcer = container.querySelector('#demoStepAnnouncer');
  let countUpTimer = null;
  let cursorTimers = [];
  let _cursorPaused = false;
  let _demoAutoPlay = true;
  let _demoAutoPlayTimer = null;
  let _hoveredEl = null;

  // ── Cursor choreography ──
  function clearCursorTimers() {
    cursorTimers.forEach(t => clearTimeout(t));
    cursorTimers = [];
  }

  function hideCursor() {
    if (!cursor) return;
    cursor.classList.remove('visible');
    cursorLabel && cursorLabel.classList.remove('visible');
    cursor.style.left = '-100px';
    cursor.style.top = '-100px';
    clearHoverRing();
  }

  const CURSOR_TIP_X = 2;
  const CURSOR_TIP_Y = 1;

  function moveCursor(x, y, duration) {
    if (!cursor || _cursorPaused) return;
    cursor.style.transition = `left ${duration || 0.8}s cubic-bezier(0.34, 1.56, 0.64, 1), top ${duration || 0.8}s cubic-bezier(0.34, 1.56, 0.64, 1)`;
    cursor.style.left = (x - CURSOR_TIP_X) + 'px';
    cursor.style.top = (y - CURSOR_TIP_Y) + 'px';
  }

  function moveCursorSmooth(x, y, duration) {
    if (!cursor || _cursorPaused) return;
    cursor.style.transition = `left ${duration || 1.0}s cubic-bezier(0.25, 0.46, 0.45, 0.94), top ${duration || 1.0}s cubic-bezier(0.25, 0.46, 0.45, 0.94)`;
    cursor.style.left = (x - CURSOR_TIP_X) + 'px';
    cursor.style.top = (y - CURSOR_TIP_Y) + 'px';
  }

  function showCursor() {
    if (!cursor) return;
    cursor.classList.add('visible');
  }

  function cursorClick() {
    if (!cursor) return;
    const clickEl = cursor.querySelector('.mock-cursor-click');
    const ringEl = cursor.querySelector('.mock-cursor-ring');
    if (clickEl) {
      clickEl.style.animation = 'none';
      void clickEl.offsetWidth;
      clickEl.style.animation = 'cursorClickRipple 0.5s ease-out forwards';
    }
    if (ringEl) {
      ringEl.style.animation = 'cursorHoverPulse 0.5s ease-out forwards';
    }
  }

  function cursorIdle() {
    if (!cursor) return;
    cursor.style.animation = 'cursorIdle 3s ease-in-out infinite';
  }

  function cursorStopIdle() {
    if (!cursor) return;
    cursor.style.animation = 'none';
  }

  // ── Cursor tooltip label ──
  function showCursorLabel(text) {
    if (!cursorLabel) return;
    cursorLabel.textContent = text;
    cursorLabel.classList.add('visible');
  }

  function hideCursorLabel() {
    if (!cursorLabel) return;
    cursorLabel.classList.remove('visible');
  }

  // ── Focus ring on hovered element ──
  function setHoverRing(el) {
    clearHoverRing();
    if (el) { el.classList.add('mock-focus-ring'); _hoveredEl = el; }
  }

  function clearHoverRing() {
    if (_hoveredEl) { _hoveredEl.classList.remove('mock-focus-ring'); _hoveredEl = null; }
  }

  function getElCenter(selector, stageVisual) {
    if (!stageVisual) return null;
    const el = stageVisual.querySelector(selector);
    if (!el) return null;
    // Guard: check element is visible
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    const panelRect = visualPanel.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    if (elRect.width === 0 || elRect.height === 0) return null;
    return {
      x: elRect.left - panelRect.left + elRect.width / 2,
      y: elRect.top - panelRect.top + elRect.height / 2
    };
  }

  // ── Per-step cursor choreographies ──
  const cursorChoreographies = {
    file(visual) {
      if (!cursor || !visual) return;
      const uploadArea = getElCenter('.mock-upload-area', visual);
      const btn = getElCenter('.mock-upload-btn', visual);
      if (!uploadArea || !btn) return;

      const fileCard = visual.querySelector('.mock-file-card');
      if (fileCard) fileCard.classList.remove('visible');

      cursorStopIdle();
      cursor.style.left = (uploadArea.x + 80) + 'px';
      cursor.style.top = (uploadArea.y + 100) + 'px';

      // 0ms: Enter + move to upload area
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        showCursor();
        showCursorLabel('选择文件');
        moveCursorSmooth(uploadArea.x, uploadArea.y, 0.5);
      }, 100));

      // 600ms: Click area — file card appears
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        cursorClick();
        showCursorLabel('点击上传');
        if (fileCard) fileCard.classList.add('visible');
        // Highlight area briefly
        const area = visual.querySelector('.mock-upload-area');
        if (area) {
          area.style.borderColor = 'var(--accent)';
          area.style.borderStyle = 'solid';
          area.style.background = 'oklch(96% 0.015 240)';
        }
      }, 600));

      // 1200ms: Move to button
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        moveCursor(btn.x, btn.y, 0.4);
      }, 1200));

      // 1800ms: Click button
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        cursorClick();
        const uploadBtn = visual.querySelector('.mock-upload-btn');
        if (uploadBtn) {
          uploadBtn.style.transform = 'scale(0.97)';
          setTimeout(() => { if (!_cursorPaused) uploadBtn.style.transform = ''; }, 150);
        }
      }, 1800));

      // 2400ms: Clean up and fade
      cursorTimers.push(setTimeout(() => {
        hideCursorLabel();
        hideCursor();
        const area = visual.querySelector('.mock-upload-area');
        if (area) { area.style.borderColor = ''; area.style.borderStyle = ''; area.style.background = ''; }
        clearHoverRing();
      }, 2400));
    },

    settings(visual) {
      if (!cursor || !visual) return;
      const toggles = visual.querySelectorAll('.mock-toggle');
      const dpiSelect = visual.querySelector('.mock-select-dpi');
      const dropdown = dpiSelect ? dpiSelect.querySelector('.mock-select-dropdown') : null;
      if (toggles.length < 2 || !dpiSelect) return;

      const panel = getElCenter('.mock-settings-panel', visual);
      if (!panel) return;
      cursorStopIdle();
      cursor.style.left = '-40px';
      cursor.style.top = (panel.y - 30) + 'px';

      // Enter from left
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        showCursor();
        showCursorLabel('开启嵌入字体');
        const togglePos = getElCenter('.mock-toggle', visual);
        if (togglePos) moveCursor(togglePos.x, togglePos.y, 0.8);
      }, 300));

      // Click first toggle (嵌入字体)
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        cursorClick();
        const t = toggles[0];
        if (t) {
          t.classList.toggle('on');
          t.style.transform = 'scale(1.1)';
          setHoverRing(t);
          setTimeout(() => { if (!_cursorPaused) t.style.transform = ''; }, 200);
        }
      }, 1300));

      // Move to DPI select
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        clearHoverRing();
        showCursorLabel('选择图像质量');
        const selectPos = getElCenter('.mock-select-dpi', visual);
        if (selectPos) moveCursor(selectPos.x, selectPos.y, 0.7);
      }, 2200));

      // Highlight select
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        dpiSelect.style.borderColor = 'var(--accent)';
        dpiSelect.style.boxShadow = '0 0 0 2px oklch(52% 0.08 240 / 0.15)';
        setHoverRing(dpiSelect);
      }, 2900));

      // Click select — open dropdown
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        cursorClick();
        dpiSelect.style.transform = 'scale(0.97)';
        if (dropdown) dropdown.classList.add('open');
        setTimeout(() => { if (!_cursorPaused) dpiSelect.style.transform = ''; }, 100);
      }, 3200));

      // Select 600 DPI from dropdown
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        const options = dropdown ? dropdown.querySelectorAll('.mock-select-option') : [];
        options.forEach(o => o.classList.remove('mock-option-highlight'));
        if (options[2]) options[2].classList.add('mock-option-highlight');
        const val = dpiSelect.querySelector('.mock-select-val');
        if (val) val.textContent = '600';
      }, 3700));

      // Close dropdown
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        if (dropdown) dropdown.classList.remove('open');
      }, 4100));

      // Move to password toggle
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        clearHoverRing();
        showCursorLabel('启用密码保护');
        const pwToggle = toggles[2] || toggles[1];
        if (pwToggle) {
          const rect = pwToggle.getBoundingClientRect();
          const panelRect = visual.getBoundingClientRect();
          moveCursor(
            rect.left - panelRect.left + rect.width / 2,
            rect.top - panelRect.top + rect.height / 2,
            0.6
          );
          setHoverRing(pwToggle);
        }
      }, 4400));

      // Click password toggle
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        cursorClick();
        const t = toggles[2] || toggles[1];
        if (t) {
          t.classList.toggle('on');
          t.style.transform = 'scale(1.1)';
          setTimeout(() => { if (!_cursorPaused) t.style.transform = ''; }, 200);
        }
      }, 5000));

      // Fade out
      cursorTimers.push(setTimeout(() => {
        hideCursorLabel();
        hideCursor();
        dpiSelect.style.borderColor = '';
        dpiSelect.style.boxShadow = '';
        const val = dpiSelect.querySelector('.mock-select-val');
        if (val) val.textContent = '300';
        clearHoverRing();
      }, 5500));
    },

    convert(visual) {
      if (!cursor || !visual) return;
      const queueItem = getElCenter('.mock-queue-item', visual);
      if (!queueItem) return;

      cursorStopIdle();
      cursor.style.left = (queueItem.x + 120) + 'px';
      cursor.style.top = (queueItem.y - 20) + 'px';

      // Enter and hover near progress
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        showCursor();
        showCursorLabel('正在转换...');
        moveCursorSmooth(queueItem.x + 40, queueItem.y - 15, 0.8);
      }, 200));

      // Idle hover while progress fills
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        cursorIdle();
      }, 1200));

      // Drift away when done
      cursorTimers.push(setTimeout(() => {
        cursorStopIdle();
        hideCursorLabel();
        hideCursor();
      }, 4500));
    },

    complete(visual) {
      if (!cursor || !visual) return;
      const downloadBtn = getElCenter('.mock-btn-download', visual);
      const previewBtn = getElCenter('.mock-btn-preview', visual);
      if (!downloadBtn) return;

      cursorStopIdle();
      cursor.style.left = (downloadBtn.x + 80) + 'px';
      cursor.style.top = (downloadBtn.y + 20) + 'px';

      // Move to download button
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        showCursor();
        showCursorLabel('点击下载');
        moveCursor(downloadBtn.x, downloadBtn.y, 0.8);
      }, 400));

      // Hover download button
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        const dlBtn = visual.querySelector('.mock-btn-download');
        if (dlBtn) {
          dlBtn.style.transform = 'scale(1.08)';
          dlBtn.style.boxShadow = '0 4px 12px oklch(58% 0.10 155 / 0.3)';
          setHoverRing(dlBtn);
        }
      }, 1200));

      // Click download — show checkmark
      cursorTimers.push(setTimeout(() => {
        if (_cursorPaused) return;
        cursorClick();
        const dlBtn = visual.querySelector('.mock-btn-download');
        if (dlBtn) {
          dlBtn.style.transform = 'scale(0.95)';
          setTimeout(() => { if (!_cursorPaused) dlBtn.style.transform = 'scale(1.08)'; }, 100);
        }
      }, 1600));

      // Move to preview button
      if (previewBtn) {
        cursorTimers.push(setTimeout(() => {
          if (_cursorPaused) return;
          clearHoverRing();
          showCursorLabel('预览文件');
          moveCursor(previewBtn.x, previewBtn.y, 0.6);
          const dlBtn = visual.querySelector('.mock-btn-download');
          if (dlBtn) { dlBtn.style.transform = ''; dlBtn.style.boxShadow = ''; }
        }, 2600));

        // Click preview
        cursorTimers.push(setTimeout(() => {
          if (_cursorPaused) return;
          cursorClick();
          const pvBtn = visual.querySelector('.mock-btn-preview');
          if (pvBtn) {
            pvBtn.style.background = 'var(--accent)';
            pvBtn.style.color = 'oklch(99% 0 0)';
            pvBtn.style.transform = 'scale(1.08)';
            setHoverRing(pvBtn);
          }
        }, 3200));
      }

      // Fade out
      cursorTimers.push(setTimeout(() => {
        hideCursorLabel();
        hideCursor();
        const dlBtn = visual.querySelector('.mock-btn-download');
        if (dlBtn) { dlBtn.style.transform = ''; dlBtn.style.boxShadow = ''; }
        const pvBtn = visual.querySelector('.mock-btn-preview');
        if (pvBtn) { pvBtn.style.background = ''; pvBtn.style.color = ''; pvBtn.style.transform = ''; }
        clearHoverRing();
      }, 4000));
    }
  };

  // ── CountUp with completion ──
  function startCountUp() {
    stopCountUp();
    if (!pctEl) return;
    let val = 0;
    pctEl.textContent = '0';
    const statusEl = container.querySelector('.mock-qi-status.processing');
    countUpTimer = setInterval(() => {
      val += 1;
      if (val > 100) {
        val = 100;
        pctEl.textContent = '100';
        if (statusEl) {
          statusEl.textContent = '已完成';
          statusEl.classList.remove('processing');
          statusEl.classList.add('done');
        }
        clearInterval(countUpTimer);
        countUpTimer = null;
        return;
      }
      pctEl.textContent = String(val);
    }, 35);
    _demoCountUpTimer = countUpTimer;
  }

  function stopCountUp() {
    if (countUpTimer) { clearInterval(countUpTimer); countUpTimer = null; _demoCountUpTimer = null; }
    // Reset status
    const statusEl = container.querySelector('.mock-qi-status.done');
    if (statusEl) {
      statusEl.textContent = '处理中';
      statusEl.classList.remove('done');
      statusEl.classList.add('processing');
    }
  }

  function resetAnimations(visual) {
    visual.classList.remove('active');
    void visual.offsetWidth;
    visual.classList.add('active');
  }

  // ── ARIA management ──
  function updateAria(index) {
    dots.forEach((dot, i) => {
      const isActive = i === index;
      dot.setAttribute('aria-selected', isActive ? 'true' : 'false');
      dot.setAttribute('tabindex', isActive ? '0' : '-1');
      if (isActive) dot.setAttribute('aria-current', 'step');
      else dot.removeAttribute('aria-current');
    });
    contents.forEach((content, i) => {
      const isActive = i === index;
      content.setAttribute('aria-hidden', isActive ? 'false' : 'true');
    });
    if (announcer) {
      announcer.textContent = `步骤 ${index + 1}: ${_stepTitles[index]}`;
    }
  }

  function showStep(index) {
    if (index < 0) index = _demoSteps.length - 1;
    if (index >= _demoSteps.length) index = 0;
    _currentDemoStep = index;

    clearCursorTimers();
    cursorStopIdle();
    clearHoverRing();
    hideCursorLabel();

    updateAria(index);

    dots.forEach((dot, i) => dot.classList.toggle('active', i === index));
    contents.forEach((content, i) => content.classList.toggle('active', i === index));

    let activeVisual = null;
    visuals.forEach((visual, i) => {
      if (i === index) {
        resetAnimations(visual);
        activeVisual = visual;
      } else {
        visual.classList.remove('active');
      }
    });

    // Reset mockup states
    container.querySelectorAll('.mock-file-card').forEach(fc => fc.classList.remove('visible'));
    container.querySelectorAll('.mock-select-dropdown').forEach(dd => dd.classList.remove('open'));
    container.querySelectorAll('.mock-select').forEach(s => { s.style.borderColor = ''; s.style.boxShadow = ''; });

    if (_demoSteps[index] === 'convert') {
      startCountUp();
    } else {
      stopCountUp();
    }

    // Launch cursor choreography after layout settles
    requestAnimationFrame(() => {
      if (!_cursorPaused && activeVisual && cursorChoreographies[_demoSteps[index]]) {
        cursorChoreographies[_demoSteps[index]](activeVisual);
      }
    });

    if (prevBtn) prevBtn.textContent = '上一步';
    if (nextBtn) nextBtn.textContent = index === _demoSteps.length - 1 ? '完成' : '下一步';

    // Schedule next auto-advance
    scheduleAutoAdvance();
  }

  // ── Auto-advance with per-step timing ──
  function scheduleAutoAdvance() {
    if (_demoAutoPlayTimer) clearTimeout(_demoAutoPlayTimer);
    if (!_demoAutoPlay) return;
    const dur = _stepDurations[_demoSteps[_currentDemoStep]] || 5000;
    _demoAutoPlayTimer = setTimeout(() => {
      if (_demoAutoPlay && !_cursorPaused) {
        showStep(_currentDemoStep + 1);
      }
    }, dur);
  }

  // ── Pause / Play ──
  function toggleAutoPlay() {
    _demoAutoPlay = !_demoAutoPlay;
    if (pauseBtn) {
      pauseBtn.setAttribute('aria-pressed', String(!_demoAutoPlay));
      pauseBtn.setAttribute('aria-label', _demoAutoPlay ? '暂停自动播放' : '继续自动播放');
      pauseBtn.textContent = _demoAutoPlay ? '⏸' : '▶';
    }
    if (_demoAutoPlay) {
      scheduleAutoAdvance();
      // Re-launch cursor for current step
      const activeVisual = container.querySelector('.demo-step-visual.active');
      if (activeVisual && !_cursorPaused && cursorChoreographies[_demoSteps[_currentDemoStep]]) {
        cursorChoreographies[_demoSteps[_currentDemoStep]](activeVisual);
      }
    } else {
      if (_demoAutoPlayTimer) clearTimeout(_demoAutoPlayTimer);
    }
  }

  // ── Keyboard navigation for dots (roving tabindex) ──
  function handleDotKeydown(e) {
    const dotArr = Array.from(dots);
    const currentIdx = dotArr.indexOf(document.activeElement);
    if (currentIdx === -1) return;

    let targetIdx = currentIdx;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        targetIdx = (currentIdx + 1) % dotArr.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        targetIdx = (currentIdx - 1 + dotArr.length) % dotArr.length;
        break;
      case 'Home':
        e.preventDefault();
        targetIdx = 0;
        break;
      case 'End':
        e.preventDefault();
        targetIdx = dotArr.length - 1;
        break;
      default:
        return;
    }
    showStep(targetIdx);
    dots[targetIdx].focus();
  }

  // ── Event handlers ──
  const handlers = [];
  function on(el, evt, fn) { el.addEventListener(evt, fn); handlers.push([el, evt, fn]); }

  dots.forEach((dot) => {
    on(dot, 'click', () => {
      const idx = Array.from(dots).indexOf(dot);
      showStep(idx);
    });
    on(dot, 'keydown', handleDotKeydown);
  });

  if (prevBtn) on(prevBtn, 'click', () => showStep(_currentDemoStep - 1));
  if (nextBtn) on(nextBtn, 'click', () => showStep(_currentDemoStep === _demoSteps.length - 1 ? 0 : _currentDemoStep + 1));
  if (pauseBtn) on(pauseBtn, 'click', toggleAutoPlay);

  // Pause on hover
  on(container, 'mouseenter', () => {
    _cursorPaused = true;
    if (_demoAutoPlayTimer) clearTimeout(_demoAutoPlayTimer);
    clearCursorTimers();
    cursorStopIdle();
    hideCursor();
    hideCursorLabel();
    clearHoverRing();
  });

  on(container, 'mouseleave', () => {
    _cursorPaused = false;
    scheduleAutoAdvance();
    const activeVisual = container.querySelector('.demo-step-visual.active');
    if (activeVisual && cursorChoreographies[_demoSteps[_currentDemoStep]]) {
      requestAnimationFrame(() => {
        cursorChoreographies[_demoSteps[_currentDemoStep]](activeVisual);
      });
    }
  });

  // ── Cleanup function ──
  _demoCleanupFn = function() {
    if (_demoAutoPlayTimer) clearTimeout(_demoAutoPlayTimer);
    stopCountUp();
    clearCursorTimers();
    cursorStopIdle();
    hideCursor();
    hideCursorLabel();
    clearHoverRing();
    handlers.forEach(([el, evt, fn]) => el.removeEventListener(evt, fn));
    handlers.length = 0;
  };

  showStep(0);
}

// ── 演示模式切换 ──
let _demoModeActive = false;
let _demoCountUpTimer = null;

function stopDemoCountUp() {
  if (_demoCountUpTimer) { clearInterval(_demoCountUpTimer); _demoCountUpTimer = null; }
}

function toggleDemoMode() {
  const bodyNeo = document.getElementById('hmBodyNeo');
  const demoView = document.getElementById('hmDemoView');
  const toggleBtn = document.querySelector('.hm-demo-toggle');

  if (!bodyNeo || !demoView || !toggleBtn) return;

  _demoModeActive = !_demoModeActive;

  if (_demoModeActive) {
    bodyNeo.style.display = 'none';
    demoView.classList.add('active');
    toggleBtn.classList.add('active');
    initHelpDemo(demoView);
  } else {
    if (_demoCleanupFn) { _demoCleanupFn(); _demoCleanupFn = null; }
    stopDemoCountUp();
    bodyNeo.style.display = 'flex';
    demoView.classList.remove('active');
    toggleBtn.classList.remove('active');
  }
}

// 帮助模态框阅读区域缩放和拖拽功能
let _helpZoomLevel = 1;
let _helpIsDragging = false;
let _helpDragStartX = 0;
let _helpDragStartY = 0;
let _helpScrollLeft = 0;
let _helpScrollTop = 0;

function initHelpContentInteractions() {
  const contentEl = document.getElementById('helpContent');
  if (!contentEl) return;

  // Ctrl + 滚轮缩放
  contentEl.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      _helpZoomLevel = Math.max(0.5, Math.min(2, _helpZoomLevel + delta));
      contentEl.style.transform = `scale(${_helpZoomLevel})`;
      contentEl.style.transformOrigin = 'top left';
    }
  }, { passive: false });

  // 鼠标拖拽滚动
  contentEl.addEventListener('mousedown', (e) => {
    // 只有左键且不是点击链接时才触发拖拽
    if (e.button !== 0 || e.target.closest('a')) return;
    _helpIsDragging = true;
    _helpDragStartX = e.pageX - contentEl.offsetLeft;
    _helpDragStartY = e.pageY - contentEl.offsetTop;
    _helpScrollLeft = contentEl.scrollLeft;
    _helpScrollTop = contentEl.scrollTop;
    contentEl.style.cursor = 'grabbing';
    contentEl.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!_helpIsDragging) return;
    e.preventDefault();
    const x = e.pageX - contentEl.offsetLeft;
    const y = e.pageY - contentEl.offsetTop;
    const walkX = (_helpDragStartX - x) * 1.5;
    const walkY = (_helpDragStartY - y) * 1.5;
    contentEl.scrollLeft = _helpScrollLeft + walkX;
    contentEl.scrollTop = _helpScrollTop + walkY;
  });

  document.addEventListener('mouseup', () => {
    if (_helpIsDragging) {
      _helpIsDragging = false;
      contentEl.style.cursor = '';
      contentEl.style.userSelect = '';
    }
  });

  // 双击重置缩放
  contentEl.addEventListener('dblclick', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      _helpZoomLevel = 1;
      contentEl.style.transform = 'scale(1)';
    }
  });
}

// 初始化帮助内容交互
document.addEventListener('DOMContentLoaded', initHelpContentInteractions);

document.addEventListener('keydown', (e) => {
  // Settings panel escape
  if (e.key === 'Escape' && _isSettingsOpen()) {
    closeSettings();
    return;
  }

  const overlay = document.getElementById('helpModalOverlay');
  const isVisible = overlay && overlay.classList.contains('visible');

  if (e.key === 'Escape' && isVisible) {
    closeHelp();
    return;
  }

  // Focus trap inside modal
  if (isVisible && e.key === 'Tab') {
    const modal = overlay.querySelector('.help-modal');
    if (!modal) return;
    const focusable = modal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
});
