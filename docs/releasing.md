# Releasing

1. Make sure `main` is green on CI.
2. Bump the version: `npm version patch` (or `minor`), which updates
   `package.json` and creates a `vX.Y.Z` tag.
3. Push: `git push --follow-tags`.
4. The **Release** workflow tests, builds `CrapCut-Setup-X.Y.Z.exe` and
   uploads it with `latest.yml` to a **draft** GitHub release.
5. Check the draft (download and install it once), then click **Publish**.
   Installed apps pick up the update within a few hours (or on the next start)
   and offer "Restart to update".

Tool releases (`tools-*` tags, e.g. the voice separator) are prereleases so the
app's updater never mistakes them for app versions.

Local installer build (not for distribution): `npm run dist` -> `release/`.

## Before handing a build to someone

- Run `npm run e2e` with a short public VOD (`E2E_VOD=https://www.twitch.tv/videos/<id>`).
- Run `npm run test:ui` with the same `E2E_VOD` for the click-through test.
- Install the built setup on a clean Windows user account and do one VOD.

## Dependency updates

Dependabot pull requests are merged automatically once CI passes on them
(`.github/workflows/dependabot-merge.yml`). Nothing ships until a release is
tagged, so check `main` before tagging.
