let mediaRecorder = null;
let audioStream = null;
let audioContext = null;
let analyser = null;
let chunks = [];
let mimeType = '';
let recordedBlob = null;
const blobUrls = new Set();
let waveformLoopId = null;
let startTime = 0;

const WAVEFORM_INTERVAL_MS = 50;

function tearDownStream() {
  stopWaveformLoop();
  if (audioStream) {
    try { audioStream.getTracks().forEach((t) => t.stop()); } catch {}
    audioStream = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  analyser = null;
}

function stopWaveformLoop() {
  if (waveformLoopId) {
    clearInterval(waveformLoopId);
    waveformLoopId = null;
  }
}

function startWaveformLoop() {
  stopWaveformLoop();
  if (!analyser) return;
  const buf = new Uint8Array(analyser.frequencyBinCount);
  waveformLoopId = setInterval(() => {
    if (!analyser) return;
    analyser.getByteTimeDomainData(buf);
    chrome.runtime.sendMessage(
      { target: 'popup', type: 'waveform', data: Array.from(buf) },
      () => void chrome.runtime.lastError
    );
  }, WAVEFORM_INTERVAL_MS);
}

async function startRecording(streamId) {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    throw new Error('Already recording');
  }
  reset();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });
  audioStream = stream;

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  source.connect(audioContext.destination);

  mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  chunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  mediaRecorder.onerror = (e) => {
    chrome.runtime.sendMessage({
      target: 'background',
      action: 'offscreenError',
      error: (e && e.error && e.error.message) || 'MediaRecorder error',
    });
  };

  mediaRecorder.start(250);
  startTime = Date.now();
  startWaveformLoop();
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    throw new Error('No active recording');
  }
  const durationMs = Date.now() - startTime;

  const finished = new Promise((resolve) => {
    mediaRecorder.onstop = () => resolve();
  });
  mediaRecorder.stop();
  await finished;

  tearDownStream();

  const webmBlob = new Blob(chunks, { type: mimeType });
  chunks = [];

  try {
    recordedBlob = await webmToWav(webmBlob);
  } catch {
    recordedBlob = webmBlob;
  }

  return { durationMs };
}

function getBlobUrl() {
  if (!recordedBlob) throw new Error('No recording to save');
  const url = URL.createObjectURL(recordedBlob);
  blobUrls.add(url);
  return url;
}

function revokeBlobUrl(url) {
  if (blobUrls.has(url)) {
    URL.revokeObjectURL(url);
    blobUrls.delete(url);
  }
}

function reset() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch {}
  }
  mediaRecorder = null;
  tearDownStream();
  chunks = [];
  for (const url of blobUrls) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  blobUrls.clear();
  recordedBlob = null;
  startTime = 0;
}

async function webmToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new AudioContext();
  try {
    const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
    return audioBufferToWav(decoded);
  } finally {
    decodeCtx.close().catch(() => {});
  }
}

function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const dataLength = buffer.length * numChannels * bytesPerSample;
  const wavBuffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(wavBuffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([wavBuffer], { type: 'audio/wav' });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  (async () => {
    try {
      if (msg.action === 'start') {
        await startRecording(msg.streamId);
        sendResponse({ ok: true });
      } else if (msg.action === 'stop') {
        const { durationMs } = await stopRecording();
        sendResponse({ ok: true, durationMs });
      } else if (msg.action === 'getBlobUrl') {
        sendResponse({ ok: true, url: getBlobUrl() });
      } else if (msg.action === 'revokeBlobUrl') {
        revokeBlobUrl(msg.url);
        sendResponse({ ok: true });
      } else if (msg.action === 'reset') {
        reset();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'Unknown action: ' + msg.action });
      }
    } catch (err) {
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    }
  })();
  return true;
});
