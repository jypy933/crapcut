# CrapCut

Turn a stream VOD into short, captioned clips for TikTok, YouTube Shorts and
Instagram Reels, on your own PC.

Paste a link to a public Twitch VOD. CrapCut reads the chat replay and the
audio, finds the moments chat went wild, and cuts vertical (9:16) and
horizontal (16:9) clips with word-by-word captions. You review them, tweak the
cut and the captions, and export.

- **Free and local.** No account, no cloud AI, no subscription, no telemetry.
  Speech-to-text (whisper.cpp) and the small language model (llama.cpp) run on
  your graphics card.
- **Built for long streams.** Only the audio and chat are downloaded to find
  moments; video is downloaded just for the clips you keep. Every step resumes
  if the app or PC is closed.
- **Captions that follow the voice.** Each word lights up as it is spoken and
  disappears in pauses. Drag the captions or the chat box out of the way on any
  clip, and the export matches the preview exactly.
- **Your layouts.** Save as many camera layouts as you like: drag and resize the
  facecam and game boxes on a real frame, pick a default, and choose a layout
  per clip.
- **Always know where it is.** Every VOD shows its current step, progress and
  time left, and exports show progress on every screen and on the Windows
  taskbar.
- **Your audio.** Per clip: original audio, voice only, voice with quieter
  game, or voice with your own music (the voice is separated on your PC, only
  for the clips you export).

> Status: early test builds (0.6). Tested end to end on AMD; the first NVIDIA
> run is still to come.

## Requirements

- Windows 10 or 11, 64-bit
- 16 GB RAM recommended
- An NVIDIA (CUDA) or AMD (Vulkan) graphics card is recommended; the CPU works
  too, just slower
- About 10 GB of free disk space for the tools and models, plus room for your
  VODs' audio and clips

## Install

Download the latest `CrapCut-Setup-x.y.z.exe` from
[Releases](https://github.com/jypy933/crapcut/releases). Early versions are not
code-signed yet, so Windows SmartScreen asks once: click **More info -> Run
anyway**.

On first launch CrapCut downloads the tools it needs (FFmpeg, yt-dlp,
whisper.cpp, llama.cpp, TwitchDownloaderCLI) and the AI models from their
official sources. Every file is pinned to an exact version and checked against
a known SHA-256 checksum before use.

## Development

Requires Node 22+ and Git. FFmpeg on `PATH` is used by the render tests.

```bash
npm install
npm start          # run the app in development
npm test           # unit and render tests (render tests need ffmpeg on PATH)
npm run typecheck
npm run build      # production build
npm run test:ui    # drive the built app with Playwright (after build)
npm run dist       # Windows installer (release/)
npm run dev:ui     # UI only, in a browser, with a fake backend
```

End-to-end on a real short VOD (downloads the pinned tools into `.e2e/`):

```bash
E2E_VOD=https://www.twitch.tv/videos/<id> npm run e2e
```

See [docs/architecture.md](docs/architecture.md) for how it fits together.

## Privacy

CrapCut has no servers and collects nothing. It talks to the network only to
download the VOD you paste, the tools and models on first run, and to check
GitHub Releases for updates. See [docs/code-signing-policy.md](docs/code-signing-policy.md).

## Licence

MIT, see [LICENSE](LICENSE). CrapCut downloads third-party tools and models
that keep their own licences; the About screen and
[docs/third-party.md](docs/third-party.md) list them.

CrapCut is not affiliated with Twitch, TikTok, YouTube or Instagram.
