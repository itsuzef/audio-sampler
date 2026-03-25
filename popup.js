const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');
const waveformCanvas = document.getElementById('waveform');
const idleMessage = document.getElementById('idleMessage');
const timerDisplay = document.getElementById('timer');
const headerDot = document.getElementById('headerDot');

const ctx = waveformCanvas.getContext('2d');

let mediaRecorder = null;
let audioChunks = [];
let recordedBlob = null;
let audioStream = null;
let audioContext = null;
let analyser = null;
let animationId = null;
let timerInterval = null;
let secondsElapsed = 0;
let tabTitle = '';

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (type ? ' ' + type : '');
}

function setDot(state) {
  headerDot.className = 'header-dot' + (state ? ' ' + state : '');
}

function formatTime(secs) {
  const m = String(Math.floor(secs / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function startTimer() {
  secondsElapsed = 0;
  timerDisplay.textContent = '00:00';
  timerDisplay.classList.add('recording');
  timerInterval = setInterval(() => {
    secondsElapsed++;
    timerDisplay.textContent = formatTime(secondsElapsed);
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerDisplay.classList.remove('recording');
}

function startWaveform(stream) {
  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);
  source.connect(audioContext.destination);

  waveformCanvas.style.display = 'block';
  idleMessage.style.display = 'none';

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    animationId = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(dataArray);

    const w = waveformCanvas.width;
    const h = waveformCanvas.height;

    ctx.clearRect(0, 0, w, h);

    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#7C6FFF';
    ctx.shadowBlur = 10;
    ctx.shadowColor = 'rgba(124, 111, 255, 0.6)';
    ctx.beginPath();

    const sliceWidth = w / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = (v * h) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }

    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  draw();
}

function stopWaveform() {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  ctx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
  waveformCanvas.style.display = 'none';
  idleMessage.style.display = 'flex';
}

recordBtn.addEventListener('click', async () => {
  setStatus('Requesting tab audio capture...');

  chrome.runtime.sendMessage({ action: 'getStreamId' }, async (response) => {
    if (chrome.runtime.lastError) {
      setStatus('Error: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    if (response.error) {
      setStatus('Error: ' + response.error, 'error');
      setDot('');
      return;
    }

    tabTitle = response.tabTitle || '';
    const streamId = response.streamId;

    try {
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
      audioChunks = [];
      recordedBlob = null;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      mediaRecorder = new MediaRecorder(stream, { mimeType });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunks, { type: mimeType });
        convertToWav(blob).then((wavBlob) => {
          recordedBlob = wavBlob;
          saveBtn.disabled = false;
          setDot('ready');
          setStatus(`Recorded ${formatTime(secondsElapsed)} — ready to save`, 'success');
        }).catch(() => {
          recordedBlob = blob;
          saveBtn.disabled = false;
          setDot('ready');
          setStatus(`Recorded ${formatTime(secondsElapsed)} — ready to save`, 'success');
        });
      };

      mediaRecorder.start(100);
      startWaveform(stream);
      startTimer();
      setDot('active');

      recordBtn.disabled = true;
      recordBtn.classList.add('recording');
      stopBtn.disabled = false;
      saveBtn.disabled = true;
      setStatus('Recording tab audio...');

    } catch (err) {
      setStatus('Failed to start recording: ' + err.message, 'error');
      setDot('');
    }
  });
});

stopBtn.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (audioStream) {
    audioStream.getTracks().forEach((t) => t.stop());
    audioStream = null;
  }
  stopWaveform();
  stopTimer();
  setDot('');

  recordBtn.disabled = false;
  recordBtn.classList.remove('recording');
  stopBtn.disabled = true;
  setStatus('Processing...');
});

saveBtn.addEventListener('click', () => {
  if (!recordedBlob) return;
  const url = URL.createObjectURL(recordedBlob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = tabTitle
    ? tabTitle.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 80)
    : '';
  a.href = url;
  a.download = `${safeName || 'recording'}-${ts}.wav`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus('Saved!', 'success');
});

async function convertToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const offlineCtx = new OfflineAudioContext(2, 1, 44100);
  const decoded = await new Promise((resolve, reject) => {
    const ctx2 = new AudioContext();
    ctx2.decodeAudioData(arrayBuffer, resolve, reject);
  });

  const sampleRate = decoded.sampleRate;
  const numberOfChannels = decoded.numberOfChannels;
  const length = decoded.length;

  const offlineContext = new OfflineAudioContext(numberOfChannels, length, sampleRate);
  const source = offlineContext.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineContext.destination);
  source.start(0);

  const renderedBuffer = await offlineContext.startRendering();
  return audioBufferToWav(renderedBuffer);
}

function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1;
  const bitDepth = 16;

  const dataLength = buffer.length * numChannels * (bitDepth / 8);
  const wavBuffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(wavBuffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
  view.setUint16(32, numChannels * (bitDepth / 8), true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([wavBuffer], { type: 'audio/wav' });
}
