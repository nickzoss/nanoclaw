import { describe, it, expect } from 'vitest';

import {
  startRemoteControl,
  stopRemoteControl,
  restoreRemoteControl,
  getActiveSession,
  _resetForTesting,
  _getStateFilePath,
} from './remote-control.js';

describe('remote-control (stub)', () => {
  it('getActiveSession returns null', () => {
    expect(getActiveSession()).toBeNull();
  });

  it('startRemoteControl returns not-supported error', async () => {
    const result = await startRemoteControl('user1', 'jid@g.us', '/cwd');
    expect(result.ok).toBe(false);
  });

  it('stopRemoteControl returns no-session error when idle', () => {
    const result = stopRemoteControl();
    expect(result.ok).toBe(false);
  });

  it('restoreRemoteControl is a no-op', () => {
    expect(() => restoreRemoteControl()).not.toThrow();
  });

  it('_resetForTesting is a no-op', () => {
    expect(() => _resetForTesting()).not.toThrow();
  });

  it('_getStateFilePath returns a string', () => {
    expect(typeof _getStateFilePath()).toBe('string');
  });
});
