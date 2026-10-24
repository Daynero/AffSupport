import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { applicationSupportRoot } from '../apps/agent/src/files/support-dir';
import { landingSettingsPath, saveLandingSettings } from '../apps/agent/src/landing/store';
import { defaultLandingSettings } from '@video-compressor/shared';

it('keeps default agent writes in the test profile after environment mocks are restored', () => {
  const baseline = process.env.AGENT_SUPPORT_DIRECTORY_NAME;
  expect(baseline).toMatch(/^Soty Verification-[a-f0-9-]{36}-unit$/u);
  expect(path.basename(applicationSupportRoot())).toBe(baseline);
  vi.stubEnv('AGENT_SUPPORT_DIRECTORY_NAME', 'Soty-temporary-mock');
  vi.unstubAllEnvs();
  expect(process.env.AGENT_SUPPORT_DIRECTORY_NAME).toBe(baseline);
  expect(path.basename(applicationSupportRoot())).toBe(baseline);
});

it('persists default landing settings only beneath the isolated profile', async () => {
  const directory = applicationSupportRoot();
  expect(path.basename(directory)).toMatch(/^Soty Verification-[a-f0-9-]{36}-unit$/u);
  expect(landingSettingsPath()).toBe(path.join(directory, 'landing-settings.json'));
  const settings = defaultLandingSettings();
  await saveLandingSettings(settings);
  expect(JSON.parse(await readFile(landingSettingsPath(), 'utf8'))).toEqual(settings);
});
