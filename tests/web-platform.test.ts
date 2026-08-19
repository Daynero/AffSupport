import { describe, expect, it } from 'vitest';
import { platformFromUserAgent, windowsX64Supported } from '../apps/web/src/lib/platform';

describe('browser platform detection', () => {
  it('classifies Windows user agents', () => {
    expect(
      platformFromUserAgent(
        'Win32 Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'
      )
    ).toBe('windows');
  });

  it('classifies macOS user agents, even though Darwin contains "win"', () => {
    expect(
      platformFromUserAgent(
        'MacIntel Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'
      )
    ).toBe('macos');
    expect(platformFromUserAgent('Darwin Macintosh')).toBe('macos');
  });

  it('classifies Linux user agents', () => {
    expect(
      platformFromUserAgent('Linux x86_64 Mozilla/5.0 (X11; Linux x86_64) Firefox/127.0')
    ).toBe('linux');
  });

  it('falls back to "other" for unrecognized agents', () => {
    expect(platformFromUserAgent('Mozilla/5.0 (PlayStation; PlayStation 5/2.26)')).toBe('other');
  });
});

describe('windows architecture support', () => {
  it('accepts the ordinary 64-bit Windows markers', () => {
    for (const agent of [
      'Win32 Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Win32 Mozilla/5.0 (Windows NT 6.1; WOW64)',
      'Win32 Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0'
    ]) {
      expect(windowsX64Supported(agent)).toBe(true);
    }
  });

  it('accepts ARM64 Windows, which runs the x64 build under emulation', () => {
    expect(windowsX64Supported('Win32 Mozilla/5.0 (Windows NT 10.0; ARM64)')).toBe(true);
  });

  it('rejects only a Windows agent with no 64-bit marker at all', () => {
    expect(windowsX64Supported('Win32 Mozilla/5.0 (Windows NT 10.0)')).toBe(false);
  });

  it('never blocks a non-Windows visitor', () => {
    expect(windowsX64Supported('MacIntel Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(
      true
    );
    expect(windowsX64Supported('Linux x86_64 Mozilla/5.0 (X11; Linux x86_64)')).toBe(true);
  });
});
