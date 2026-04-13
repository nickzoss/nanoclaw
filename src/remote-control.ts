/**
 * Remote Control stub — this feature required the Claude Code CLI (`claude remote-control`),
 * which is not available in the GitHub Copilot CLI. All calls return a "not supported" error.
 */

export interface RemoteControlSession {
  pid: number;
  url: string;
  startedBy: string;
  startedInChat: string;
  startedAt: string;
}

let _stateFilePath = '/dev/null';

/** @internal — exported for testing only */
export function _resetForTesting(): void {}

/** @internal — exported for testing only */
export function _getStateFilePath(): string {
  return _stateFilePath;
}

export function restoreRemoteControl(): void {
  // no-op: feature not supported
}

export function getActiveSession(): RemoteControlSession | null {
  return null;
}

export async function startRemoteControl(
  _sender: string,
  _chatJid: string,
  _cwd: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  return {
    ok: false,
    error:
      'Remote Control is not supported with the GitHub Copilot CLI. This feature required the Claude Code CLI.',
  };
}

export function stopRemoteControl():
  | { ok: true }
  | { ok: false; error: string } {
  return { ok: false, error: 'No active Remote Control session' };
}
