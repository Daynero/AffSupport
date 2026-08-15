import { describe, expect, it } from 'vitest';
import {
  packagedAgentLostLauncher,
  parseLauncherPid
} from '../apps/agent/src/runtime/launcher-watchdog.js';

describe('packaged Agent launcher watchdog', () => {
  it('accepts only a usable explicit launcher PID', () => {
    expect(parseLauncherPid('721')).toBe(721);
    expect(parseLauncherPid(undefined)).toBeNull();
    expect(parseLauncherPid('1')).toBeNull();
    expect(parseLauncherPid('-4')).toBeNull();
    expect(parseLauncherPid('8.5')).toBeNull();
  });

  it('keeps a packaged Agent alive while its launcher is still present', () => {
    expect(
      packagedAgentLostLauncher({
        initialParentPid: 500,
        currentParentPid: 500,
        launcherPid: 500,
        isAlive: pid => pid === 500
      })
    ).toBe(false);
  });

  it('stops when its parent changes even for packages created before launcher PID support', () => {
    expect(
      packagedAgentLostLauncher({
        initialParentPid: 500,
        currentParentPid: 1,
        launcherPid: null,
        isAlive: () => true
      })
    ).toBe(true);
  });

  it('stops when an explicit launcher PID is gone even if Node started under launchd', () => {
    expect(
      packagedAgentLostLauncher({
        initialParentPid: 1,
        currentParentPid: 1,
        launcherPid: 500,
        isAlive: () => false
      })
    ).toBe(true);
  });
});
