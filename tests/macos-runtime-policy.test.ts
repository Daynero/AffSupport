import { describe, expect, it } from 'vitest';
import { buildWhisperArgs } from '../apps/agent/src/whisper/transcriber.js';
import { runtimeArchitecture } from '../apps/agent/src/platform/platform.js';
const params = {
  wavPath: '/tmp/a.wav',
  outputBase: '/tmp/a',
  language: 'en',
  quality: 'fast' as const
};
describe('Intel runtime policy', () => {
  it.each([
    ['darwin', 'x64', '1'],
    ['darwin', 'arm64', '5'],
    ['win32', 'x64', '1']
  ] as const)('%s/%s decodes with %s beams', (platform, architecture, beams) => {
    const args = buildWhisperArgs(params, {
      platform,
      architecture,
      vadModelPath: null,
      threads: 4
    });
    expect(args[args.indexOf('-bs') + 1]).toBe(beams);
    expect(args[args.indexOf('-t') + 1]).toBe('4');
  });
  it('does not guess unsupported native architectures', () => {
    expect(runtimeArchitecture('ia32')).toBe('unknown');
    expect(runtimeArchitecture('arm64')).toBe('arm64');
    expect(runtimeArchitecture('x64')).toBe('x64');
  });
});
