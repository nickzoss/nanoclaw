import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  startRemoteControl,
  stopRemoteControl,
  restoreRemoteControl,
  getActiveSession,
  _resetForTesting,
  _getStateFilePath,
} from './remote-control.js';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
const mockSpawn = vi.mocked(spawn);

describe('remote-control', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetForTesting();
  });

  it('getActiveSession returns null when no session', () => {
    expect(getActiveSession()).toBeNull();
  });

  it('stopRemoteControl returns error when no active session', () => {
    const result = stopRemoteControl();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no active/i);
  });

  it('restoreRemoteControl does not throw when no state file exists', () => {
    expect(() => restoreRemoteControl()).not.toThrow();
    expect(getActiveSession()).toBeNull();
  });

  it('_getStateFilePath returns a non-empty string', () => {
    const p = _getStateFilePath();
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
  });

  it('_resetForTesting clears active session', () => {
    _resetForTesting();
    expect(getActiveSession()).toBeNull();
  });

  it('startRemoteControl returns error when spawn throws', async () => {
    mockSpawn.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    const result = await startRemoteControl('user1', 'jid@g.us', '/cwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Failed to start/);
  });

  it('startRemoteControl returns error when process exits before URL', async () => {
    // Spawn returns a proc that appears dead immediately
    const fakePid = 999_999_999; // extremely unlikely to be a real PID
    mockSpawn.mockReturnValueOnce({
      pid: fakePid,
      unref: vi.fn(),
    } as any);
    const result = await startRemoteControl('user1', 'jid@g.us', '/cwd');
    // process.kill(fakePid, 0) will throw → isProcessAlive returns false
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/exited/i);
  });
});
