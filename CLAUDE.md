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
npm run release patch              # bump patch (e.g. 0.3.0 → 0.3.1)
npm run release minor              # bump minor (e.g. 0.3.0 → 0.4.0)
npm run release major              # bump major (e.g. 0.3.0 → 1.0.0)
npm run release 0.4.0              # set exact version
npm run release -- --dry-run 0.4.0 # print steps without mutating anything
```

The script (`scripts/release.mjs`) runs preflight checks (on `main`, clean tree, up-to-date with origin, tag doesn't exist, version is new), bumps the four version-bearing files (`package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, version literal in `src/index.ts`), rebuilds `dist/`, typechecks, self-verifies with `check:versions`, commits as `chore: release v<X.Y.Z>`, tags as `v<X.Y.Z>`, and pushes both `main` and the tag.

Pushing the tag triggers `.github/workflows/release.yml`, which re-verifies the version/tag/dist consistency and creates a GitHub Release with auto-generated notes.

Read-only version check:

```bash
npm run check:versions             # verify all four files agree
```

CI also runs `npm run check:versions` on every PR — a version mismatch across those files fails the build.

All project scripts (`scripts/*.mjs`) are Node ES modules; there are no bash scripts under `scripts/` (git hooks under `.githooks/` remain POSIX sh).
