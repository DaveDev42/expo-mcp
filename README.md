# expo-mcp

MCP server for Expo/React Native app automation with Maestro integration.

## Features

- **Expo Dev Server Management**: Start/stop Expo development server with automatic device launch
- **Automatic Device Management**: Uses Expo CLI's built-in simulator/emulator management
- **Maestro Integration**: Full Maestro MCP tools for UI automation

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

1. **Check status**:
   ```
   app_status
   ```

2. **Start Expo with iOS Simulator**:
   ```
   launch_expo({ platform: "ios" })
   ```
   This automatically:
   - Boots iOS Simulator (if not running)
   - Installs Expo Go (if needed)
   - Opens your app in Expo Go

3. **Or start with Android Emulator**:
   ```
   launch_expo({ platform: "android" })
   ```

4. **Use Maestro for UI testing**:
   ```
   maestro_take_screenshot({ path: "/tmp/screenshot.png" })
   maestro_tap_on({ text: "Login" })
   ```

5. **Stop when done**:
   ```
   stop_expo
   ```

## Tools

### Lifecycle Tools

| Tool | Description |
|------|-------------|
| `app_status` | Get status of Expo server |
| `launch_expo` | Start Expo dev server (with optional --ios or --android) |
| `stop_expo` | Stop Expo dev server |

### Maestro Tools (Proxied)

All Maestro MCP tools are available with `maestro_` prefix:

| Tool | Description |
|------|-------------|
| `maestro_tap_on` | Tap on UI element |
| `maestro_input_text` | Input text |
| `maestro_take_screenshot` | Take screenshot |
| `maestro_inspect_view_hierarchy` | Get UI hierarchy |
| `maestro_run_flow` | Run Maestro flow |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `EXPO_APP_DIR` | Path to Expo app directory | Current working directory |
| `MAESTRO_CLI_PATH` | Path to Maestro CLI | `~/.maestro/bin/maestro` |

## How It Works

This MCP server leverages Expo CLI's built-in device management. When you call `launch_expo` with a `platform` parameter:

```
npx expo start --ios   # Boots simulator, installs Expo Go, opens app
npx expo start --android   # Boots emulator, installs Expo Go, opens app
```

This is much simpler and more reliable than managing devices manually.

## Requirements

- Node.js >= 18
- Xcode (for iOS Simulator)
- Android Studio (for Android Emulator)
- [Maestro CLI](https://maestro.mobile.dev/) (for UI automation)

## License

MIT
