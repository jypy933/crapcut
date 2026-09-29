# Architecture

CrapCut is an Electron app. All work (downloads, AI, FFmpeg, files, database)
happens in the **main process**. The **renderer** is a sandboxed React UI that
can only call a small, validated IPC API.

```
renderer (sandboxed React UI)
   │  window.crapcut.invoke(channel, args)      <- preload exposes only this
   ▼
main process
   ├─ ipc.ts          checks sender, validates args with zod, returns results
   ├─ services.ts     wires the long-lived services
   ├─ store.ts        SQLite (node:sqlite): jobs, steps, clips, layouts, exports, best-of
   ├─ pipeline/
   │   ├─ runner.ts     one job at a time, step checkpoints, retries, pause/continue
   │   ├─ steps.ts      metadata -> chat -> audio -> transcribe -> moments -> clips
   │   ├─ clipRender.ts renders one clip to a file; shared by exporter.ts and bestOf.ts
   │   ├─ exporter.ts   export lane: renders kept clips one at a time
   │   ├─ bestOf.ts     joins the kept clips into one 16:9 "best of" video
   │   └─ gpuLock.ts    one AI model on the GPU at a time
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
| transcribe | whisper.cpp, 10-minute chunks cut at quiet seconds | `transcript/chunk-NNN.json` -> `transcript.json` |
| moments | `core/moments.ts` + llama-server | clips in SQLite, `moments.json` |
| clip captions | whisper.cpp (CPU, large model), FFmpeg | sharpened `words` on each clip in SQLite |
| clips | yt-dlp `--download-sections` + audio alignment | `clips/<clip>.mp4` |

### Finding moments

1. Chat reaction: for each second, how many *different* chatters reacted in a
   rolling ~20 s window, each counted once and weighted by their strongest
   message (laughter/hype/shock words and tokens like "clip", "W", "L", "?"),
   bots ignored. Counting distinct chatters rather than raw message counts
   means a small, slow chat can still show a real reaction as a handful of
   different regulars, not just a busier one.
2. Robust z-score against a rolling 10-minute median, so a busy stream and a
   quiet one are judged against their own normal; a big, fast chat needs a
   much wider burst of different chatters to register than a small one does.
3. Peaks at least 45 s apart, with at least 3 different chatters in the
   window as a sanity floor; the moment is placed a few seconds **before**
   the chat reaction (stream delay + typing time). Loud moments that chat
   missed are added from the audio loudness the same way as before, so a
   silent-but-funny reaction is still found; loudness has no ceiling, so its
   contribution to ranking is compressed and a confirmed chat reaction starts
   from a base score, keeping one very loud, unconfirmed moment from
   burying several real chat reactions.
4. Stream start/end and Twitch-muted parts are skipped.
5. `core/transcriptQuality.ts` flags stretches of the transcript that are not
   real speech: whisper looping on the same word or phrase ("Tired Tired
   Tired", a sentence repeated for a minute over music or game noise), known
   filler lines it hallucinates over silence (subtitle credits, "thank you"),
   rambling low-variety text and timings that cannot be spoken (words crammed
   into near nothing, one word stretched over many seconds). A candidate whose
   window is mostly one of these, or has essentially no real speech, is
   dropped before it reaches the language model -- unless chat or loudness
   alone are strong enough that something real clearly happened, in which case
   it is kept but marked so its title comes from the reaction, not the fake
   transcript. `@shared/transcriptLoops.ts` collapses a loop down to a single
   occurrence (short natural repeats like "no no no no" are left alone); the
   caption word path (`shared/captions.ts`'s `clipWords`) and the no-LLM
   fallback title both use the collapsed words, so a kept clip never shows or
   is titled from "of of of".
6. The local LLM gets each candidate's transcript excerpt and chat summary and
   returns JSON (keep, rating, start, end, title), constrained by a JSON schema
   and validated again. Without the LLM, cut points snap to pauses in speech
   and titles come from the transcript.
7. The number of clips is not a fixed target: chat- and transcript-backed
   candidates are kept as found, and loud-only candidates need to clearly
   stand out from this stream's *other* loud moments (not just clear the
   initial detection threshold), so a stream full of merely-loud, mediocre
   audio spikes does not fill up the review list. At least 3 clips are kept
   when any candidates exist, and at most one per 20 minutes of stream
   (capped at 20) to keep review manageable.

### Clip captions

On the CPU, whisper transcribes the whole VOD with the small model for speed
(the large model would take longer than the stream itself). Once moments has
picked the clips, the `clipCaptions` step cuts each kept clip's own padded
range back out of the already-downloaded VOD audio and re-transcribes just
that with the large model, which is easily affordable per clip; the result is
offset back onto VOD time, repaired and replaces that clip's `words`. On
NVIDIA the whole VOD already used the large model, so this step does nothing.
A clip is skipped if its captions were already hand-edited in Review (only
possible on a job resumed from before this step existed), and a clip that
fails re-transcription simply keeps its fast-pass words. Per-clip progress and
resume mirror the main `transcribe` step's per-chunk checkpoints.

### Captions and layout

`shared/captions.ts` groups words into short on-screen chunks; the review
preview and the export use the same code. `shared/captionStyles.ts` holds the
caption look presets (clean, bold pop, boxed, minimal); `core/ass.ts` writes
an ASS file with one event per word (the spoken word, and with some presets
shouted/number words, are highlighted). `shared/layoutGeometry.ts` computes
the facecam/game crops for both the canvas preview and FFmpeg.

### Chat overlay

A per-clip toggle (off by default) shows the clip's chat as a small
translucent box of the last few messages, scrolling up as new ones arrive.
`shared/chatOverlay.ts` is the pure layout: it windows the clip's chat
messages (saved on the clip like `words`, padded the same way), spreads
messages that land in the same second (the chat log only has 1-second
timestamps) so they do not pop in together, stacks them newest-at-the-bottom
with older ones scrolling off after a few more arrive, wraps/truncates long
messages, and places the box below the facecam (when there is one) and clear
of the captions, for both 9:16 and 16:9. `core/ass.ts` turns those lines into
a second ASS style/layer (`buildAss`'s optional `chat` argument) in the same
file the captions use, so `clipRender.ts` burns both in with one `ass=`
filter; the review preview (`components/Preview.tsx`) draws its own
approximation of the same layout for the toggle to feel immediate. Emotes are
left as plain text; libass's Windows font fallback already renders emoji, CJK
and RTL-marked names without the bundled caption font showing broken glyphs.

### Clip timing

Section downloads can start a little off the requested time. After each clip
download, its audio is matched against the full stream audio
(`core/align.ts`, normalised cross-correlation of 10 ms loudness envelopes), so
captions and cuts stay frame-accurate.

### Automatic viral edit

Every accepted clip gets one automatic re-edit -- the app picks the structure,
never the user -- with a per-clip "Auto edit" toggle to fall back to the plain
cut. `core/structureSignals.ts` measures the clip's shape (where the reaction
sits, a quotable line, chat vs. audio), `core/structurePick.ts` scores every
structure against those signals and picks one, and `core/viralEdit.ts` turns
the decision into an EDL (`core/edl.ts`): trimmed silences, a punch-in zoom,
sound effects, and sometimes a cold open, a quote card or a loop ending.
`core/edlFilter.ts` turns the EDL into an FFmpeg filter graph and
`core/edlCaptions.ts` remaps the clip's own words onto it.

The decision is computed once moments are found (`pipeline/steps.ts`), with
the language model narrowing a close call (`core/structureLlm.ts`) if one is
running -- the same `llama-server` session the moments step already started,
never a second one. Without the model, or for a clip saved before this
existed, `core/clipFacts.ts`'s heuristic-only pick fills it in lazily. A trim
in review recomputes it the same cheap way, carrying a previous quote span or
chat picks forward only while they still fit the new cut.

At export, `pipeline/clipRender.ts` builds the EDL and renders it with
`buildEdlRenderArgs` in place of the plain path's `buildRenderArgs`, keeping
the same layout, audio option and encoder fallback; `pipeline/sfxCache.ts`
renders the small set of sound effects once into `tools/sfx` and reuses them
after that. The chat overlay is not remapped through the EDL yet, so it is
simply left off an auto-edited clip rather than shown at the wrong moment.
"Best of" always uses the plain clips, never the automatic edit -- a per-clip
loop ending or punch-in is built for a clip watched on its own and would fight
the best-of's own crossfade join.

Review shows a second, small tab next to the editor: a cached low-res preview
of the clip's current auto edit, rendered in the background by
`pipeline/autoEditPreview.ts`, debounced after an edit and cancelled when a
newer request supersedes it. The result is cached under the job's own work
folder (`previews/`), keyed by a hash of the EDL, captions, layout and
source, and served to the tab through the same `crapcut-media://` protocol the
editor's video uses. It is rendered in one pass straight at preview size (the
layout, zoom and captions all run on the small frame), with the original audio
and no chat overlay.

Voice separation and the loudness measurement are cached per clip in the job's
`stems/` folder, keyed by the clip's cut and its source file's size and
modified time, so exporting a clip in both formats (or in a best-of) separates
it once.

### Best of the stream

From Review, "Best of" joins the job's kept clips, in stream order, into one
16:9 video for a single YouTube upload. Each kept clip is rendered fresh as
its own 16:9 export (same captions, audio option and encoder choice as a
normal export), then `core/bestOf.ts` builds one FFmpeg command that
normalises every clip to 1920x1080/30fps/48kHz and joins them with a 0.5 s
`xfade`/`acrossfade` crossfade; a single kept clip is just re-encoded with no
crossfade. A crossfade is shortened for a short clip so it never eats more
than 40% of either neighbour. `pipeline/bestOf.ts` runs this like a small
export queue (progress, ETA, cancel, resume after a restart) and reuses the
exporter's encoder choice.

## Hardware

`tools/gpu.ts` reads the display adapters from the registry (and `nvidia-smi`
on NVIDIA). whisper.cpp uses the CUDA build on NVIDIA (driver ≥ 452.39,
≥ 3.5 GB VRAM) and the CPU build otherwise; if the GPU run fails it falls back
to the CPU automatically. llama.cpp uses its Vulkan build (works on NVIDIA and
AMD, CPU fallback included). Video encoding tries NVENC / AMF / QSV with a
one-second test encode and falls back to libx264.

## Setup and optional AI parts

`tools/setup.ts` (`SetupManager`) drives first run: it works out which pinned
tools and models this PC needs (`tools/manifest.ts`), checks disk space, and
downloads them one at a time with resume and SHA-256 verification
(`tools/download.ts`, `tools/registry.ts`). It is "ready" once every required
part is installed; the language model and voice separation are optional and
never block that.

Because they are optional, a first run can finish (and leave the setup screen)
before they are downloaded, or before the user chooses to. The About screen's
"Optional AI parts" section lets the user download or remove either one at any
time: `SetupManager.start(only)` and `.remove(only)` take a subset of artifact
ids instead of everything the PC needs, so a single part can be fetched (or
freed) without touching the rest. `shared/optionalModels.ts` (pure, shared with
the renderer) groups the underlying tool/model artifacts into the two plain-
language parts shown there and picks the 9B (Qwen3.5) or 3B (Ministral)
language model per `shared/hardware.ts`'s VRAM rule. The moments step only
uses a model once `ToolRegistry.isInstalled` confirms its marker file and
hash match, so a partial or cancelled download is never picked up half-done.

When a pinned model for a tier changes (e.g. the Ministral 3 8B -> Qwen3.5 9B
swap), the old one is kept in the manifest as `deprecated`, needed by no
hardware, so it is never fetched fresh but an existing install is still
recognised. A PC that already has it gets the new one downloaded and verified
automatically, no click needed (`services.ts`, `tools/llmMigration.ts`); the
old model keeps the moments step running until that finishes, and
`SetupManager` only removes it once the new one is confirmed installed, the
same `remove()` guarded by whether a job or export still has it open.

## Tray and autostart

CrapCut keeps a single `Tray` icon for its whole run (`main/tray.ts`), with an
Open/Quit menu; clicking the icon opens the window. Closing the window hides
it to the tray instead of quitting while a job or export is running, or a
channel is watched (`main/core/trayPolicy.ts`, pure and unit-tested); only the
tray's Quit item sets a flag that lets a real quit through. "Start CrapCut
with Windows" (`main/autostart.ts`, `app.setLoginItemSettings`) defaults to on
only while a channel is watched, unless the user has explicitly chosen
(`main/core/autostart.ts`, also pure); the setting is exposed to the UI as a
single toggle on the About screen. When started at login the app is launched
with `--hidden` and comes up in the tray without showing its window.

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
- Updates: electron-updater checks the SHA-512 in `latest.yml`. Until the app
  is code-signed (SignPath, planned), whoever controls the GitHub repository
  controls updates, so the account uses 2FA, CI builds only go to **draft**
  releases, and a human publishes each one.

## Tests

- `npm test`: unit tests for all pure logic + render tests that generate media
  with FFmpeg (`testsrc2`, `sine`) and check the output with ffprobe.
- `npm run test:ui`: drives the built Electron app with Playwright (smoke test
  on CI; full click-through when `E2E_VOD` is set).
- `npm run e2e`: the whole pipeline on a real short VOD (`E2E_VOD=...`).
