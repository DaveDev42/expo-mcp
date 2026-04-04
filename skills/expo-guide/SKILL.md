---
name: expo-guide
description: "How to use expo-mcp for Expo/React Native app automation. Covers session lifecycle, UI testing, Maestro flows, debugging, and QA patterns."
user-invocable: true
argument-hint: "[topic]"
---

# expo-mcp Usage Guide

## Session Lifecycle

Every interaction starts with a session:

```
1. get_session_status        — Check current state
2. start_session             — Launch Expo + bind device + acquire lease
3. (use tools)               — Interact with the app
4. stop_session              — Clean up when done
```

### Starting a Session

```
start_session({ target: "ios-simulator" })
start_session({ target: "android-emulator" })
start_session({ target: "web-browser" })
```

Options:
- `device_id` — Pin a specific simulator/emulator (auto-detected if omitted)
- `simulator_name` — iOS simulator name (e.g., "iPhone 16 Pro")
- `clean_state` — Reset keychain/app data before launch
- `auto_login` — Run a Maestro flow after app loads: `{ flow_file: "maestro/login.yaml" }`
- `port` — Server port (default: 8081, auto-increments if busy)

### Device Lease

The session has a 2-minute device lease that auto-renews on every tool call. If idle for 2 minutes, the lease expires. Call `start_session` again to re-acquire (server stays running).

Check with `get_session_status` — it shows remaining lease time.

## Tool Priority

Use lightweight tools first, expensive tools only when needed:

1. **`inspect_view_hierarchy`** — Returns UI element tree as text. Lightweight, use freely at every step.
2. **`tap_on`**, **`input_text`**, **`press_key`** — Interact with elements.
3. **`scroll`**, **`swipe`**, **`back`** — Navigate the app.
4. **`take_screenshot`** — Captures screen as image. Expensive (image processing). Use only for:
   - Bug evidence
   - Visual verification that `inspect_view_hierarchy` cannot capture
5. **`get_logs`** — Metro bundler + console logs. Use after startup and on errors.

## Interacting with Elements

### Tapping

```
tap_on({ text: "Login" })              — By visible text (fuzzy match)
tap_on({ id: "login-button" })         — By testID (exact match)
tap_on({ text: "Item", index: 2 })     — Third match when multiple exist
```

Always `inspect_view_hierarchy` before tapping to confirm elements exist and are enabled.

### Text Input

```
input_text({ text: "hello@example.com" })
```

Types into the currently focused field. Tap an input first, then type.

### Keys

```
press_key({ key: "Enter" })
press_key({ key: "Backspace" })
press_key({ key: "Home" })
press_key({ key: "Tab" })
```

### Scrolling

```
scroll({ direction: "down" })          — Scroll down (default)
scroll({ direction: "up" })
swipe({ direction: "left" })           — Swipe left (e.g., carousel)
swipe({ start: "50%,80%", end: "50%,20%" })  — Precise coordinates
```

## Debugging

### Check Logs

```
get_logs()                              — All recent logs
get_logs({ level: "error" })            — Errors only
get_logs({ level: "warn", limit: 20 })  — Last 20 warnings
get_logs({ clear: true })               — Clear buffer and return logs
```

**Always check logs after `start_session`** to catch startup errors proactively.

### Offline Mode Logs (Not Errors)

After startup you may see:

```
[LOG] Networking has been disabled
[ERROR] Skipping dependency validation in offline mode
[ERROR] Skipping Expo Go version validation in offline mode
```

**This is normal.** Expo CLI starts in `--offline` mode by default (skips Expo server auth). The simulator's network is NOT disabled — localhost API calls work fine. Do not report these as errors.

### Code Changes

After modifying source code:

```
1. reload_app()              — Hot reload (fast)
2. get_logs()                — Check for bundle errors
3. inspect_view_hierarchy()  — Verify UI updated
```

If `reload_app` fails, do `stop_session` then `start_session` again.

## Maestro Flows

### Inline Flow

Run ad-hoc Maestro YAML directly:

```
run_maestro_flow({
  flow_yaml: "appId: any\n---\n- assertVisible: Welcome\n- tapOn: Login"
})
```

### Flow Files

Run committed flow files from the project:

```
run_maestro_flow_files({ flow_files: "maestro/login.yaml" })
run_maestro_flow_files({ flow_files: "maestro/login.yaml,maestro/checkout.yaml" })
```

Flow files are more reliable than step-by-step tool calls for complex sequences (e.g., login with keyboard handling).

### Validate Syntax

Check YAML before running (works without a session):

```
check_maestro_flow_syntax({ flow_yaml: "- tapOn: Login\n- assertVisible: Home" })
```

## Common Gotchas

### Disabled Buttons

Never tap a disabled button. Before tapping, check `inspect_view_hierarchy` for the element's enabled state. If disabled, check for missing required inputs.

### Number-Pad Keyboard

`input_text` may fail on `keyboardType="number-pad"` fields. The software keyboard intercepts input. Workaround: close the keyboard first by tapping elsewhere, then use `run_maestro_flow` with `inputText`:

```
run_maestro_flow({
  flow_yaml: "appId: any\n---\n- tapOn:\n    point: \"50%,10%\"\n- tapOn:\n    id: \"birthdate-input\"\n- inputText: \"19900101\""
})
```

### Element Not Found

If `tap_on` fails, the element may be off-screen. Scroll down and re-inspect:

```
scroll({ direction: "down" })
inspect_view_hierarchy()
```

### Session Timeout

If tools fail with "Device lease expired", call `start_session` again. The server stays running — only the device lease needs renewal.

## QA Testing Pattern

A systematic approach for testing app features:

```
1. get_session_status → start_session({ target: "ios-simulator" })
2. get_logs() — check for startup errors
3. inspect_view_hierarchy() — understand current screen
4. tap_on / input_text / scroll — interact with elements
5. inspect_view_hierarchy() — verify state changed
6. (repeat 3-5 for each test scenario)
7. On error: get_logs({ level: "error" }) + take_screenshot()
8. stop_session()
```

### Reporting Format

```
Verdict: PASS | FAIL | INCONCLUSIVE
App Launch: [start_session result]
UI Verification: [inspect_view_hierarchy findings]
Interactions: [list of tool calls performed]
Results:
  - Scenario 1: [outcome]
  - Scenario 2: [outcome]
Untested: [items not tested and why]
```

### Self-Verification Checklist

Before reporting PASS:
1. Did I call `start_session`? (app must actually run)
2. Did I call `inspect_view_hierarchy`? (UI must be verified)
3. Did I call `tap_on` / `input_text` / `run_maestro_flow`? (interactions must happen)

If any answer is NO → verdict is INCONCLUSIVE, not PASS.

## Tools Reference

### Session Management
| Tool | Description |
|------|-------------|
| `get_session_status` | Check session state, device info, lease remaining |
| `start_session` | Launch Expo + bind device + acquire lease |
| `stop_session` | Stop server and release resources |
| `reload_app` | Hot reload after code changes |
| `list_devices` | List available simulators/emulators (no session needed) |

### UI Interaction
| Tool | Description |
|------|-------------|
| `inspect_view_hierarchy` | Get UI element tree (lightweight, use freely) |
| `tap_on` | Tap element by text, id, or coordinates |
| `input_text` | Type into focused field |
| `press_key` | Press system key (Enter, Backspace, Home, Tab, etc.) |
| `scroll` | Scroll in a direction |
| `swipe` | Swipe by direction or precise coordinates |
| `back` | Press back button |
| `take_screenshot` | Capture screen (expensive, use sparingly) |

### Debugging
| Tool | Description |
|------|-------------|
| `get_logs` | Metro bundler + console logs (filterable) |

### Maestro Flows
| Tool | Description |
|------|-------------|
| `run_maestro_flow` | Execute inline YAML flow |
| `run_maestro_flow_files` | Execute flow files from disk |
| `check_maestro_flow_syntax` | Validate YAML syntax (no session needed) |
