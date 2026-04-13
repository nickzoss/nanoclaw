/**
 * Remote Control via `copilot --remote`
 *
 * Spawns a detached `copilot --remote --yolo --autopilot` process from the project
 * root (which must be a GitHub-hosted git repo). Copilot publishes a session URL
 * in the format https://github.com/OWNER/REPO/tasks/TASK_ID, which is polled from
 * the process stdout file and returned to the caller.
 *
 * The user can then steer the session from GitHub web or GitHub Mobile without
 * needing to be at the terminal where NanoClaw is running.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

export interface RemoteControlSession {
  pid: number;
  url: string;
  startedBy: string;
  startedInChat: string;
  startedAt: string;
}

let activeSession: RemoteControlSession | null = null;

// URL format emitted by `copilot --remote` once connected to Mission Control.
// Strip ANSI escape codes before matching.
const URL_REGEX = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/tasks\/[^\s]+/;
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1B\[[0-9;]*[A-Za-z]/g;
const URL_TIMEOUT_MS = 45_000;
const URL_POLL_MS = 300;
const STATE_FILE = path.join(DATA_DIR, 'remote-control.json');
const STDOUT_FILE = path.join(DATA_DIR, 'remote-control.stdout');
const STDERR_FILE = path.join(DATA_DIR, 'remote-control.stderr');

function saveState(session: RemoteControlSession): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(session));
}

function clearState(): void {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // ignore
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** @internal — exported for testing only */
export function _resetForTesting(): void {
  activeSession = null;
}

/** @internal — exported for testing only */
export function _getStateFilePath(): string {
  return STATE_FILE;
}

/**
 * Restore session from disk on startup.
 * If the process is still alive, adopt it. Otherwise clean up.
 */
export function restoreRemoteControl(): void {
  let data: string;
  try {
    data = fs.readFileSync(STATE_FILE, 'utf-8');
  } catch {
    return;
  }

  try {
    const session: RemoteControlSession = JSON.parse(data);
    if (session.pid && isProcessAlive(session.pid)) {
      activeSession = session;
      logger.info(
        { pid: session.pid, url: session.url },
        'Restored Remote Control session from previous run',
      );
    } else {
      clearState();
    }
  } catch {
    clearState();
  }
}

export function getActiveSession(): RemoteControlSession | null {
  return activeSession;
}

export async function startRemoteControl(
  sender: string,
  chatJid: string,
  cwd: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (activeSession) {
    if (isProcessAlive(activeSession.pid)) {
      return { ok: true, url: activeSession.url };
    }
    activeSession = null;
    clearState();
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const stdoutFd = fs.openSync(STDOUT_FILE, 'w');
  const stderrFd = fs.openSync(STDERR_FILE, 'w');

  let proc;
  try {
    proc = spawn('copilot', ['--remote', '--yolo', '--autopilot'], {
      cwd,
      stdio: ['pipe', stdoutFd, stderrFd],
      detached: true,
      env: { ...process.env },
    });
  } catch (err: any) {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    return { ok: false, error: `Failed to start: ${err.message}` };
  }

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  proc.unref();

  const pid = proc.pid;
  if (!pid) {
    return { ok: false, error: 'Failed to get process PID' };
  }

  return new Promise((resolve) => {
    const startTime = Date.now();

    const poll = () => {
      if (!isProcessAlive(pid)) {
        resolve({ ok: false, error: 'Process exited before producing URL' });
        return;
      }

      let content = '';
      try {
        content = fs.readFileSync(STDOUT_FILE, 'utf-8');
      } catch {
        // file not yet written
      }

      const clean = content.replace(ANSI_REGEX, '');
      const match = clean.match(URL_REGEX);
      if (match) {
        const session: RemoteControlSession = {
          pid,
          url: match[0],
          startedBy: sender,
          startedInChat: chatJid,
          startedAt: new Date().toISOString(),
        };
        activeSession = session;
        saveState(session);
        logger.info(
          { url: match[0], pid, sender, chatJid },
          'Remote Control session started',
        );
        resolve({ ok: true, url: match[0] });
        return;
      }

      if (Date.now() - startTime >= URL_TIMEOUT_MS) {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // already dead
          }
        }
        resolve({
          ok: false,
          error: 'Timed out waiting for Remote Control URL',
        });
        return;
      }

      setTimeout(poll, URL_POLL_MS);
    };

    poll();
  });
}

export function stopRemoteControl():
  | { ok: true }
  | { ok: false; error: string } {
  if (!activeSession) {
    return { ok: false, error: 'No active Remote Control session' };
  }

  const { pid } = activeSession;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already dead
  }
  activeSession = null;
  clearState();
  logger.info({ pid }, 'Remote Control session stopped');
  return { ok: true };
}
