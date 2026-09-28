# Code signing policy

CrapCut releases are built from this public repository by GitHub Actions
([`release.yml`](../.github/workflows/release.yml)) when a version tag is
pushed. Early versions (0.x) are **not code-signed**; Windows SmartScreen asks
once ("More info → Run anyway").

After the first stable release, the project will apply to the
[SignPath Foundation](https://signpath.org) for free code signing of open-source
software. When accepted, this page will state:

> Free code signing provided by [SignPath.io](https://signpath.io), certificate
> by [SignPath Foundation](https://signpath.org).

## What gets signed

Only files built from this repository by CI: `CrapCut.exe`, the installer and
uninstaller. CrapCut does not bundle third-party binaries; tools and models are
downloaded at runtime from their official sources and verified by SHA-256 (see
[third-party.md](third-party.md)).

## Team and roles

| Role | Who |
| --- | --- |
| Author, committer and reviewer | [@jypy933](https://github.com/jypy933) |
| Approver (approves each signing request) | [@jypy933](https://github.com/jypy933) |

All team members use multi-factor authentication on GitHub and SignPath.

## Build and release rules

- Releases are only built by CI from a tag on `main`; nobody signs local builds.
- The tag must match the version in `package.json`, and CI runs typecheck,
  unit, render and UI tests before building the installer.
- File metadata (product name "CrapCut", version, copyright) is set by
  electron-builder.

## Privacy statement

CrapCut does not collect, send or store any personal data on any server. It has
no accounts, telemetry or analytics. The app connects to the internet only to:

1. download the VOD audio, chat replay and clip video you ask for (Twitch),
2. download its pinned tools and AI models on first run (GitHub, Hugging Face),
3. check GitHub Releases for app updates.

All processing (speech-to-text, language model, video rendering) happens on
your computer. A log file stays on your computer; you choose whether to send
it to anyone.
