#!/usr/bin/env node

import { McpServer } from './server.js';

// EXPO_APP_DIR environment variable or current working directory
const appDir = process.env.EXPO_APP_DIR || process.cwd();
const server = new McpServer(appDir);

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
