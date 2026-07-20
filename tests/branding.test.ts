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

describe('Wishly brand identity', () => {
  it('names the product Wishly and the agent Wishly Agent', () => {
    expect(PRODUCT_NAME).toBe('Wishly');
    expect(AGENT_PRODUCT_NAME).toBe('Wishly Agent');
    expect(translate('en', 'appName')).toBe('Wishly');
    expect(translate('uk', 'appName')).toBe('Wishly');
  });

  it('uses Wishly Agent in connection and install strings in both languages', () => {
    expect(translate('en', 'agentConnected')).toBe('Wishly Agent connected');
    expect(translate('uk', 'agentConnected')).toBe('Wishly Agent підключено');
    expect(translate('uk', 'agentNotRunning')).toBe('Wishly Agent не запущено');
    expect(translate('uk', 'agentUpdateRequired')).toBe('Потрібне оновлення Wishly Agent');
    expect(translate('uk', 'downloadAgent')).toBe('Встановити Wishly');
    expect(translate('en', 'downloadAgent')).toBe('Install Wishly');
  });

  it('leaves no old brand names in either dictionary', () => {
    const text = translationKeys
      .flatMap(key => [translate('en', key), translate('uk', key)])
      .join(' ');
    expect(text).not.toMatch(OLD_BRAND);
  });

  it('publishes release artifacts under the Wishly name', () => {
    expect(RELEASE_ARTIFACT_NAME).toMatch(/^Wishly-Agent-v.+-macOS-arm64\.dmg$/);
    expect(RELEASE_DOWNLOAD_URL).toContain(RELEASE_ARTIFACT_NAME);
  });

  it('serves the hosted page from a wishly origin configured in one place', () => {
    expect(new URL(PRODUCTION_SITE_ORIGIN).hostname).toContain('wishly');
    const env = readFileSync('config/production.env', 'utf8');
    expect(env.match(/^PUBLIC_SITE_ORIGIN=(.+)$/m)?.[1]?.trim()).toBe(PRODUCTION_SITE_ORIGIN);
  });

  it('brands the web document metadata', () => {
    const html = readFileSync('apps/web/index.html', 'utf8');
    expect(html).toContain('<title>Wishly — Tools</title>');
    expect(html).toContain('href="/favicon.svg"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('rel="manifest"');
    expect(html).toMatch(/property="og:title" content="Wishly — Tools"/);
    expect(html).toMatch(/name="theme-color" content="#7557e8"/);
    // The production origin is injected at build time from shared config.
    expect(html).toContain('%SITE_ORIGIN%');
    expect(html).not.toMatch(OLD_BRAND);

    const manifest = JSON.parse(readFileSync('apps/web/public/manifest.webmanifest', 'utf8'));
    expect(manifest.name).toBe('Wishly');
    expect(manifest.theme_color).toBe('#7557e8');
  });

  it('keeps the packaged agent branded as Wishly Agent without touching its bundle id', () => {
    const plist = readFileSync('packaging/Info.plist', 'utf8');
    expect(plist).toContain('<string>Wishly Agent</string>');
    expect(plist).toContain('<string>local.video.compressor.test</string>');
    expect(plist).not.toContain('Local Video Compressor');

    const launcher = readFileSync('packaging/Launcher.swift', 'utf8');
    expect(launcher).toContain('__APP_NAME__');
    expect(readFileSync('scripts/package-mac.sh', 'utf8')).toContain('APP_NAME=Wishly Agent');
    // The health handshake identifier is a compatibility constant, not a brand.
    expect(launcher).toContain('local-video-compressor-agent');
    expect(launcher).not.toMatch(/"[^"]*Local Video Compressor[^"]*"/);
  });
});

describe('Wishly design system', () => {
  const css = readFileSync('apps/web/src/styles.css', 'utf8');

  it('builds the palette and motion system on shared tokens', () => {
    for (const token of [
      '--purple-500: #7557e8',
      '--color-accent: var(--purple-500)',
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

  it('reserves tabular numbers for timers, progress and metrics', () => {
    for (const selector of ['.job-timer', '.job-progress-meta', '.batch-counts']) {
      const block = css.slice(css.indexOf(selector));
      expect(block.slice(0, block.indexOf('}'))).toContain('font-variant-numeric: tabular-nums');
    }
  });
});
