// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  HOME_GROUPS,
  catalogueByGroup,
  routeKind,
  webTools
} from '../apps/web/src/lib/tool-registry';
import { translate } from '../apps/web/src/i18n';
import { isProtected } from '../apps/web/src/lib/feature-flags';

describe('Soty product launcher', () => {
  it('maps the root and direct tool URLs to separate product screens', () => {
    expect(routeKind('/')).toBe('home');
    expect(routeKind('/compressor')).toBe('compressor');
    expect(routeKind('/landing-preview')).toBe('landing-preview');
    expect(routeKind('/transcription')).toBe('transcription');
  });

  it('defines tools through one extensible registry', () => {
    // Declaration order is the reading order: the stitcher sits beside the
    // compressor it shares a library with, transcription follows the media
    // tools, the two landing tools are kept apart, and the one browser-only
    // tool sits after everything that runs on the agent.
    expect(webTools.map(({ id, path, status }) => ({ id, path, status }))).toEqual([
      { id: 'compressor', path: '/compressor', status: 'available' },
      { id: 'stitcher', path: '/stitcher', status: 'available' },
      { id: 'transcription', path: '/transcription', status: 'available' },
      { id: 'landingOptimizer', path: '/landing-optimizer', status: 'available' },
      { id: 'twoFactor', path: '/2fa', status: 'available' },
      { id: 'landingPreview', path: '/landing-preview', status: 'available' }
    ]);
  });

  it('shows the landing optimizer before the local app reports capabilities', () => {
    // The catalogue is static — agent capabilities only gate opening the tool.
    expect(webTools.map(tool => tool.analyticsId)).toEqual([
      'compressor',
      'stitcher',
      'transcription',
      'landing-optimizer',
      'two-factor',
      'landing-preview'
    ]);
    expect(webTools.find(tool => tool.id === 'landingOptimizer')?.capability).toBe('landing');
    expect(webTools.find(tool => tool.id === 'landingPreview')?.capability).toBe('landing-preview');
  });

  it('groups the tools by errand without reordering the registry', () => {
    // The declaration order above is untouched; the group is a field, and the
    // home screen draws one row per group in `HOME_GROUPS` order.
    expect(HOME_GROUPS).toEqual(['video', 'landing', 'other']);
    expect(
      catalogueByGroup().map(row => ({ group: row.group, ids: row.tools.map(tool => tool.id) }))
    ).toEqual([
      { group: 'video', ids: ['compressor', 'stitcher', 'transcription'] },
      { group: 'landing', ids: ['landingOptimizer', 'landingPreview'] },
      { group: 'other', ids: ['twoFactor'] }
    ]);
  });

  it('keeps the home styles in their own sheet, on tokens, with the three widths', async () => {
    const home = await readFile('apps/web/src/styles/home.css', 'utf8');
    expect(home).toContain('.home-tile-link::after');
    expect(home).toContain(':focus-visible');
    expect(home).toContain('@media (min-width: 720px)');
    expect(home).toContain('@media (min-width: 1100px)');
    expect(home).toContain('@media (max-width: 500px)');
    // The legacy launcher is gone from the big sheet rather than shadowed.
    const legacy = await readFile('apps/web/src/styles.css', 'utf8');
    expect(legacy).not.toMatch(/\.launcher\b|\.tool-card\b|\.tool-grid\b/);
  });

  it('opens the landing optimizer to every Soty user without a developer pass', () => {
    expect(isProtected('landingOptimizer')).toBe(false);
    expect(isProtected('landingPreview')).toBe(false);
  });

  it('localizes launcher content in EN and UA', () => {
    // The home is a launcher now, not a hero: a short title on the content
    // axis, and the tools in three rows named by the errand.
    expect(translate('en', 'homeTitle')).toBe('Tools');
    expect(translate('uk', 'homeTitle')).toBe('Інструменти');
    expect(translate('en', 'homeGroupVideo')).toBe('Video');
    expect(translate('uk', 'homeGroupVideo')).toBe('Відео');
    expect(translate('en', 'homeGroupLanding')).toBe('Landing pages');
    expect(translate('uk', 'homeGroupLanding')).toBe('Лендінги');
    expect(translate('en', 'homeGroupOther')).toBe('Other');
    expect(translate('uk', 'homeGroupOther')).toBe('Інше');
    expect(translate('uk', 'homeHowToStart')).toBe('Як запустити');
    expect(translate('en', 'comingSoon')).toBe('Coming soon');
    expect(translate('uk', 'comingSoon')).toBe('Незабаром');
    expect(translate('en', 'inDevelopment')).toBe('In development');
    expect(translate('uk', 'inDevelopment')).toBe('В розробці');
    expect(translate('en', 'betaTesting')).toBe('Beta testing');
    expect(translate('uk', 'betaTesting')).toBe('Бета-тестування');
  });

  it('keeps keyboard focus, responsive layout, reduced motion and hosting fallback', async () => {
    const [styles, redirects] = await Promise.all([
      readFile('apps/web/src/styles.css', 'utf8'),
      readFile('apps/web/public/_redirects', 'utf8')
    ]);
    expect(styles).toContain(':focus-visible');
    expect(styles).toContain('@media (max-width: 760px)');
    expect(styles).toContain('@media (max-width: 500px)');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(redirects).toContain('/* /index.html 200');
  });

  it('starts the Agent quietly and leaves opening Soty to the user', async () => {
    const [launcher, entrypoint, serverFactory] = await Promise.all([
      readFile('packaging/Launcher.swift', 'utf8'),
      readFile('apps/agent/src/index.ts', 'utf8'),
      readFile('apps/agent/src/server/app.ts', 'utf8')
    ]);
    const agent = `${entrypoint}\n${serverFactory}`;
    expect(launcher).not.toContain('scheduleAutomaticInterfaceOpen');
    expect(launcher).toContain('action: #selector(openInterface)');
    const existingInstance = launcher.slice(
      launcher.indexOf('private func handleExistingInstance'),
      launcher.indexOf('private func waitForPreviousAgent')
    );
    expect(existingInstance).not.toContain('openInterface()');
    expect(agent).not.toContain("import open from 'open'");
    expect(agent).not.toContain('Could not open Soty in the browser');
  });

  it('drains an older Agent without exposing a port error to the user', async () => {
    const [launcher, agent] = await Promise.all([
      readFile('packaging/Launcher.swift', 'utf8'),
      readFile('apps/agent/src/index.ts', 'utf8')
    ]);
    expect(launcher).toContain('Soty will finish updating after the current task.');
    expect(launcher).toContain('Restart Soty now…');
    expect(launcher).not.toContain('An old Agent process is still using port 43120.');
    expect(launcher).toContain('requestPreviousAgentDrain(fallbackWhenIdle: false)');
    expect(launcher).toContain('X-Wishly-Update-Token');
    expect(launcher).toContain('AGENT_UPDATE_HANDOFF_TOKEN');
    expect(launcher).toContain('updateHandoffExitStatus');
    expect(launcher).toContain('terminateVerifiedAgentListeningOnPort');
    expect(launcher).toContain('Darwin.kill(pid, SIGTERM)');
    expect(launcher).toContain('/Contents/Resources/runtime/node');
    expect(launcher).toContain('/Contents/Resources/agent/dist/index.js');
    expect(launcher).toContain('AGENT_LAUNCHER_PID');
    expect(agent).toContain('UPDATE_HANDOFF_EXIT_CODE = 76');
    expect(agent).toContain('modules.some(module => module.busy())');
    expect(agent).toContain('requestUpdateDrain(targetBuildId)');
  });
});
