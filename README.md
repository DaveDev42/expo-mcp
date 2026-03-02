# expo-mcp

MCP server for Expo/React Native app automation with Maestro integration.

## Features

- **Session-Based Architecture**: `start_session` launches Expo, binds a device, and acquires a lease — no manual device ID management
- **Device Lease with TTL**: 2-minute lease auto-renewed on every device tool call; expires after inactivity so other instances can use the device
- **Cross-Instance Coordination**: Multiple MCP instances can run simultaneously without device conflicts
- **Expo Dev Server Management**: Start/stop/reload Expo development server
- **Maestro Integration**: Full UI automation tools (tap, input, screenshot, etc.)

## Installation

```bash
npx -y expo-mcp
```

With pnpm:

```bash
pnpx expo-mcp
```

## Usage with Claude Code

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "expo-mcp": {
      "command": "npx",
      "args": ["-y", "expo-mcp"]
    }
  }
}
```

### Monorepo Setup

Use a positional argument to specify the app directory:

```json
{
  "mcpServers": {
    "expo-mcp": {
      "command": "npx",
      "args": ["-y", "expo-mcp", "apps/mobile"]
    }
  }
}
```

### Specific Device

Pin a specific simulator or emulator with `--device-id`:

```json
{
  "mcpServers": {
    "expo-mcp": {
      "command": "npx",
      "args": ["-y", "expo-mcp", "--device-id=6D192F60-1234-5678-ABCD-000000000000"]
    }
  }
}
```

### Tool Filtering

Exclude specific tools with `--exclude-tools`:

```json
{
  "mcpServers": {
    "expo-mcp": {
      "command": "npx",
      "args": ["-y", "expo-mcp", "apps/mobile", "--exclude-tools=list_devices"]
    }
  }
}
```

Or expose only specific tools with `--tools`:

```json
{
  "mcpServers": {
    "expo-mcp": {
      "command": "npx",
      "args": ["-y", "expo-mcp", "--tools=start_session,stop_session,take_screenshot"]
    }
  }
}
```

## CLI Reference

```
Usage: expo-mcp [app-dir] [options]

Arguments:
  app-dir                      Path to Expo app directory (default: cwd)

Options:
  --device-id=<id>             Specific device to use (iOS simulator UUID or Android serial)
  --exclude-tools=tool1,tool2  Exclude specific tools from the MCP server
  --tools=tool1,tool2          Only expose specific tools
  -h, --help                   Show help message
  -v, --version                Show version number
```

## Quick Start

```
# 1. Start session (launches Expo + binds device + acquires lease)
start_session({ target: "ios-simulator" })

# 2. Use tools directly (no device_id needed!)
take_screenshot()
tap_on({ text: "Login" })
input_text({ text: "hello@example.com" })
press_key({ key: "Enter" })
scroll({ direction: "down" })
swipe({ direction: "left" })

# 3. Run Maestro flows
run_maestro_flow({ flow_yaml: "- assertVisible: Welcome" })
check_maestro_flow_syntax({ flow_yaml: "- tap: Login" })

# 4. Reload app after code changes
reload_app()

# 5. Check logs if needed
get_logs({ level: "error" })

# 6. Stop session when done
stop_session()
```

## Tools

### Lifecycle Tools

| Tool | Description |
|------|-------------|
| `get_session_status` | Get session status (server state, device info, lease remaining time) |
| `start_session` | Start Expo server, connect device, and acquire device lease |
| `stop_session` | Stop Expo server and release all resources |
| `reload_app` | Hot reload the app on connected device |
| `get_logs` | Get Metro bundler logs (filterable by level and source) |
| `press_key` | Press a key (Enter, Backspace, Home, Lock, Tab, Volume Up/Down) |
| `scroll` | Scroll the screen in a direction (default: down) |
| `swipe` | Swipe by direction or precise start/end coordinates |

#### start_session Options

| Option | Type | Description |
|--------|------|-------------|
| `target` | `ios-simulator` \| `android-emulator` \| `web-browser` | Target platform to launch |
| `device_id` | string | Specific device (iOS UUID or Android serial). Auto-detected if omitted |
| `host` | `lan` \| `tunnel` \| `localhost` | Connection mode |
| `port` | number | Server port (default: 8081, auto-increments if busy) |
| `clear` | boolean | Clear Metro bundler cache |
| `dev` | boolean | Development mode (default: true) |
| `minify` | boolean | Minify JavaScript |
| `max_workers` | number | Max Metro workers |
| `offline` | boolean | Offline mode |
| `scheme` | string | Custom URI scheme |
| `simulator_name` | string | iOS simulator name (e.g., "iPhone 16 Pro") |
| `clean_state` | boolean | Clean simulator state before launch (default: false) |
| `auto_login` | object | Run a Maestro flow after app loads (`{ flow_file: "path/to/flow.yaml" }`) |

### Maestro Tools

All Maestro tools work automatically once a session is active — `device_id` is injected from the session:

| Tool | Description |
|------|-------------|
| `take_screenshot` | Capture screen (auto-resized for LLM context) |
| `tap_on` | Tap on UI element by text, id, or coordinates |
| `input_text` | Type text into focused field |
| `back` | Press back button |
| `run_maestro_flow` | Run Maestro YAML flow inline |
| `run_maestro_flow_files` | Run Maestro flow files from project directory |
| `check_maestro_flow_syntax` | Validate Maestro YAML flow syntax without running it |
| `inspect_view_hierarchy` | Get UI element tree of the current screen |
| `list_devices` | List all available devices (works without an active session) |

> **Note**: Device tools require an active session. Call `start_session` first. `list_devices` and `check_maestro_flow_syntax` can be called anytime.

## Device Lease System

The device lease prevents one MCP instance from holding a device indefinitely:

1. **Acquire**: `start_session` acquires a 2-minute device lease
2. **Auto-Renew**: Every device tool call (`take_screenshot`, `tap_on`, etc.) resets the 2-minute timer
3. **Expire**: If no device tool is called for 2 minutes, the lease expires and the device becomes available
4. **Re-acquire**: Call `start_session` again to re-acquire (server stays running, no restart needed)
5. **Check**: `get_session_status` shows remaining lease time

Multiple MCP instances coordinate via a file-based registry (`/tmp/expo-mcp/instances/`), so two instances cannot claim the same device simultaneously.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `EXPO_APP_DIR` | Path to Expo app directory (CLI positional arg takes precedence) | Current working directory |
| `MAESTRO_CLI_PATH` | Path to Maestro CLI | `~/.maestro/bin/maestro` |
| `ESSENTIAL_TOOLS` | Comma-separated list of tools to expose (`--tools` takes precedence) | All tools |
| `EXCLUDE_TOOLS` | Comma-separated list of tools to exclude (`--exclude-tools` takes precedence) | None |
| `LOG_BUFFER_SIZE` | Max log lines to keep in memory | 400 |
| `EXPO_TOKEN` | Expo authentication token (only needed if offline mode is disabled) | None |

## How It Works

1. **Session Start**: `start_session` starts Expo dev server, waits for device connection, and acquires a lease
2. **Device Binding**: Connected device ID is stored in the session with a 2-minute TTL
3. **Automatic Injection**: All Maestro device tools automatically use the session's device ID
4. **Lease Renewal**: Every device tool call resets the lease timer
5. **Session End**: `stop_session` cleans up everything, or the lease expires after inactivity

## Non-Interactive Environments (CI/CD, AI Agents)

This MCP server automatically enables `--offline` mode when running in CI environments (`CI=1`). This allows the app to work without requiring an `EXPO_TOKEN`.

### What Offline Mode Does

- Skips Expo server communication (manifest signing)
- **Does NOT affect** your app's network features (API calls, fetch, etc.)
- Tunnel mode (`--tunnel`) is not available in offline mode

### If You Need Expo Account Features

For features requiring Expo authentication, disable offline mode and provide `EXPO_TOKEN`:

```json
{
  "mcpServers": {
    "expo-mcp": {
      "env": {
        "EXPO_TOKEN": "your-token-here"
      }
    }
  }
}
```

Then call `start_session` with `offline: false`:

```javascript
start_session({ target: "ios-simulator", offline: false })
```

## Requirements

- Node.js >= 18
- Xcode (for iOS Simulator)
- Android Studio (for Android Emulator)
- [Maestro CLI](https://maestro.mobile.dev/) (for UI automation)

## License

MIT
