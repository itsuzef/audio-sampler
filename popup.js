const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');
const waveformCanvas = document.getElementById('waveform');
const idleMessage = document.getElementById('idleMessage');
const timerDisplay = document.getElementById('timer');
const headerDot = document.getElementById('headerDot');

const ctx = waveformCanvas.getContext('2d');

let port = null;
let timerInterval = null;
let streamStartedAt = null;
let lastDurationMs = 0;
let currentStatus = 'idle';
let waveformBuffer = null;
let waveformDirty = false;
let rafId = null;

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (type ? ' ' + type : '');
}

function setDot(s) {
  headerDot.className = 'header-dot' + (s ? ' ' + s : '');
}

function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function startTimer() {
  stopTimer();
  const tick = () => {
    const elapsed = streamStartedAt ? Date.now() - streamStartedAt : lastDurationMs;
    timerDisplay.textContent = formatTime(elapsed);
  };
  tick();
  timerInterval = setInterval(tick, 250);
  timerDisplay.classList.add('recording');
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  timerDisplay.classList.remove('recording');
}

function showWaveform() {
  waveformCanvas.style.display = 'block';
  idleMessage.style.display = 'none';
  if (!rafId) loopDrawWaveform();
}

function hideWaveform() {
  waveformCanvas.style.display = 'none';
  idleMessage.style.display = 'flex';
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  waveformBuffer = null;
  ctx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
}

function loopDrawWaveform() {
  rafId = requestAnimationFrame(loopDrawWaveform);
  if (!waveformDirty || !waveformBuffer) return;
  waveformDirty = false;

  const w = waveformCanvas.width;
  const h = waveformCanvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#7C6FFF';
  ctx.shadowBlur = 10;
  ctx.shadowColor = 'rgba(124, 111, 255, 0.6)';
  ctx.beginPath();

  const len = waveformBuffer.length;
  const slice = w / len;
  let x = 0;
  for (let i = 0; i < len; i++) {
    const v = waveformBuffer[i] / 128.0;
    const y = (v * h) / 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    x += slice;
  }
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function applyState(s) {
  currentStatus = s.status;

  if (s.status === 'recording') {
    streamStartedAt = Date.now() - (s.durationMs || 0);
    lastDurationMs = s.durationMs || 0;
    setDot('active');
    showWaveform();
    startTimer();
    recordBtn.disabled = true;
    recordBtn.classList.add('recording');
    stopBtn.disabled = false;
    saveBtn.disabled = true;
    setStatus('Recording tab audio...');
    return;
  }

  if (s.status === 'requesting') {
    streamStartedAt = null;
    setDot('');
    recordBtn.disabled = true;
    recordBtn.classList.remove('recording');
    stopBtn.disabled = true;
    saveBtn.disabled = true;
    setStatus('Requesting tab audio capture...');
    return;
  }

  if (s.status === 'processing') {
    streamStartedAt = null;
    lastDurationMs = s.durationMs || lastDurationMs;
    stopTimer();
    timerDisplay.textContent = formatTime(lastDurationMs);
    setDot('');
    recordBtn.disabled = true;
    recordBtn.classList.remove('recording');
    stopBtn.disabled = true;
    saveBtn.disabled = true;
    setStatus('Processing...');
    return;
  }

  if (s.status === 'ready') {
    streamStartedAt = null;
    lastDurationMs = s.durationMs || lastDurationMs;
    stopTimer();
    hideWaveform();
    timerDisplay.textContent = formatTime(lastDurationMs);
    setDot('ready');
    recordBtn.disabled = false;
    recordBtn.classList.remove('recording');
    stopBtn.disabled = true;
    saveBtn.disabled = false;
    if (s.errorMsg) setStatus(s.errorMsg, 'error');
    else setStatus(`Recorded ${formatTime(lastDurationMs)} — ready to save`, 'success');
    return;
  }

  if (s.status === 'saving') {
    setStatus('Saving...');
    saveBtn.disabled = true;
    return;
  }

  if (s.status === 'error') {
    streamStartedAt = null;
    stopTimer();
    hideWaveform();
    setDot('');
    recordBtn.disabled = false;
    recordBtn.classList.remove('recording');
    stopBtn.disabled = true;
    saveBtn.disabled = true;
    timerDisplay.textContent = '00:00';
    setStatus('Error: ' + (s.errorMsg || 'unknown'), 'error');
    return;
  }

  // idle
  streamStartedAt = null;
  lastDurationMs = 0;
  stopTimer();
  hideWaveform();
  timerDisplay.textContent = '00:00';
  setDot('');
  recordBtn.disabled = false;
  recordBtn.classList.remove('recording');
  stopBtn.disabled = true;
  saveBtn.disabled = true;
  setStatus('Press record to begin');
}

function connect() {
  port = chrome.runtime.connect({ name: 'popup' });
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === 'state') applyState(msg.state);
  });
  port.onDisconnect.addListener(() => {
    port = null;
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'popup') return;
  if (msg.type === 'waveform' && Array.isArray(msg.data)) {
    waveformBuffer = msg.data;
    waveformDirty = true;
  }
});

recordBtn.addEventListener('click', () => {
  if (!port) connect();
  port.postMessage({ action: 'start' });
});

stopBtn.addEventListener('click', () => {
  port && port.postMessage({ action: 'stop' });
});

saveBtn.addEventListener('click', () => {
  port && port.postMessage({ action: 'save' });
});

connect();
