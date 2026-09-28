# Releasing

1. Make sure `main` is green on CI.
2. Bump the version: `npm version patch` (or `minor`), which updates
   `package.json` and creates a `vX.Y.Z` tag.
3. Push: `git push --follow-tags`.
4. The **Release** workflow tests, builds `CrapCut-Setup-X.Y.Z.exe` and
   publishes it with `latest.yml` to GitHub Releases. Installed apps pick up the
   update within a few hours (or on the next start) and offer "Restart to
   update".

Local installer build (not for distribution): `npm run dist` → `release/`.

## Before handing a build to someone

- Run `npm run e2e` with a short public VOD (`E2E_VOD=https://www.twitch.tv/videos/<id>`).
- Run `npm run test:ui` with the same `E2E_VOD` for the click-through test.
- Install the built setup on a clean Windows user account and do one VOD.
