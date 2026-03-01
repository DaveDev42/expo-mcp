import { execSync } from 'child_process';

/**
 * Kill orphaned Maestro MCP processes (ppid=1) left by previous crashes.
 * Runs at startup; failures are non-fatal.
 */
export function cleanupOrphanedMaestroProcesses(): void {
  if (process.platform === 'win32') return;

  try {
    // Find all maestro mcp processes
    const output = execSync('pgrep -af "maestro mcp$"', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    for (const line of output.trim().split('\n')) {
      if (!line.trim()) continue;
      const pid = parseInt(line.trim().split(/\s+/)[0], 10);
      if (isNaN(pid) || pid === process.pid) continue;

      try {
        // Check if this process is orphaned (ppid=1)
        const ppidOutput = execSync(`ps -o ppid= -p ${pid}`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const ppid = parseInt(ppidOutput.trim(), 10);

        if (ppid === 1) {
          console.error(`[cleanup] Killing orphaned Maestro process: PID ${pid}`);
          try {
            // Try process group kill first
            process.kill(-pid, 'SIGKILL');
          } catch {
            try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
          }
        }
      } catch {
        // Process may have already exited
      }
    }
  } catch {
    // pgrep returns non-zero when no matches found, or command not available
  }
}
