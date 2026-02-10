#!/usr/bin/env node

import { McpServer } from './server.js';

function printUsage() {
  console.log(`Usage: expo-mcp [app-dir] [options]

MCP server for Expo/React Native app automation with Maestro integration.

Arguments:
  app-dir                      Path to Expo app directory (default: cwd)

Options:
  --exclude-tools=tool1,tool2  Exclude specific tools from the MCP server
  --tools=tool1,tool2          Only expose specific tools (mutually exclusive with --exclude-tools)
  -h, --help                   Show this help message
  -v, --version                Show version number

Environment Variables:
  EXPO_APP_DIR                 Path to Expo app directory (CLI arg takes precedence)
  ESSENTIAL_TOOLS              Comma-separated list of tools to expose
  EXCLUDE_TOOLS                Comma-separated list of tools to exclude

Examples:
  expo-mcp                                        Use current directory
  expo-mcp apps/mobile                            Monorepo subdirectory
  expo-mcp --exclude-tools=list_devices            Exclude specific tools
  expo-mcp apps/mobile --exclude-tools=list_devices Combined usage`);
}

const args = process.argv.slice(2);
let appDir: string | undefined;
let essentialTools: string | undefined;
let excludeTools: string | undefined;

for (const arg of args) {
  if (arg === '--help' || arg === '-h') {
    printUsage();
    process.exit(0);
  } else if (arg === '--version' || arg === '-v') {
    console.log('expo-mcp 0.2.0');
    process.exit(0);
  } else if (arg.startsWith('--exclude-tools=')) {
    excludeTools = arg.slice('--exclude-tools='.length);
  } else if (arg.startsWith('--tools=')) {
    essentialTools = arg.slice('--tools='.length);
  } else if (arg.startsWith('-')) {
    console.error(`Unknown option: ${arg}`);
    process.exit(1);
  } else {
    appDir = arg;
  }
}

// Precedence: CLI > env > default
const resolvedAppDir = appDir || process.env.EXPO_APP_DIR || process.cwd();
const resolvedEssentialTools = essentialTools ?? process.env.ESSENTIAL_TOOLS;
const resolvedExcludeTools = excludeTools ?? process.env.EXCLUDE_TOOLS;

if (resolvedEssentialTools && resolvedExcludeTools) {
  console.error('Error: Cannot use both --tools and --exclude-tools simultaneously.');
  process.exit(1);
}

const server = new McpServer(resolvedAppDir, {
  essentialTools: resolvedEssentialTools,
  excludeTools: resolvedExcludeTools,
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.error('[expo-mcp] Shutting down...');
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('[expo-mcp] Shutting down...');
  await server.stop();
  process.exit(0);
});

// Start server
server.start().catch((error) => {
  console.error('[expo-mcp] Fatal error:', error);
  process.exit(1);
});
