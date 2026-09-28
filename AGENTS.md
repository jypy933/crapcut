# Cutroom

A personal video editor in the spirit of CapCut, for the owner's own use on this
Windows PC. Not a product for sale.

## Hard rules

- **Local only, no paid services.** Nothing may call a cloud API, paid service,
  telemetry or account. All AI runs on this machine through local tools
  (whisper.cpp for speech-to-text, a local LLM server such as Ollama or llama.cpp
  on `localhost`). The only network use allowed is the owner pasting a video link
  to download with yt-dlp, if that feature is added.
- **The editor works without AI.** If whisper.cpp or the local LLM is missing,
  AI features are hidden or explain in one sentence how to add them; editing,
  preview and export still work.
- **Use existing tools, do not rebuild them.** FFmpeg does decoding, effects and
  encoding; whisper.cpp does transcription; the local LLM does language tasks.
  Our code is the editor UI, the project model and the glue.

## Machine

Windows 11, Intel i5-14400F, 32 GB RAM, AMD Radeon RX 9060 XT (8 GB VRAM, no
CUDA). FFmpeg 8.1.1 and ffprobe are on PATH with AMD encoders (`h264_amf`,
`hevc_amf`, `av1_amf`); use `h264_amf` for export and fall back to `libx264`
when it fails. Node and Git are installed. Local AI must fit in 8 GB VRAM
(whisper large-v3-turbo; a 7–8B LLM at Q4), run one at a time, and use
Vulkan/ROCm-capable builds, never CUDA-only ones.

## Design

- **Stack:** Electron + React + TypeScript + Vite, tests with Vitest.
  Scripts: `npm test`, `npm run typecheck`, `npm run build`, `npm start`.
- **One project model.** A project is a JSON edit plan: media list, a main
  video track of clips (source, in, out), overlay tracks (text, images), audio
  tracks (music, volume), output format (16:9 or 9:16, 1080p). The UI, captions
  and AI all change the plan through the same small set of typed operations
  (add, trim, split, move, delete, set property). Undo/redo works on those.
- **One renderer.** A pure function turns the plan into one FFmpeg command.
  Export runs it with progress; preview renders a low-resolution proxy of the
  affected range when a simple `<video>` playback of the sources is not enough.
- **Main and renderer processes stay separate.** FFmpeg, whisper and the LLM
  are called from the Electron main process only; the UI talks over IPC.

## Verification

- Unit tests for every plan operation and for plan → FFmpeg command building.
- Render tests generate tiny inputs on the fly with FFmpeg (`testsrc2`, `sine`),
  render them, and check the output with ffprobe (duration, streams, size).
  Never commit large media files.
- Before finishing a task: `npm test`, `npm run typecheck`, `npm run build`.

## Owner preferences

Calm, dark, uncluttered UI (Linear/BridgeMind style). Little text, no raw logs
or FFmpeg output shown to the owner; one plain sentence when something fails.
Avoid settings the owner must tune by hand; pick good defaults.

## Roadmap

1. **V1 Basic editor:** import video, audio and images; main track with trim,
   split, delete and reorder; text overlays; one music track with volume;
   preview; export MP4 in 16:9 or 9:16; save and open projects; undo/redo.
2. **V2 Captions:** local whisper.cpp transcription with word timings;
   editable captions; burned-in caption styles (word-by-word highlight).
3. **V3 AI edits:** local LLM turns a typed request ("cut the silences",
   "make a 30 s vertical clip of the best part") into plan operations, shown
   as a preview the owner accepts or rejects; highlight finding from the
   transcript for long videos.
4. **V4 Polish:** transitions, speed, crop/zoom, simple keyframes, templates.
