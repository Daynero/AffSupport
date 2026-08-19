import { describe, expect, it } from 'vitest';
import { AGENT_CAPABILITIES } from '../packages/shared/src/types.js';
import { advertisedCapabilities, hasCapability } from '../apps/agent/src/server/capabilities.js';
import type { PlatformCapabilities } from '../apps/agent/src/platform/platform.js';

const macOS: PlatformCapabilities = {
  nativeFilePicker: true,
  revealInFileManager: true,
  spotlightSearch: true,
  shellContextMenuIntegration: true,
  processPause: true
};

const windows: PlatformCapabilities = {
  nativeFilePicker: true,
  revealInFileManager: true,
  spotlightSearch: false,
  shellContextMenuIntegration: false,
  processPause: false
};

const headless: PlatformCapabilities = {
  nativeFilePicker: false,
  revealInFileManager: true,
  spotlightSearch: false,
  shellContextMenuIntegration: false,
  processPause: true
};

describe('advertised agent capabilities', () => {
  it('advertises every capability on macOS', () => {
    expect(advertisedCapabilities(macOS)).toEqual([...AGENT_CAPABILITIES]);
  });

  it('advertises the native picker on Windows but not the Finder-only bridge', () => {
    const advertised = advertisedCapabilities(windows);
    expect(advertised).toContain('native-file-picker');
    expect(advertised).not.toContain('finder-image-conversion');
  });

  it('drops the picker where the host has no native chooser', () => {
    const advertised = advertisedCapabilities(headless);
    expect(advertised).not.toContain('native-file-picker');
    expect(advertised).not.toContain('finder-image-conversion');
  });

  it('keeps platform-neutral tool capabilities on every host', () => {
    for (const platform of [macOS, windows, headless]) {
      const advertised = advertisedCapabilities(platform);
      expect(advertised).toEqual(
        expect.arrayContaining([
          'landing',
          'landing-preview',
          'local-file-paths',
          'team-workspace',
          'transcription'
        ])
      );
    }
  });

  it('advertises a subset of the closed capability set, in its stable order', () => {
    for (const platform of [macOS, windows, headless]) {
      const advertised = advertisedCapabilities(platform);
      expect(AGENT_CAPABILITIES).toEqual(expect.arrayContaining(advertised));
      expect(advertised).toEqual([...AGENT_CAPABILITIES].filter(c => advertised.includes(c)));
    }
  });

  it('agrees with hasCapability, which the route guards use', () => {
    for (const platform of [macOS, windows, headless]) {
      for (const capability of AGENT_CAPABILITIES) {
        expect(hasCapability(capability, platform)).toBe(
          advertisedCapabilities(platform).includes(capability)
        );
      }
    }
  });
});
