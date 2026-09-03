import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultLandingSettings, landingSettingsFrom, type LandingSettings } from '@video-compressor/shared';
import { applicationSupportRoot } from '../files/support-dir.js';

/**
 * The Landing Optimizer's settings, kept across restarts.
 *
 * They were held in memory only, which was survivable while they were three quality choices
 * and an archive switch. It stops being survivable the moment one of them is a folder: a
 * person picks where their landings should go, quits, comes back, and the tool has quietly
 * returned to writing beside the originals — which is the very confusion this file exists to
 * end. The compressor has persisted its own for exactly as long.
 *
 * Written through a temporary file and renamed into place, so an interrupted write leaves the
 * previous settings rather than half of the new ones. Failing to save is never fatal: the
 * settings still apply to this run, they simply do not outlive it.
 */
export function landingSettingsPath(): string {
  return (
    process.env.AGENT_LANDING_SETTINGS_PATH ??
    path.join(applicationSupportRoot(), 'landing-settings.json')
  );
}

export async function loadLandingSettings(
  file = landingSettingsPath()
): Promise<LandingSettings> {
  try {
    return landingSettingsFrom(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    // No file yet, or one this build cannot read: the defaults are a complete answer.
    return defaultLandingSettings();
  }
}

export async function saveLandingSettings(
  settings: LandingSettings,
  file = landingSettingsPath()
): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(settings, null, 2), 'utf8');
    await rename(temporary, file);
  } catch {
    // An unwritable settings file costs this session's preferences, nothing more.
  }
}
