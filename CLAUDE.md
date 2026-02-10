# CLAUDE.md

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
