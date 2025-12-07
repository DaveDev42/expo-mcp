# expo-mcp

MCP server for Expo/React Native app automation with iOS Simulator, Android Emulator, and Maestro integration.

## Features

- **Expo Dev Server Management**: Start/stop Expo development server
- **iOS Simulator Control**: Boot, shutdown, and manage iOS simulators
- **Android Emulator Control**: Start, stop, and manage Android emulators
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

## Tools

### Lifecycle Tools

| Tool | Description |
|------|-------------|
| `app_status` | Get status of Expo server, device, and app |
| `launch_expo` | Start Expo dev server |
| `stop_expo` | Stop Expo dev server |
| `start_simulator` | Boot iOS Simulator |
| `start_emulator` | Start Android Emulator |
| `stop_device` | Shutdown simulator/emulator |
| `install_app` | Install app on device |

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

## Requirements

- Node.js >= 18
- Xcode (for iOS Simulator)
- Android Studio (for Android Emulator)
- [Maestro CLI](https://maestro.mobile.dev/) (for UI automation)

## License

MIT
