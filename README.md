# expo-mcp

MCP server for Expo/React Native app automation with iOS Simulator, Android Emulator, and Maestro integration.

## Features

- **Expo Dev Server Management**: Start/stop Expo development server
- **iOS Simulator Control**: Boot, shutdown, and manage iOS simulators
- **Android Emulator Control**: Start, stop, and manage Android emulators
- **Expo Go Installation**: Automatically download and install Expo Go on simulators/emulators
- **App Loading**: Open your Expo app in Expo Go with a single command
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

1. **Start a simulator/emulator**:
   ```
   start_simulator  # for iOS
   start_emulator   # for Android
   ```

2. **Install Expo Go**:
   ```
   install_app({ platform: "ios" })
   ```

3. **Start Expo dev server**:
   ```
   launch_expo
   ```

4. **Open your app in Expo Go**:
   ```
   open_app
   ```

## Tools

### Lifecycle Tools

| Tool | Description |
|------|-------------|
| `app_status` | Get status of Expo server, device, and Expo Go installation |
| `launch_expo` | Start Expo dev server |
| `stop_expo` | Stop Expo dev server |
| `start_simulator` | Boot iOS Simulator |
| `start_emulator` | Start Android Emulator |
| `stop_device` | Shutdown simulator/emulator |
| `install_app` | Install Expo Go on device (auto-downloads if needed) |
| `open_app` | Open Expo app URL in Expo Go |
| `launch_expo_go` | Launch Expo Go app |

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

## Workflow Example

Here's a typical workflow for testing an Expo app:

```typescript
// 1. Check current status
app_status()

// 2. Start iOS simulator
start_simulator({ device_name: "iPhone 15 Pro" })

// 3. Install Expo Go (will download if not cached)
install_app({ platform: "ios" })

// 4. Start Expo development server
launch_expo({ port: 8081 })

// 5. Open the app in Expo Go
open_app()

// 6. Use Maestro for UI testing
maestro_take_screenshot({ path: "/tmp/screenshot.png" })
maestro_tap_on({ text: "Login" })

// 7. Clean up when done
stop_expo()
stop_device({ platform: "ios" })
```

## Expo Go Versions

The MCP server automatically downloads the appropriate Expo Go version:

- **iOS Simulator**: Downloads `.app` bundle from Expo's CDN
- **Android Emulator**: Downloads `.apk` from Expo's CDN

Downloaded files are cached in the system temp directory for faster subsequent installs.

## Requirements

- Node.js >= 18
- Xcode (for iOS Simulator)
- Android Studio (for Android Emulator)
- [Maestro CLI](https://maestro.mobile.dev/) (for UI automation)

## License

MIT
