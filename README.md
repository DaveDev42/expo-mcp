# expo-mcp

MCP server for Expo/React Native app automation with Maestro integration.

## Features

- **Session-Based Architecture**: Launch Expo and device binds automatically - no manual device ID management
- **Expo Dev Server Management**: Start/stop/reload Expo development server
- **Maestro Integration**: Full UI automation tools (tap, input, screenshot, etc.)

## Installation

```bash
npm install -g expo-mcp
# or
npx expo-mcp
```

## Usage with Claude Code

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "expo-mcp": {
      "command": "npx",
      "args": ["-y", "expo-mcp"],
      "env": {
        "EXPO_APP_DIR": "/path/to/your/expo/app"
      }
    }
  }
}
```

## Quick Start

```
# 1. Start session (launches Expo + binds device automatically)
launch_expo({ target: "ios-simulator" })

# 2. Use Maestro tools directly (no device_id needed!)
take_screenshot()
tap_on({ text: "Login" })
input_text({ text: "hello@example.com" })

# 3. Reload app after code changes
reload_expo()

# 4. Check logs if needed
get_logs({ level: "error" })

# 5. Stop session when done
stop_expo()
```

## Tools

### Lifecycle Tools

| Tool | Description |
|------|-------------|
| `app_status` | Get session status (server info, device_id) |
| `launch_expo` | Start Expo server and establish session with device |
| `stop_expo` | Stop Expo server and end session |
| `reload_expo` | Hot reload the app on connected device |
| `get_logs` | Get Metro bundler logs (filterable by level) |

#### launch_expo Options

| Option | Type | Description |
|--------|------|-------------|
| `target` | `ios-simulator` \| `android-emulator` \| `web-browser` | Device to launch |
| `host` | `lan` \| `tunnel` \| `localhost` | Connection mode |
| `port` | number | Server port (default: 8081, auto-increments if busy) |
| `clear` | boolean | Clear Metro bundler cache |
| `dev` | boolean | Development mode (default: true) |

### Maestro Tools

All Maestro tools work automatically once a session is active:

| Tool | Description |
|------|-------------|
| `tap_on` | Tap on UI element by text, id, or point |
| `input_text` | Type text into focused field |
| `take_screenshot` | Capture screen (auto-resized for LLM) |
| `inspect_view_hierarchy` | Get UI element tree |
| `launch_app` | Launch app by bundle ID |
| `back` | Press back button |
| `run_flow` | Run Maestro YAML flow |

> **Note**: Maestro tools require an active session. Call `launch_expo` first.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `EXPO_APP_DIR` | Path to Expo app directory | Current working directory |
| `MAESTRO_CLI_PATH` | Path to Maestro CLI | `~/.maestro/bin/maestro` |
| `ESSENTIAL_TOOLS` | Comma-separated list of tools to expose | All tools |
| `LOG_BUFFER_SIZE` | Max log lines to keep in memory | 400 |
| `EXPO_TOKEN` | Expo authentication token (optional, only needed if offline mode is disabled) | None |

## How It Works

1. **Session Creation**: `launch_expo` starts Expo dev server and waits for device connection
2. **Device Binding**: Once device connects, its ID is stored in the session
3. **Automatic Injection**: All Maestro tools automatically use the session's device ID
4. **Session End**: `stop_expo` cleans up everything

This eliminates the need for manual `device_id` management.

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

Then call `launch_expo` with `offline: false`:

```javascript
launch_expo({ target: "ios-simulator", offline: false })
```

## Requirements

- Node.js >= 18
- Xcode (for iOS Simulator)
- Android Studio (for Android Emulator)
- [Maestro CLI](https://maestro.mobile.dev/) (for UI automation)

## License

MIT
