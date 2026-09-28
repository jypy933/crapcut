# Architecture

CrapCut is an Electron app. All work (downloads, AI, FFmpeg, files, database)
happens in the **main process**. The **renderer** is a sandboxed React UI that
can only call a small, validated IPC API.

```
renderer (sandboxed React UI)
   │  window.crapcut.invoke(channel, args)      ← preload exposes only this
   ▼
main process
   ├─ ipc.ts          checks sender, validates args with zod, returns results
   ├─ services.ts     wires the long-lived services
   ├─ store.ts        SQLite (node:sqlite): jobs, steps, clips, layouts, exports
   ├─ pipeline/
   │   ├─ runner.ts   one job at a time, step checkpoints, retries, pause/continue
   │   ├─ steps.ts    metadata → chat → audio → transcribe → moments → clips
   │   ├─ exporter.ts export lane: renders kept clips one at a time
   │   └─ gpuLock.ts  one AI model on the GPU at a time
   ├─ tools/          pinned downloads, checksums, GPU detection, process runner
   └─ core/           pure logic, unit-tested without Electron
```

## Pipeline

A job is one VOD. Each step writes its result to the job folder
(`%LOCALAPPDATA%\CrapCut\jobs\<id>`) with atomic writes and records its state
in SQLite. On restart, interrupted jobs show **Continue**; each step checks what
is already on disk and carries on.

| Step | Tool | Output |
| --- | --- | --- |
| metadata | yt-dlp `-J`, audio playlist | `meta.json` (title, length, chapters, muted ranges) |
| chat | TwitchDownloaderCLI | `chat.txt` |
| audio | yt-dlp (audio only), FFmpeg | `audio.mp4`, `audio16k.wav` (temporary), `loudness.txt`, `muted.json` |
| transcribe | whisper.cpp, 10-minute chunks cut at quiet seconds | `transcript/chunk-NNN.json` → `transcript.json` |
| moments | `core/moments.ts` + llama-server | clips in SQLite, `moments.json` |
| clips | yt-dlp `--download-sections` + audio alignment | `clips/<clip>.mp4` |

### Finding moments

1. Chat reaction per second: messages weighted by laughter/hype/shock words,
   each chatter counted at most once every 3 seconds (anti-spam), bots ignored.
2. Robust z-score against a rolling 10-minute median, so a busy stream and a
   quiet one are judged against their own normal.
3. Peaks at least 45 s apart; the moment is placed a few seconds **before** the
   chat reaction (stream delay + typing time). Loud moments that chat missed
   are added from the audio loudness.
4. Stream start/end and Twitch-muted parts are skipped.
5. The local LLM gets each candidate's transcript excerpt and chat summary and
   returns JSON (keep, rating, start, end, title), constrained by a JSON schema
   and validated again. Without the LLM, cut points snap to pauses in speech
   and titles come from the transcript.

### Captions and layout

`shared/captions.ts` groups words into short on-screen chunks; the review
preview and the export use the same code. `core/ass.ts` writes an ASS file
with one event per word (the spoken word is highlighted). `shared/layoutGeometry.ts`
computes the facecam/game crops for both the canvas preview and FFmpeg.

### Clip timing

Section downloads can start a little off the requested time. After each clip
download, its audio is matched against the full stream audio
(`core/align.ts`, normalised cross-correlation of 10 ms loudness envelopes), so
captions and cuts stay frame-accurate.

## Hardware

`tools/gpu.ts` reads the display adapters from the registry (and `nvidia-smi`
on NVIDIA). whisper.cpp uses the CUDA build on NVIDIA (driver ≥ 452.39,
≥ 3.5 GB VRAM) and the CPU build otherwise; if the GPU run fails it falls back
to the CPU automatically. llama.cpp uses its Vulkan build (works on NVIDIA and
AMD, CPU fallback included). Video encoding tries NVENC / AMF / QSV with a
one-second test encode and falls back to libx264.

## Security

- `contextIsolation`, `sandbox`, no `nodeIntegration`, strict CSP, UI served
  from `app://bundle` (not `file://`), navigation/new windows/permissions/
  downloads blocked, Electron fuses set in the packaged app.
- IPC: fixed channel list, sender must be our page, every argument validated
  with zod; file paths never come from the UI (music is picked with a native
  dialog in main).
- External tools run via `spawn` with argument arrays, never a shell. Paths
  given to whisper/llama are relative to the CrapCut folder.
- Downloads: HTTPS only, allow-listed hosts (also after redirects), exact size
  and SHA-256 check, zip extraction refuses paths outside the target folder.
- The LLM server listens on 127.0.0.1 with a random API key and lives only
  for the moments step.
- Logs replace the home folder and user name before writing.

## Tests

- `npm test`: unit tests for all pure logic + render tests that generate media
  with FFmpeg (`testsrc2`, `sine`) and check the output with ffprobe.
- `npm run test:ui`: drives the built Electron app with Playwright (smoke test
  on CI; full click-through when `E2E_VOD` is set).
- `npm run e2e`: the whole pipeline on a real short VOD (`E2E_VOD=...`).
