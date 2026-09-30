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
   │   ├─ clipRender.ts renders one clip, or prepares it for the best-of; shared by exporter.ts and bestOf.ts
   │   ├─ exporter.ts   export lane: renders kept clips one at a time
   │   ├─ exportChecks.ts measures each finished export and runs core/exportChecks.ts on it
   │   ├─ bestOf.ts     joins the kept clips into one 16:9 "best of" video, one encode
   │   └─ gpuLock.ts    one AI model on the GPU at a time
   ├─ tools/          pinned downloads, checksums, GPU detection, process runner
   └─ core/           pure logic, unit-tested without Electron
```

## Pipeline

A job is one VOD. Each step writes its result to the job folder
(`%LOCALAPPDATA%\CrapCut\jobs\<id>`) with atomic writes and records its state
in SQLite. On restart, interrupted jobs show **Continue**; each step checks what
is already on disk and carries on.

Steps run in order, with one exception: the chat download only needs the VOD
id and nothing reads the chat before `moments`, so the runner starts it beside
`audio` and `transcribe` and waits for it before `moments`. A failure on
either side stops the other. Clip videos download three at a time.

| Step | Tool | Output |
| --- | --- | --- |
| metadata | yt-dlp `-J`, audio playlist | `meta.json` (title, length, chapters, muted ranges) |
| chat | TwitchDownloaderCLI | `chat.txt` |
| audio | yt-dlp (audio only), FFmpeg | `audio.mp4`, `audio16k.wav` (temporary), `loudness.txt`, `muted.json` |
| transcribe | whisper.cpp (CUDA, Vulkan or CPU), 10-minute chunks cut at quiet seconds | `transcript/chunk-NNN.json` (with a `sharp` flag) -> `transcript.json` |
| moments | `core/moments.ts` + llama-server | clips in SQLite, `moments.json` |
| clip captions | whisper.cpp (large model), FFmpeg | sharpened `words` on each clip in SQLite |
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
   and titles come from the transcript. Everything that is the same for every
   request of a job (role, stream line, task, the two worked examples) is the
   system message and only the excerpt is the user message
   (`core/llmPrompt.ts`): the model is a hybrid one whose state cannot be
   rewound to an arbitrary token, but llama-server keeps a checkpoint at the
   start of the last user message, so the next request skips the shared part
   (about half of a refine prompt). The bigger model on a GPU serves three
   requests at once (`-np 3`, 4096 tokens of context per slot, about 1.5x
   faster than one at a time for +0.2 GB VRAM); the 3B tier and the CPU serve
   one. `core/pool.ts` feeds the slots: results keep input order, three
   failures stop new requests but keep the finished answers, a cancel rejects
   at once.
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
On AMD (Vulkan) the large model also runs on the GPU for the whole VOD, and
each chunk file records whether it did (`sharp`). If the GPU failed and some
chunks were done on the CPU with the small model, only the clips that touch
those chunks are re-transcribed (on the GPU if it is still working, otherwise
on the CPU). A chunk file with no `sharp` flag, from a job started before it
existed, counts as CPU.
A clip is skipped if its captions were already hand-edited in Review (only
possible on a job resumed from before this step existed), and a clip that
fails re-transcription simply keeps its fast-pass words. Per-clip progress and
resume mirror the main `transcribe` step's per-chunk checkpoints.

### Word timing

whisper.cpp's own per-word timestamps (`-ml 1 -sow`) get the first word after
a pause right and then rush the following words ahead of the voice (measured:
median 215 ms early, worst tenth over 600 ms). Both whisper passes therefore
also ask for DTW token times (`-ojf -dtw <preset> -nfa`; flash attention
silently disables DTW). With `--vad`, whisper hears only the speech stretches
back to back and does not map token or DTW times back to the file, so
`whisperChunk` reads the `vad_segment_info` log lines (hence no `-np`; the
extra log is about 150 KB per 10-minute chunk and costs no measurable time)
and `core/transcript.ts` maps each word's DTW time back itself, subtracts the
measured ~200 ms DTW lag, keeps the start inside its VAD stretch and ends the
word at the next word, a plausible length for its text, or the end of the
stretch less the ~100 ms of silence VAD waits for before closing it. Measured
against speech with exactly known word times (two Windows voices): start
median about 50 ms, 90% within 100 ms, none more than about 110 ms early; end
median about 30 ms, 90% within 90 ms; a word is on screen over a pause for
0.2 s in total, against 13.9 s with whisper's own timestamps
(`pipeline/wordTiming.render.test.ts` reports and checks this on Windows). DTW
costs about 15-30% more transcription time (flash attention has to be off).

Invented words (measured on 20 min of real VOD audio, generated silence, noise,
chords and impacts, and the Windows-voice speech, with the large model on Vulkan
and the small one on the CPU): VAD is what stops them. Without it whisper
answers every silent or noisy stretch with "Thank you." at the start of its 30 s
windows, writes "*Dramatic music*" or "ORGAN PLAYS" over game sound and sings
song lyrics (loops doubled, 76 to 148 words); with it, generated non-speech gives
0 words and real VODs show no such lines. No decoder or VAD knob beat the current
arguments: `-nth`, `-et`, `-tpi 0`/`-nf` changed nothing; `-lpt`, `-sns` and
`-mc 0` only reworded 40-50 real words (`-lpt -0.5` turned sung lyrics into
different nonsense); `-vt 0.6/0.7`, `-vspd 400/600` and `-vp 0/100` lost or
added 65-160 real words for at most 53 fewer suspect ones, and `-vsd 300` and
`-vp 0` move the spans that word timing rests on. Word probability does not
separate them either (the invented "Thank you." and "*Dramatic music*" have
p near 1.0), an all-caps rule hits real acronyms (PPC, RFC) and a
words-per-second rule hits real "No, no, no." (8-15 words/s), and a word's voice
energy mostly finds DTW's zero-length first word of a stretch. So only two
small filters ship: `core/soundMarkers.ts` drops a sound description that
`-ml 1` split over several words, and, when a chunk ran without the VAD model,
`dropIsolatedFiller` drops a "Thank you." with 4 s of nothing either side.
Repeat loops are still handled where they are judged and shown
(`shared/transcriptLoops.ts`). `pipeline/antiHallucination.render.test.ts` counts
invented words on generated audio and missed/extra words on speech.

A chunk cut in the middle of a word makes whisper carry on past the end of the
audio, stamping the invented words at one instant; `dropTailPileup` keeps only
the first, and `mergeChunks` keeps a word both sides of a seam heard once.

DTW never costs a transcript (`core/dtwGate.ts`): if a run with DTW fails and
one without it works, the chunk is redone without it; if any word lacks a DTW
time, or the VAD lines cannot be read, the chunk keeps whisper's own
timestamps. Each such chunk is logged (locally only), and after two the job
stops asking for DTW.

### Captions and layout

`shared/captions.ts` groups words into short on-screen chunks; the review
preview and the export use the same code. Each word stays highlighted at
least `MIN_HIGHLIGHT_SEC`, so words timed at the same instant are spread out
instead of flickering past. `shared/captionStyles.ts` holds the
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
sound effects, and sometimes a quote card or a loop ending (a cold open is a
separate, planned version, see the rule engine below).
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

#### Rule engine

The starting rules from `docs/auto-edit-research.md` (section 4.7) are enforced
by a pure rule engine, `core/editPlan.ts`, built on `core/viralEdit.ts` rather
than beside it. Every threshold is a named constant in `EDIT_RULES`
(`core/editRules.ts`); each check returns one result that is written as a
single compact `rule <name> clip=<id> pass|fail|na ...` line to the local log
and never shown in the UI. It runs twice: when moments are found
(`pipeline/autoEditPlan.ts`, coarse per-second loudness, the language model
confirming cold opens while it is still running) and whenever the edit is built
for a preview or an export (`resolveAutoEdit`, with a 0.1 s loudness envelope
and the loop seam frames measured from the downloaded clip with FFmpeg,
`pipeline/seamMeasure.ts`). The result is stored on the clip as `editPlan`.

- Length: the 10 s floor applies to the final edited length. When an edit would
  end under it the edit is skipped (the whole cut is kept), then the cut is
  grown from its download padding, and only then is the clip dropped. Caps
  (TikTok 60 s, Shorts 60 s, Reels 90 s) are stored as a per-platform fit for
  the later per-platform export; nothing is exported here.
- Content floor: a chat peak inside and speech or loud frames over at least 40%
  of the final edit (a strong loudness peak, the bar moment finding uses, stands in
  for the chat peak). A clip failing it is dropped unless that would leave fewer
  than three clips.
- Hook and pacing: leading silence over 0.3 s is cut to 0.15 s; pauses over
  0.5 s (0.7 s with loud game sound in them, measured on the fine envelope) are
  cut to about 0.30 s, never inside a word or the sound of its tail; the
  reaction beat after the payoff is kept and the edit ends about a second after
  the reaction.
- Cold open (`core/coldOpen.ts`): a plan only, stored for a second version.
  Chat, loudness and the transcript must agree; the model confirms when it is
  running, and without it the gate is stricter. `core/viralEdit.ts`
  `coldOpenVariantEdl` builds the version from the plan. The `payoffFirst`
  structure (payoff already in the first 15% or 3 s) is exactly the case a cold
  open skips, so it is a plain tight cut and never replays its payoff.
- Loop (`core/loopSeam.ts`): a property of a version. Eligible at 30 s or less
  when the edit can end on the last word plus 150-400 ms of quiet and the first
  and last frame look alike (frame threshold 0.55, not yet calibrated) with the
  last 400 ms within 3 dB of the first. The video is a hard cut, the audio
  fades over 60 ms at both ends; no end card. The structures that ask for a
  loop (`freezeLoop`, a late `quoteCard`) only get one when this passes.

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
16:9 video for a single YouTube upload, with one video encode: no clip is
compressed twice. Each kept clip is first prepared exactly like a normal 16:9
export, minus the encode (`prepareClipForBestOf` in `pipeline/clipRender.ts`:
captions and chat overlay, voice separation from the per-clip stem cache,
loudness), and its sound goes through the same audio chain as an export into a
lossless WAV. Then `core/bestOf.ts` builds one FFmpeg command whose filter
graph has a labelled branch per clip (its cut of the source, the same layout
and captions as an export, its WAV), each cut to a whole number of frames at
1920x1080/30fps/48kHz and joined with a 0.5 s `xfade`/`acrossfade` crossfade,
and encodes it once with the exporter's encoder. The per-clip pieces come from
`videoChain`/`audioChain` in `core/render.ts`, the same code a normal export
runs, so the two cannot drift apart. A single kept clip is just encoded with
no crossfade. A crossfade is shortened for a short clip so it never eats more
than 40% of either neighbour.

The graph is written to a file (`-/filter_complex`), so many clips never hit
the Windows command-line limit. Every clip keeps a decoder open during the
encode, at roughly 60-90 MB each, so one best-of holds up to 50 clips (about
4 GB at 50 clips of 1080p60). `pipeline/bestOf.ts` runs this like a small
export queue (progress and ETA over the prep and the encode, cancel, resume
after a restart from the prep cache, hardware-encoder fallback to libx264) and
shares the exporter's encode lock.

## Export checks

Captions are fitted before encoding: `fitCaptionStyle` (`core/captionSafeZone.ts`)
estimates the caption block from its text and style and, when it would leave
the platform safe zone (research table 2.5), moves it up or down and, if a line
is too wide, wraps it earlier (`AssStyle.marginX`). Until exports are made per
platform the vertical zone is `DEFAULT_PLATFORM` (TikTok); 16:9 keeps a 5%
title-safe margin. After the encode `pipeline/exportChecks.ts` measures the file
with the pinned ffprobe/FFmpeg (size, streams, `volumedetect`, `cropdetect` on
three spots) and `core/exportChecks.ts` judges it: 1080x1920 (1920x1080), no
black bars, audible sound, nothing added to the picture or the end, captions in
the zone. Every failure goes to the local log. A vertical cam or crop layout
with bars is re-rendered once with the blurred fill and kept if that clears
them; only a wrong size, or missing or silent sound that the source did not
have, fails the export with one plain sentence. All limits are constants at the
top of the two core files.

## Hardware

`tools/gpu.ts` reads the display adapters from the registry (and `nvidia-smi`
on NVIDIA). whisper.cpp uses the CUDA build on NVIDIA (driver >= 452.39,
>= 3.5 GB VRAM), a Vulkan build on AMD cards with >= 3.5 GB VRAM, and the CPU
build otherwise; if the GPU run fails it falls back to the CPU automatically.
whisper.cpp has no official Windows Vulkan build, so `whisper-vulkan` is built
by this repo's CI ([whisper-vulkan.yml](../.github/workflows/whisper-vulkan.yml))
from the pinned v1.9.4 source and published as a `tools-whisper-vulkan-*`
prerelease, like the voice separator. On an RX 9060 XT the large model runs
roughly 10 to 30 times faster than real time (the CPU small model manages
about 4). Faster GPU builds like this one are optional: a PC set up before an
update added one gets it fetched in the background (`tools/accelerators.ts`)
and keeps using the CPU until it is installed. llama.cpp uses its Vulkan build
(works on NVIDIA and AMD, CPU fallback included). On NVIDIA with a driver >=
551.61 (the CUDA 12.4 minimum, `LLAMA_CUDA_MIN_DRIVER`) `HardwareProfile.llmCuda` is set and the CUDA
build of the same llama.cpp release is tried first, because prompt reading, the
bulk of the language-model work, is about twice as fast there. It needs two
optional parts next to the Vulkan one (`llama-cuda` and `llama-cuda-runtime`,
both under "Smart picks and titles"); the runtime folder is put on PATH for the
llama-server child only. `core/llmBackend.ts` plans the attempts (CUDA, then
Vulkan or CPU) and `startFirstWorking` runs them: the CUDA server is started
with `--device CUDA0` (so it exits at once instead of quietly running on the
CPU when CUDA is unusable) and must answer one small request before the job
uses it; if either fails it is stopped and the Vulkan build takes over. The
backend that ran is logged ("llama-server backend: cuda|vulkan|cpu"). Video
encoding tries NVENC / AMF / QSV with a one-second test encode and falls back
to libx264.

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
