const OFFSCREEN_PATH = 'offscreen.html';
const STATE_KEY = 'audioSamplerState';

const state = {
  status: 'idle',
  startedAt: null,
  durationMs: 0,
  tabTitle: '',
  errorMsg: '',
};

const popupPorts = new Set();
let offscreenReadyPromise = null;

const ready = (async () => {
  try {
    const stored = await chrome.storage.session.get(STATE_KEY);
    if (stored && stored[STATE_KEY]) Object.assign(state, stored[STATE_KEY]);
  } catch {}
  await reconcileState();
})();

async function reconcileState() {
  // If we think we're recording but the offscreen doc was torn down,
  // reset back to idle so the UI reflects reality.
  const transient = state.status === 'recording' || state.status === 'processing' || state.status === 'requesting' || state.status === 'saving';
  if (transient && !(await hasOffscreenDocument())) {
    state.status = 'idle';
    state.startedAt = null;
    state.durationMs = 0;
    state.errorMsg = '';
    await persistState();
  }
}

async function persistState() {
  try {
    await chrome.storage.session.set({ [STATE_KEY]: { ...state } });
  } catch {}
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) {
    return false;
  }
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (offscreenReadyPromise) return offscreenReadyPromise;
  offscreenReadyPromise = (async () => {
    if (await hasOffscreenDocument()) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA'],
      justification: 'Record tab audio with MediaRecorder while popup is closed',
    });
  })();
  try {
    await offscreenReadyPromise;
  } finally {
    offscreenReadyPromise = null;
  }
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    try {
      await chrome.offscreen.closeDocument();
    } catch {}
  }
}

function snapshot() {
  let duration = state.durationMs;
  if (state.status === 'recording' && state.startedAt) {
    duration = Date.now() - state.startedAt;
  }
  return {
    status: state.status,
    durationMs: duration,
    tabTitle: state.tabTitle,
    errorMsg: state.errorMsg,
  };
}

function broadcastState() {
  persistState();
  const snap = snapshot();
  for (const port of popupPorts) {
    try {
      port.postMessage({ type: 'state', state: snap });
    } catch {}
  }
}

function sendToOffscreen(action, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: 'offscreen', action, ...extra }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: false, error: 'No response from offscreen' });
      }
    });
  });
}

async function resetOffscreen() {
  if (await hasOffscreenDocument()) {
    await sendToOffscreen('reset');
  }
}

async function startRecording() {
  if (state.status === 'requesting' || state.status === 'recording' || state.status === 'processing') {
    return;
  }
  state.status = 'requesting';
  state.errorMsg = '';
  broadcastState();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab found');
    state.tabTitle = tab.title || '';

    await ensureOffscreenDocument();
    await resetOffscreen();

    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!id) reject(new Error('Failed to acquire stream'));
        else resolve(id);
      });
    });

    const result = await sendToOffscreen('start', { streamId });
    if (!result.ok) throw new Error(result.error || 'Offscreen start failed');

    state.startedAt = Date.now();
    state.durationMs = 0;
    state.status = 'recording';
    broadcastState();
  } catch (err) {
    state.status = 'error';
    state.errorMsg = err.message || String(err);
    broadcastState();
  }
}

async function stopRecording() {
  if (state.status !== 'recording') return;
  state.status = 'processing';
  state.durationMs = state.startedAt ? Date.now() - state.startedAt : 0;
  broadcastState();

  try {
    const result = await sendToOffscreen('stop');
    if (!result.ok) throw new Error(result.error || 'Offscreen stop failed');
    state.durationMs = result.durationMs || state.durationMs;
    state.startedAt = null;
    state.status = 'ready';
    broadcastState();
  } catch (err) {
    state.status = 'error';
    state.errorMsg = err.message || String(err);
    broadcastState();
  }
}

async function saveRecording() {
  if (state.status !== 'ready') return;
  state.status = 'saving';
  broadcastState();

  let downloadUrl = null;
  try {
    const result = await sendToOffscreen('getBlobUrl');
    if (!result.ok) throw new Error(result.error || 'No recording available');
    downloadUrl = result.url;

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safe = (state.tabTitle || '')
      .replace(/[\\/:*?"<>|]/g, '')
      .trim()
      .slice(0, 80);
    const filename = `${safe || 'recording'}-${ts}.wav`;

    const downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download({ url: downloadUrl, filename, saveAs: false }, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    });

    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (!delta.state) return;
      const cur = delta.state.current;
      if (cur === 'complete' || cur === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        sendToOffscreen('revokeBlobUrl', { url: downloadUrl });
        state.status = 'ready';
        if (cur === 'complete') {
          state.errorMsg = '';
        } else {
          state.errorMsg = 'Download interrupted';
        }
        broadcastState();
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  } catch (err) {
    if (downloadUrl) sendToOffscreen('revokeBlobUrl', { url: downloadUrl });
    state.status = 'ready';
    state.errorMsg = err.message || String(err);
    broadcastState();
  }
}

async function discardRecording() {
  await resetOffscreen();
  await closeOffscreenDocument();
  state.status = 'idle';
  state.startedAt = null;
  state.durationMs = 0;
  state.tabTitle = '';
  state.errorMsg = '';
  broadcastState();
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  popupPorts.add(port);
  ready.then(() => {
    try { port.postMessage({ type: 'state', state: snapshot() }); } catch {}
  });
  port.onMessage.addListener(async (msg) => {
    if (!msg || !msg.action) return;
    await ready;
    if (msg.action === 'start') startRecording();
    else if (msg.action === 'stop') stopRecording();
    else if (msg.action === 'save') saveRecording();
    else if (msg.action === 'discard') discardRecording();
    else if (msg.action === 'getState') {
      try { port.postMessage({ type: 'state', state: snapshot() }); } catch {}
    }
  });
  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'background') return false;
  if (msg.action === 'offscreenError') {
    state.status = 'error';
    state.errorMsg = msg.error || 'Recording error';
    broadcastState();
  }
  return false;
});
