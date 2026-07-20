// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { toolsForCapabilities, wishlyTools } from '../apps/web/src/HomePage';
import { routeKind } from '../apps/web/src/Root';
import { translate } from '../apps/web/src/i18n';
import { isProtected } from '../apps/web/src/lib/feature-flags';

describe('Wishly product launcher', () => {
  it('maps the root and direct compressor URL to separate product screens', () => {
    expect(routeKind('/')).toBe('home');
    expect(routeKind('/compressor')).toBe('compressor');
    expect(routeKind('/transcription')).toBe('home');
  });

  it('defines tools through one extensible configuration list', () => {
    expect(wishlyTools.map(({ id, route, status }) => ({ id, route, status }))).toEqual([
      { id: 'compressor', route: '/compressor', status: 'active' },
      { id: 'transcription', route: null, status: 'coming-soon' }
    ]);
  });

  it('shows the landing optimizer before the local app reports capabilities', () => {
    expect(toolsForCapabilities([]).map(tool => tool.id)).toEqual([
      'compressor',
      'landing-optimizer',
      'transcription'
    ]);
  });

  it('opens the landing optimizer to every Wishly user without a developer pass', () => {
    expect(isProtected('landingOptimizer')).toBe(false);
  });

  it('localizes launcher content in EN and UA', () => {
    expect(translate('en', 'toolsTitle')).toBe('Wishly Tools');
    expect(translate('uk', 'toolsTitle')).toBe('Інструменти Wishly');
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
});
