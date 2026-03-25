# Audio Sampler

A Chrome extension that records audio from any browser tab and saves it as a WAV file — no external software or setup required.

---

## Features

- One-click recording of any tab's audio output
- Live waveform visualizer during recording
- Audio passthrough — you continue hearing the tab normally while recording
- Exports clean 16-bit PCM WAV files
- Timestamped filenames for every recording

---

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `audio-sampler` folder
5. The extension icon will appear in your toolbar

---

## Usage

1. Navigate to any tab playing audio (YouTube, Spotify Web, a podcast, etc.)
2. Click the **Audio Sampler** toolbar icon
3. Press **Record** — Chrome will ask for tab capture permission on first use
4. Press **Stop** when done
5. Press **Save WAV** to download the file

Files are saved as `recording-YYYY-MM-DDTHH-MM-SS.wav` in your default downloads folder.

---

## How It Works

### Architecture

The extension is built on **Manifest V3** and consists of three parts:

```
background.js   — service worker (tab capture coordination)
popup.html/css  — the UI rendered when the toolbar icon is clicked
popup.js        — all recording, audio graph, and export logic
```

### 1. Requesting a Tab Stream ID (`background.js`)

When the user clicks **Record**, the popup sends a `getStreamId` message to the background service worker. The background calls `chrome.tabCapture.getMediaStreamId()` targeting the currently active tab, which returns an opaque stream ID string.

This two-step design is required in Manifest V3 — service workers cannot hold live `MediaStream` objects, so only the lightweight ID is passed back to the popup.

```
Popup → [message: getStreamId] → Background
Background → chrome.tabCapture.getMediaStreamId() → Chrome
Chrome → streamId → Background → Popup
```

### 2. Opening the Audio Stream (`popup.js`)

The popup takes the stream ID and calls `navigator.mediaDevices.getUserMedia()` with `chromeMediaSource: 'tab'` and the received `chromeMediaSourceId`. This opens a live `MediaStream` of the tab's audio inside the popup's JavaScript context.

### 3. Audio Graph

Once the stream is open, a Web Audio API graph is constructed:

```
MediaStream
    └─► MediaStreamSource
            ├─► AnalyserNode  ──► Canvas waveform draw loop
            └─► AudioDestination  (speakers — passthrough so user can still hear)
```

The `AnalyserNode` feeds time-domain PCM data into a `requestAnimationFrame` draw loop that renders the live waveform on a `<canvas>` element. Connecting the source to `AudioDestination` ensures the tab audio is not muted for the user while being captured.

### 4. Recording (`MediaRecorder`)

A `MediaRecorder` is attached to the same `MediaStream`, capturing encoded audio chunks every 100 ms into an array of `Blob` segments. The codec used is `audio/webm;codecs=opus` (falling back to `audio/webm` if unavailable) — this is the most efficient format Chrome's `MediaRecorder` supports natively.

### 5. WAV Export

On stop, the collected chunks are reassembled into a single WebM blob. Because browsers don't export WAV natively, a two-stage conversion is performed entirely in the browser:

**Stage 1 — Decode:** `AudioContext.decodeAudioData()` decodes the WebM/Opus blob into a raw `AudioBuffer` (uncompressed PCM float32 samples).

**Stage 2 — Re-render:** An `OfflineAudioContext` renders the buffer at its native sample rate, producing a final `AudioBuffer` with the correct channel count and duration.

**Stage 3 — WAV encode:** A custom writer builds a valid RIFF WAV file in an `ArrayBuffer`:
- 44-byte header (`RIFF`, `WAVE`, `fmt `, `data` chunks)
- 16-bit PCM samples, interleaved by channel, little-endian

The result is wrapped in a `Blob` with type `audio/wav` and downloaded via a temporary `<a>` element.

### 6. Permissions

| Permission | Why |
|---|---|
| `tabCapture` | Required to capture a tab's audio stream |
| `activeTab` | Required to resolve the current tab's ID in the background worker |
| `scripting` | Declared for potential future content script injection |

---

## File Structure

```
audio-sampler/
├── manifest.json       Chrome extension manifest (MV3)
├── background.js       Service worker — issues tab capture stream IDs
├── popup.html          Extension popup markup
├── popup.css           Popup styles (Inter font, dark theme)
├── popup.js            Recording logic, audio graph, WAV encoder
├── icons/
│   ├── icon.svg        Source icon (editable)
│   ├── icon16.png      Toolbar icon
│   ├── icon48.png      Extension management icon
│   └── icon128.png     Chrome Web Store icon
└── req.md              Original requirements
```

---

## Browser Compatibility

Requires **Chrome 116+** (Manifest V3 + `tabCapture.getMediaStreamId` support). Does not work in Firefox or Safari as `tabCapture` is a Chrome-only API.
