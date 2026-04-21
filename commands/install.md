---
description: One-shot installer for expo-mcp — runs prereq checks, detects the Expo app directory, writes userConfig directly into .claude/settings.json, and tells the user to restart. No /plugin UI round-trip required.
argument-hint: "[app-dir] [--global] [--scaffold-maestro] [--skip-doctor]"
allowed-tools: Read Edit Write Bash Glob
disable-model-invocation: true
---

You are running the **expo-mcp installer**. One-shot: after this command finishes and the user restarts Claude Code, every tool, agent, and skill is ready to use. Do **not** send the user to the `/plugin` UI.

## Arguments

Parse `$ARGUMENTS` as a whitespace-separated list:
- **First positional** — Expo app directory relative to the current working directory. If absent, auto-detect (step 2).
- **`--global`** — write plugin userConfig to `~/.claude/settings.json` instead of the project-local `.claude/settings.json`. Default: project-local.
- **`--scaffold-maestro`** — also scaffold a starter `maestro/` directory. Default: skip.
- **`--skip-doctor`** — skip environment prereq checks. Default: run them.

Do not ask the user to pick these — if they didn't pass them, use the defaults. The goal is one-shot install: user runs the command once, restarts Claude Code, done.

## Context

- Plugin root: `${CLAUDE_PLUGIN_ROOT}`
- All installer scripts default to the current working directory when run without arguments.

This command runs bundled Node scripts from `${CLAUDE_PLUGIN_ROOT}/scripts/`. Claude Code will prompt for approval the first time each script runs — that is expected.

## Steps

Proceed without asking for confirmation. Print what you're doing as you go (one short line per step), but do not block on user approval. The only exception: if detection is ambiguous (multiple candidate Expo app dirs), ask once to disambiguate, then continue through to the end.

### 1. Environment doctor

Unless `$ARGUMENTS` contains `--skip-doctor`, run:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs
```

Show the output verbatim. If the summary line starts with `[fail]`, **stop** — tell the user to fix the failures and re-run `/expo-mcp:install`. Warnings are fine; continue.

### 2. Resolve the Expo app directory

Set `APP_DIR` as follows:

- **If a first positional argument was provided**, use it as `APP_DIR` verbatim. Use `.` to mean "project root"; store it as `""` internally for the userConfig value.
- **Otherwise**, run auto-detection:
  ```
  node ${CLAUDE_PLUGIN_ROOT}/scripts/detect-app-dir.mjs
  ```
  Interpret the output:
  - **Empty**: no Expo app found. Tell the user this directory does not look like an Expo project and ask whether to continue anyway. If they decline, stop. If they confirm, set `APP_DIR=""` (project root as fallback) and continue.
  - **One line, value `.`**: `APP_DIR=""` (Expo app is at the project root).
  - **One line, non-`.` value**: `APP_DIR=<that value>`.
  - **Multiple lines**: list the candidates numbered and ask the user to pick one; set `APP_DIR` accordingly. This is the only time you ask.

### 3. Write the userConfig

Decide the target file based on the `--global` flag:

- `--global` present → `~/.claude/settings.json`
- otherwise → `<cwd>/.claude/settings.json` (project-local)

Merge the following under the chosen file, **preserving every other key**:

```json
{
  "pluginConfigs": {
    "expo-mcp@expo-mcp": {
      "options": {
        "app_dir": "<APP_DIR>"
      }
    }
  }
}
```

- `<APP_DIR>` is the resolved value from step 2 (possibly `""` for project root).
- The plugin identifier is `expo-mcp@expo-mcp` (plugin name `@` marketplace name; both are `expo-mcp` per this repo's `.claude-plugin/marketplace.json`).
- **Read the file first, merge, write back.** Never clobber existing keys. Use `Read` → parse JSON → merge → `Write` with the serialized result.
- If the file doesn't exist, create it with just the `pluginConfigs` key (still preserve any unknown top-level keys that might already be there — but there won't be any if the file is new).
- If `pluginConfigs["expo-mcp@expo-mcp"].options.app_dir` is already set to the same value, skip the write and log "config already correct".
- If it's set to a **different** value, overwrite (the user just re-ran install with a new value — honor it) and log that you did.
- For the project-local path, ensure `.claude/` exists first (create the directory with a single `Bash(mkdir -p .claude)` if needed).

After writing, print the target file path and the value you stored so the user can audit.

### 4. Optional: scaffold maestro/

Only if `$ARGUMENTS` contains `--scaffold-maestro`:

- If `APP_DIR` is `""` (project root), run:
  ```
  node ${CLAUDE_PLUGIN_ROOT}/scripts/scaffold-maestro.mjs
  ```
- Otherwise, pass `APP_DIR` as a positional argument:
  ```
  node ${CLAUDE_PLUGIN_ROOT}/scripts/scaffold-maestro.mjs <APP_DIR>
  ```

The script is idempotent — it never overwrites existing `maestro/` files.

### 5. Final summary

Print one concise block:

```
expo-mcp installation complete
──────────────────────────────
Environment:     <summary from doctor, or "skipped">
app_dir:         <APP_DIR or "(project root)">
Config written:  <absolute path to the settings file>
Maestro folder:  <scaffolded / existing / skipped>

Next step:
  Restart Claude Code so the MCP server picks up the config.

After restart, verify with:
  /mcp                                   ← should show expo as connected
  get_session_status()
  start_session({ target: "ios-simulator" })

Reference:  /expo-guide
Agents:     qa, flow-writer
```

Surface any doctor warnings above the block so the user sees them first.

## Safety rules

- Read each settings file before editing. Never assume contents.
- Merge — never clobber keys the installer doesn't own.
- Make idempotent edits: if the target already matches, skip without error.
- Print what you're editing as you go — short one-liners. The user should see a trail, just without approval prompts.
- If detection is ambiguous (multiple Expo app candidates), ask **once** to disambiguate, then continue through to the end.
- Don't touch `node_modules`, `dist/`, or build output.
- Don't modify `.mcp.json`, `plugin.json`, or anything outside the resolved app_dir / the chosen settings file.
