// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { routeKind, webTools } from '../apps/web/src/lib/tool-registry';
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
    expect(webTools.map(({ id, path, status }) => ({ id, path, status }))).toEqual([
      { id: 'compressor', path: '/compressor', status: 'available' },
      { id: 'landingOptimizer', path: '/landing-optimizer', status: 'available' },
      { id: 'landingPreview', path: '/landing-preview', status: 'available' },
      { id: 'transcription', path: '/transcription', status: 'in-development' }
    ]);
  });

  it('shows the landing optimizer before the local app reports capabilities', () => {
    // The catalogue is static — agent capabilities only gate opening the tool.
    expect(webTools.map(tool => tool.analyticsId)).toEqual([
      'compressor',
      'landing-optimizer',
      'landing-preview',
      'transcription'
    ]);
    expect(webTools.find(tool => tool.id === 'landingOptimizer')?.capability).toBe('landing');
    expect(webTools.find(tool => tool.id === 'landingPreview')?.capability).toBe('landing-preview');
  });

  it('opens the landing optimizer to every Soty user without a developer pass', () => {
    expect(isProtected('landingOptimizer')).toBe(false);
    expect(isProtected('landingPreview')).toBe(false);
  });

  it('localizes launcher content in EN and UA', () => {
    expect(translate('en', 'toolsTitle')).toBe('Soty Tools');
    expect(translate('uk', 'toolsTitle')).toBe('Інструменти Soty');
    expect(translate('en', 'comingSoon')).toBe('Coming soon');
    expect(translate('uk', 'comingSoon')).toBe('Незабаром');
    expect(translate('en', 'inDevelopment')).toBe('In development');
    expect(translate('uk', 'inDevelopment')).toBe('В розробці');
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
