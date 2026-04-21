# CLAUDE.md

## Distribution

- **The npm package `expo-mcp` is NOT ours** — it is owned by someone else. Do not run `npm publish`, do not recommend `npx expo-mcp` / `pnpx expo-mcp`, and do not suggest `.mcp.json` entries like `"args": ["-y", "expo-mcp"]`. Those all execute a third party's code, not this repo.
- The only distribution channel is **GitHub `DaveDev42/expo-mcp`**. Users install via `/plugin marketplace add DaveDev42/expo-mcp` or a direct GitHub reference such as `npx -y github:DaveDev42/expo-mcp`.
- Because there is no npm release, the `main` branch is effectively the release channel: pushing to `main` ships to users. There are no git tags or GitHub Releases today.
- The `version` field in `package.json`, `plugin.json`, `marketplace.json`, and the literal in `src/index.ts` is display-only — it does not gate distribution. Keep them in sync anyway so logs and the plugin UI are coherent.

## Build Rules

- `dist/` is committed to the repository so that `npx github:user/repo` works without a build step.
- When modifying any file under `src/`, **always** run `npm run build` and include the updated `dist/` in the same commit.
- A pre-commit hook (`.githooks/pre-commit`) enforces this: commits that stage `src/` without `dist/` will be rejected.
- CI (`.github/workflows/ci.yml`) verifies that `dist/` matches a fresh build on every PR.

## Development

```bash
npm run build      # one-off build
npm run dev        # watch mode
npm run typecheck  # type-check without emitting
```

## Git Hooks Setup

```bash
git config core.hooksPath .githooks
```

## Release

Releases are cut from `main`. One-click release:

```bash
scripts/release.sh 0.4.0          # actual release
scripts/release.sh --dry-run 0.4.0  # print steps without mutating anything
```

The script runs preflight checks (on `main`, clean tree, up-to-date with origin, tag doesn't exist, version is new), bumps the four version-bearing files via `scripts/sync-version.sh`, rebuilds `dist/`, typechecks, commits as `chore: release v<X.Y.Z>`, tags as `v<X.Y.Z>`, and pushes both `main` and the tag.

Pushing the tag triggers `.github/workflows/release.yml`, which re-verifies the version/tag/dist consistency and creates a GitHub Release with auto-generated notes.

Manual bump without releasing:

```bash
scripts/sync-version.sh 0.4.0     # edit the four files only
scripts/sync-version.sh --check   # verify all four agree
```

CI also runs `sync-version.sh --check` on every PR — a version mismatch across those files fails the build.
