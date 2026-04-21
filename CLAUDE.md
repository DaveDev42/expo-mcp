# CLAUDE.md

## Distribution

- **The npm package `expo-mcp` is NOT ours** — it is owned by someone else. Do not run `pnpm publish` / `npm publish`, do not recommend `npx expo-mcp` / `pnpx expo-mcp`, and do not suggest `.mcp.json` entries like `"args": ["-y", "expo-mcp"]`. Those all execute a third party's code, not this repo.
- The only distribution channel is **GitHub `DaveDev42/expo-mcp`**. Users install via `/plugin marketplace add DaveDev42/expo-mcp` or a direct GitHub reference such as `npx -y github:DaveDev42/expo-mcp`.
- Releases are cut from `main`; a `v<X.Y.Z>` tag on a commit triggers `.github/workflows/release.yml` which creates a GitHub Release. Users following `main` receive changes continuously regardless of tags.
- The `version` field in `package.json`, `plugin.json`, `marketplace.json`, and the literal in `src/index.ts` is display-only — it does not gate distribution. Keep them in sync anyway so logs and the plugin UI are coherent.

## Package Manager

This repo uses **pnpm**. The version is pinned via `packageManager` in `package.json`, and Corepack will auto-select the correct version on `pnpm ...` invocations. Do not use `npm install` / `yarn install` — the only lockfile is `pnpm-lock.yaml`.

First-time setup on a fresh clone:

```bash
corepack enable           # one-time, activates the pinned pnpm version
pnpm install              # installs node_modules
```

## Build Rules

- `dist/` is committed to the repository so that `npx github:user/repo` works without a build step.
- When modifying any file under `src/`, **always** run `pnpm build` and include the updated `dist/` in the same commit.
- A pre-commit hook (`.githooks/pre-commit`) enforces this: commits that stage `src/` without `dist/` will be rejected.
- CI (`.github/workflows/ci.yml`) verifies that `dist/` matches a fresh build on every PR.

## Development

```bash
pnpm build      # one-off build
pnpm dev        # watch mode
pnpm typecheck  # type-check without emitting
```

## Git Hooks Setup

```bash
git config core.hooksPath .githooks
```

## Release

Releases are cut from `main`. One-click release:

```bash
pnpm release patch              # bump patch (e.g. 0.3.0 → 0.3.1)
pnpm release minor              # bump minor (e.g. 0.3.0 → 0.4.0)
pnpm release major              # bump major (e.g. 0.3.0 → 1.0.0)
pnpm release 0.4.0              # set exact version
pnpm release --dry-run 0.4.0    # print steps without mutating anything
```

The script (`scripts/release.mjs`) runs preflight checks (on `main`, clean tree, up-to-date with origin, tag doesn't exist, version is new), bumps the four version-bearing files (`package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, version literal in `src/index.ts`), rebuilds `dist/`, typechecks, self-verifies with `check:versions`, commits as `chore: release v<X.Y.Z>`, tags as `v<X.Y.Z>`, and pushes both `main` and the tag.

Pushing the tag triggers `.github/workflows/release.yml`, which re-verifies the version/tag/dist consistency and creates a GitHub Release with auto-generated notes.

Read-only version check:

```bash
pnpm check:versions             # verify all four files agree
```

CI also runs `pnpm check:versions` on every PR — a version mismatch across those files fails the build.

All project scripts (`scripts/*.mjs`) are Node ES modules; there are no bash scripts under `scripts/` (git hooks under `.githooks/` remain POSIX sh).
