---
description: Verifies the expo-mcp plugin setup — runs prerequisite checks, confirms the configured Expo app directory is correct, optionally scaffolds maestro/, and tells the user whether they need to fix config or just restart.
argument-hint: "[--scaffold-maestro] [--skip-doctor]"
allowed-tools: Read(.claude/settings.json)
---

You are running the **expo-mcp installer**. Your job is to verify the setup in one pass and tell the user whether they can restart immediately or whether they need to adjust a single config value first.

## Assumptions

By the time the user runs this command, they have already installed the plugin via `/plugin install expo-mcp`. During that install Claude Code prompted them for the `Expo App Directory` (`userConfig.app_dir`) — it may be correct, wrong, or left blank.

- Plugin root: `${CLAUDE_PLUGIN_ROOT}`
- User flags: `$ARGUMENTS` (may contain `--scaffold-maestro`, `--skip-doctor`, or neither)

This command runs three bundled Node scripts from `${CLAUDE_PLUGIN_ROOT}/scripts/`. Claude Code will prompt the user to approve each one the first time it runs — that is expected. Approving them grants no broader Bash access; only these specific scripts are allowed per prompt.

## Steps

Do these in order. Report progress with one short line per step.

### 1. Environment doctor

Unless `$ARGUMENTS` contains `--skip-doctor`, run:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs
```

Show the output verbatim. If the summary line starts with `[fail]`, **stop** — tell the user to fix the failures and re-run `/expo-mcp:install`. If it is `[warn]` or `[  ok]` (the two spaces are intentional column-alignment), continue.

### 2. Detect the recommended app directory

Run:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/detect-app-dir.mjs
```

Interpret the output into a variable `DETECTED`:

- **Empty**: no Expo app found. Tell the user this directory does not look like an Expo project; ask whether to continue anyway. Do not proceed until they reply. If they confirm, set `DETECTED=NONE` (a sentinel — not the same as `""`) and continue.
- **One line, value `.`**: `DETECTED=""` (app_dir should be empty because the Expo app is at the project root).
- **One line, non-`.`**: `DETECTED=<that value>`.
- **Multiple lines**: list them numbered and ask the user to choose one; set `DETECTED` accordingly.

### 3. Read the currently configured app_dir

Always run this step, regardless of step 2's outcome. Use `Read` on `.claude/settings.json`. Handle the outcome as follows:

- **Read returns "file not found" (or similar absence error)**: set `CONFIGURED=unset` and continue. Do not stop.
- **File read succeeds**: parse it as JSON and look up the app_dir value, trying these locations in order:
  1. `pluginConfigs["expo-mcp@expo-mcp"].options.app_dir` — primary, most common
  2. Any key under `pluginConfigs` whose name starts with `expo-mcp@` — then read `.options.app_dir`
  3. If neither exists, set `CONFIGURED=unset`

Treat an explicitly empty string (`""`) as a deliberate blank, **not** unset — it means "the Expo app is at the project root".

Do **not** edit the file. Claude Code owns plugin config; we only read it.

### 4. Compare and decide the verdict

Branching order matters — check in this exact sequence:

- **`DETECTED` == `NONE`** (no Expo app found, user chose to continue) → verdict = `NO_PROJECT_RESTART`. Include `CONFIGURED` in the output so the user sees what is currently stored.
- **`CONFIGURED` is unset** → verdict = `SET_AND_RESTART` (the user dismissed the userConfig prompt during `/plugin install`).
- **`DETECTED` == `CONFIGURED`** (both equal, including both being `""`) → verdict = `OK_RESTART`.
- **Otherwise** (both defined, not equal) → verdict = `FIX_AND_RESTART`.

### 5. Optional: scaffold maestro/

Only if `$ARGUMENTS` contains `--scaffold-maestro` **and** `DETECTED` is not `NONE`:

- If `DETECTED` is `""` (project root), run:
  ```
  node ${CLAUDE_PLUGIN_ROOT}/scripts/scaffold-maestro.mjs
  ```
- Otherwise, pass `DETECTED` as a positional argument:
  ```
  node ${CLAUDE_PLUGIN_ROOT}/scripts/scaffold-maestro.mjs <DETECTED>
  ```

If `DETECTED` is `NONE`, skip scaffolding — there is no app directory to scaffold into.

### 6. Print the final block

Produce ONE output block. Substitute `(project root)` when a path is empty.

Show the doctor summary line, the detected vs configured values, and a verdict-specific next-step.

**Template for `OK_RESTART`:**

```
expo-mcp installation verified
──────────────────────────────
Environment:        <summary from doctor>
Detected app_dir:   <DETECTED or "(project root)">
Configured app_dir: <CONFIGURED or "(project root)">
Maestro folder:     <scaffolded / skipped>

Configuration is correct — nothing to fix.

Next step:
  Restart Claude Code so the MCP server picks up the config.

Verify after restart:
  get_session_status()
  start_session({ target: "ios-simulator" })

Reference:  /expo-guide
Agents:     qa, flow-writer
```

**Template for `FIX_AND_RESTART`:**

```
expo-mcp installation — action required
───────────────────────────────────────
Environment:        <summary from doctor>
Detected app_dir:   <DETECTED or "(project root)">
Configured app_dir: <CONFIGURED or "(project root)">
Status:             configured value does not match detected project
Maestro folder:     <scaffolded / skipped>

Fix this before restarting:

  1. Run /plugin and select expo-mcp
  2. Change "Expo App Directory" to: <DETECTED or "(leave empty)">
  3. Restart Claude Code

After restart, verify with:
  start_session({ target: "ios-simulator" })
```

**Template for `SET_AND_RESTART`:**

```
expo-mcp installation — action required
───────────────────────────────────────
Environment:        <summary from doctor>
Detected app_dir:   <DETECTED or "(project root)">
Configured app_dir: (not set)
Maestro folder:     <scaffolded / skipped>

The plugin is installed but "Expo App Directory" was not configured.

  1. Run /plugin and select expo-mcp
  2. Set "Expo App Directory" to: <DETECTED or "(leave empty)">
  3. Restart Claude Code

After restart, verify with:
  start_session({ target: "ios-simulator" })
```

**Template for `NO_PROJECT_RESTART`:**

```
expo-mcp installation — unverified
──────────────────────────────────
Environment:        <summary from doctor>
Detected app_dir:   (no Expo app detected)
Configured app_dir: <CONFIGURED or "(not set)">
Maestro folder:     <scaffolded / skipped>

Auto-detection did not find an Expo app in this directory, so the app_dir
value could not be verified. The plugin will still load after restart, but
device tools will fail until this directory contains an Expo project (or
until you point the plugin at one via /plugin).

Next step:
  Restart Claude Code (or open an Expo project first and re-run /expo-mcp:install).
```

If there were any doctor warnings, surface them above the block.

## Rules

- Never invent tool output — always run the scripts and report what they printed.
- Never edit `.mcp.json`, `.claude/settings.json`, or `plugin.json`. The plugin system owns those.
- Be terse. The user wants a verdict, not a walkthrough.
- If something unexpected happens (malformed settings.json, ambiguous detection), stop and ask.
