import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AGENT_PRODUCT_NAME,
  PRODUCT_NAME,
  PRODUCTION_SITE_ORIGIN,
  RELEASE_ARTIFACT_NAME,
  RELEASE_DOWNLOAD_URL
} from '../packages/shared/src/release';
import { translate, translationKeys } from '../apps/web/src/i18n';

const OLD_BRAND = /Local Video Compressor/;

describe('Soty brand identity', () => {
  it('names the product and local application Soty', () => {
    expect(PRODUCT_NAME).toBe('Soty');
    expect(AGENT_PRODUCT_NAME).toBe('Soty');
    expect(translate('en', 'appName')).toBe('Soty');
    expect(translate('uk', 'appName')).toBe('Soty');
  });

  it('uses Soty in connection and install strings in both languages', () => {
    expect(translate('en', 'agentConnected')).toBe('Soty connected');
    expect(translate('uk', 'agentConnected')).toBe('Soty підключено');
    expect(translate('uk', 'agentNotRunning')).toBe('Soty не запущено');
    expect(translate('uk', 'agentUpdateRequired')).toBe('Потрібне оновлення Soty');
    expect(translate('uk', 'downloadAgent')).toBe('Встановити Soty');
    expect(translate('en', 'downloadAgent')).toBe('Install Soty');
  });

  it('leaves no old brand names in either dictionary', () => {
    const text = translationKeys
      .flatMap(key => [translate('en', key), translate('uk', key)])
      .join(' ');
    expect(text).not.toMatch(OLD_BRAND);
  });

  it('publishes release artifacts under the Soty name', () => {
    expect(RELEASE_ARTIFACT_NAME).toMatch(/^Soty-v.+-macOS-arm64\.dmg$/);
    expect(RELEASE_DOWNLOAD_URL).toContain(RELEASE_ARTIFACT_NAME);
  });

  it('serves the hosted page from the canonical custom origin configured in one place', () => {
    expect(PRODUCTION_SITE_ORIGIN).toBe('https://soty.pp.ua');
    const env = readFileSync('config/production.env', 'utf8');
    expect(env.match(/^PUBLIC_SITE_ORIGIN=(.+)$/m)?.[1]?.trim()).toBe(PRODUCTION_SITE_ORIGIN);
  });

  it('brands the web document metadata', () => {
    const html = readFileSync('apps/web/index.html', 'utf8');
    expect(html).toContain('<title>Soty — Local media tools and team workspace</title>');
    expect(html).toContain('href="/icon-192.png"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('rel="manifest"');
    expect(html).toMatch(
      /property="og:title" content="Soty — Local media tools and team workspace"/
    );
    expect(html).toMatch(/name="theme-color" content="#3d217f"/);
    // The production origin is injected at build time from shared config.
    expect(html).toContain('%SITE_ORIGIN%');
    expect(html).not.toMatch(OLD_BRAND);

    const manifest = JSON.parse(readFileSync('apps/web/public/manifest.webmanifest', 'utf8'));
    expect(manifest.name).toBe('Soty');
    expect(manifest.theme_color).toBe('#3d217f');
  });

  it(
    'keeps every compatibility and social image on the approved Soty assets',
    { timeout: 15_000 },
    () => {
      expect(readFileSync('apps/web/public/soty-app-icon.png')).toEqual(
        readFileSync('apps/web/public/icon-512.png')
      );
      expect(readFileSync('apps/web/public/og-image.png')).toEqual(
        readFileSync('apps/web/public/soty-logo.png')
      );
      expect(readFileSync('packaging/DmgBackground.swift', 'utf8')).not.toContain(
        'favicon.svg W path'
      );
    }
  );

  it('keeps the public OAuth home page crawlable', () => {
    const headers = readFileSync('apps/web/public/_headers', 'utf8');
    expect(headers).toMatch(/\/[\s\S]*X-Robots-Tag: index, follow/);
  });

  it('keeps the packaged agent branded as Soty without touching its bundle id', () => {
    const plist = readFileSync('packaging/Info.plist', 'utf8');
    expect(plist).toContain('<string>Soty</string>');
    expect(plist).toContain('<string>local.video.compressor.test</string>');
    expect(plist).not.toContain('Local Video Compressor');

    const launcher = readFileSync('packaging/Launcher.swift', 'utf8');
    expect(launcher).toContain('__APP_NAME__');
    expect(readFileSync('scripts/package-mac.sh', 'utf8')).toContain('APP_NAME=Soty');
    // The health handshake identifier is a compatibility constant, not a brand.
    expect(launcher).toContain('local-video-compressor-agent');
    expect(launcher).not.toMatch(/"[^"]*Local Video Compressor[^"]*"/);
  });
});

describe('Soty design system', () => {
  const css = readFileSync('apps/web/src/styles.css', 'utf8');

  it('builds the palette and motion system on shared tokens', () => {
    for (const token of [
      '--purple-500: #7c59e0',
      '--color-accent: var(--purple-600)',
      '--gradient-progress',
      '--ease-standard: cubic-bezier(0.2, 0, 0, 1)',
      '--dur-control',
      '--dur-section'
    ]) {
      expect(css).toContain(token);
    }
    // The previous blue accent must be gone.
    expect(css).not.toMatch(/#3559c7|#2949ad|#edf2ff/i);
  });

  it('keeps semantic colors non-purple', () => {
    expect(css).toContain('--color-success: #18794e');
    expect(css).toContain('--color-warning: #9a6700');
    expect(css).toContain('--color-error: #b42318');
  });

  it('disables decorative loops under prefers-reduced-motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.progress-track.is-flowing > span');
    expect(reduced).toContain('.skeleton');
    expect(reduced).toContain('animation: none !important');
  });

  it('keeps every full-page header on shared geometry tokens', () => {
    for (const token of [
      '--app-header-height: 62px',
      '--app-header-padding-inline: 16px',
      '--app-header-logo-height: 55.2px',
      '--app-header-control-icon-size: 23px'
    ]) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.app-shell\s*{[\s\S]*?--topbar-h: var\(--app-header-height\)/);
    expect(css).toMatch(
      /\.login-topbar,\s*\.legal-topbar\s*{[\s\S]*?min-height: var\(--app-header-height\);[\s\S]*?padding: 0 var\(--app-header-padding-inline\)/
    );
    expect(css).toMatch(
      /\.login-topbar\.public-topbar\s*{[\s\S]*?padding-inline: var\(--app-header-padding-inline\)/
    );
  });

  it('reserves tabular numbers for timers, progress and metrics', () => {
    for (const selector of ['.job-timer', '.job-progress-meta', '.batch-counts']) {
      const block = css.slice(css.indexOf(selector));
      expect(block.slice(0, block.indexOf('}'))).toContain('font-variant-numeric: tabular-nums');
    }
  });
});
