# CrapCut

A free Windows desktop app that turns a public stream VOD into short, captioned
clips for TikTok, YouTube Shorts and Instagram Reels. The streamer pastes a VOD
link; CrapCut finds the best moments, cuts 9:16 vertical and 16:9 clips with
word-by-word captions, and lets him review and adjust them before export.

It is clip-first, not a full editor. It is a favour for one streamer friend, but
it is built like a real professional product. Open source, MIT licence.

## Hard rules

- **Everything runs locally.** No paid services, no cloud AI APIs, no accounts,
  no telemetry. Nobody ever pays for anything. The only network traffic is:
  downloading the VOD audio, chat replay and chosen video segments; the
  first-run download of pinned tools and models from their official sources;
  and checking GitHub Releases for app updates.
- **Source is Twitch VODs only** (`twitch.tv/videos/<id>`, public, no login).
  VOD audio is the streamer's voice plus game sound (his music is already
  excluded by his audio routing).
- **"Twitch" is never in the product name.** Nothing about the friend's channel
  is hardcoded.
- **Use existing tools, do not rebuild them.** FFmpeg decodes, filters and
  encodes; yt-dlp downloads media; TwitchDownloaderCLI downloads chat;
  whisper.cpp transcribes; llama.cpp (`llama-server` on `127.0.0.1`) runs the
  small local LLM. Our code is the UI, the job pipeline and the glue.
- **The pipeline degrades, never dies, without AI.** If the LLM is missing or
  fails, moments come from chat and audio signals with transcript-based cut
  points and titles. Only the tools strictly needed for a step block that step.

## Target machines

- **Friend (the real target):** Windows, Ryzen 7 5800X, 16 GB RAM, NVIDIA RTX
  3080 10 GB (CUDA, NVENC). His first run is the only NVIDIA test, so NVIDIA code
  paths must be conservative and fall back cleanly.
- **Owner (development):** Windows 11, i5-14400F, 32 GB RAM, AMD RX 9060 XT 8 GB
  (no CUDA; AMF encoders; Vulkan). FFmpeg 8.1.1 on PATH for development only;
  the app never relies on PATH tools.
- Detect the GPU and choose: CUDA + NVENC on NVIDIA, Vulkan + AMF on AMD, and a
  working CPU path (libx264, CPU whisper) everywhere. Encoders are chosen by
  actually probing them, not by assuming. One AI model runs at a time and must
  fit 8 GB VRAM.

## Pipeline

A job is one VOD. Each step is checkpointed and resumes after a crash, reboot or
close.

1. **Validate** the link (only `twitch.tv/videos/<id>`), read VOD metadata.
2. **Chat** replay via TwitchDownloaderCLI (JSON).
3. **Audio only** via yt-dlp (never the full video), plus muted-segment ranges.
4. **Transcribe** with whisper.cpp on the GPU, in chunks, with word timings.
5. **Find moments:** chat-activity spikes are the main signal, plus audio
   loudness and the transcript; the local LLM refines cut points and writes
   titles. Muted segments are skipped.
6. **Download only the chosen clips' video** (yt-dlp `--download-sections`),
   with padding so clips can be extended in review.
7. **Review:** accept/reject, trim/extend, fix caption text and placement,
   choose audio (Original / Voice only / Voice + quieter game / Voice + his own
   music), pick the layout.
8. **Export:** 9:16 with a facecam crop over the game (the user marks the cam
   once per layout) and/or 16:9, word-by-word burned-in captions. Voice
   separation (local stem-separation model) runs only on the chosen clips at
   export, never on the whole stream.

## Architecture

- **Stack:** Electron + React + TypeScript, built with electron-vite; Vitest for
  tests; electron-builder (NSIS) + electron-updater for install and updates.
- **Processes:** all tools, files and jobs live in the main process. The
  renderer is a sandboxed UI that talks to main over a small typed IPC surface
  (`src/shared/ipc.ts`), every message validated with zod on arrival.
- **Hardening:** `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, strict CSP, no remote content, navigation and new
  windows blocked, permission requests denied, Electron fuses set. External
  tools are launched with `execFile`/`spawn` argument arrays, never a shell.
- **Pure core:** link parsing, chat-spike scoring, moment selection, caption
  building (ASS), FFmpeg argument building and tool-manifest checks are pure
  functions in `src/main/core` (or `src/shared`) and unit-tested without
  Electron.
- **Tools are not bundled.** FFmpeg, yt-dlp, whisper.cpp, llama.cpp,
  TwitchDownloaderCLI and the AI models are downloaded on first run from their
  official sources, pinned to exact versions and verified against pinned
  SHA-256 checksums (`src/main/tools/manifest.ts`). The setup screen shows
  progress. A Python sidecar is allowed only where it is clearly the best tool
  (e.g. stem separation) and stays invisible to the user.
- **Storage:** tools, models and job work files under `%LOCALAPPDATA%\CrapCut`;
  finished clips under `Videos\CrapCut`. Job state is checkpointed on disk with
  atomic writes.

## Professional practices

- Long jobs: per-step checkpoints, resume, progress with time left, cancel,
  retry; disk-space and GPU checks before starting.
- Errors shown to the user are one plain sentence. Details go to a local log
  file (user name redacted from paths) that he can open and send. Never show raw
  logs or tool output in the UI.
- Releases are built by GitHub Actions on a Windows runner. v1 ships unsigned;
  after the first stable release, apply to SignPath Foundation (see
  `docs/code-signing-policy.md`). Never commit media files, secrets or personal
  paths.
- About screen lists the licence of every tool and model.

## Verification

- Unit tests for every piece of pure logic (link parsing, scoring, captions,
  FFmpeg argument building, manifest verification, job state machine).
- Render tests generate tiny inputs on the fly with FFmpeg (`testsrc2`, `sine`),
  render them and check the result with ffprobe (duration, streams, size). They
  skip cleanly when FFmpeg is not available.
- An end-to-end run on a short real public VOD (`npm run e2e -- <url>`), not in
  CI.
- Before finishing a task: `npm test`, `npm run typecheck`, `npm run build`.

## Owner preferences

Calm, dark, uncluttered UI (Linear-like). Little text, no jargon, no raw logs;
one plain sentence when something fails. Good defaults instead of settings.
Short, plain replies. Commit and push regularly with clear messages. Ask before
downloading very large files (multi-GB models) for local testing and before
anything that costs money.

## Roadmap

1. VOD to captioned clips (pipeline end to end).
2. Review screen.
3. Vertical export with facecam layout.
4. Per-clip audio options (stem separation optional).
5. Installer, first-run tool setup, auto-update.
6. CI and releases.
7. Final security review before handing it to the friend.
