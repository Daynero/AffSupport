import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AGENT_API_VERSION,
  BUILD_ID,
  BUILD_NUMBER,
  BUNDLE_VERSION,
  MAX_SUPPORTED_AGENT_API_VERSION,
  MIN_SUPPORTED_AGENT_API_VERSION,
  PRODUCT_VERSION,
  RELEASE_ARTIFACT_NAME,
  RELEASE_DOWNLOAD_URL,
  RELEASE_TAG,
  compareProductVersions,
  toolContractCompatible
} from '../packages/shared/src/release';
import { installedReleaseStatus } from '../apps/web/src/release-manifest';

describe('release identity', () => {
  it('uses valid, monotonically sortable release identifiers', () => {
    expect(PRODUCT_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(BUNDLE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(BUNDLE_VERSION).toBe(PRODUCT_VERSION.split('-')[0]);
    expect(BUILD_NUMBER).toMatch(/^[1-9]\d*(?:\.\d+){0,2}$/);
    expect(BUILD_ID).toBe(`${PRODUCT_VERSION}+${BUILD_NUMBER}`);
  });

  it('keeps the current API inside the web compatibility range', () => {
    expect(MIN_SUPPORTED_AGENT_API_VERSION).toBeLessThanOrEqual(AGENT_API_VERSION);
    expect(MAX_SUPPORTED_AGENT_API_VERSION).toBeGreaterThanOrEqual(AGENT_API_VERSION);
  });

  it('derives an immutable versioned release URL', () => {
    expect(RELEASE_TAG).toBe(`v${PRODUCT_VERSION}`);
    expect(RELEASE_ARTIFACT_NAME).toContain(`v${PRODUCT_VERSION}`);
    expect(RELEASE_DOWNLOAD_URL).toContain(`/${RELEASE_TAG}/${RELEASE_ARTIFACT_NAME}`);
  });

  it('keeps every workspace package on the product version', () => {
    for (const file of [
      'package.json',
      'apps/agent/package.json',
      'apps/web/package.json',
      'packages/shared/package.json'
    ]) {
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
        version: string;
        dependencies?: Record<string, string>;
      };
      expect(manifest.version, file).toBe(PRODUCT_VERSION);
      if (manifest.dependencies?.['@video-compressor/shared']) {
        expect(manifest.dependencies['@video-compressor/shared'], file).toBe(PRODUCT_VERSION);
      }
    }
  });

  it('compares semantic versions without treating a newer build as an update target', () => {
    expect(compareProductVersions('0.5.2', '0.5.1')).toBe(1);
    expect(compareProductVersions('0.5.1', '0.5.2')).toBe(-1);
    expect(compareProductVersions('development', '0.5.2')).toBeNull();
    expect(
      installedReleaseStatus({
        manifest: JSON.parse(
          readFileSync('apps/web/public/.well-known/wishly/stable.json', 'utf8')
        ),
        installedVersion: '0.5.5',
        installedChannel: 'stable',
        compatible: true
      })
    ).toBe('newer');
  });

  it('gates each tool by its own contract', () => {
    expect(toolContractCompatible('compressor', { compressor: 1 })).toBe(true);
    expect(toolContractCompatible('landingOptimizer', { compressor: 1 })).toBe(false);
  });

  it('keeps installable dev builds isolated from production identities and services', () => {
    const packageScript = readFileSync('scripts/package-dev-mac.sh', 'utf8');
    const launcher = readFileSync('packaging/Launcher.swift', 'utf8');
    expect(packageScript).toContain('VITE_ANALYTICS_ENABLED=false');
    expect(packageScript).toContain('VITE_LOCAL_DEV_AUTH=true');
    expect(packageScript).toContain('AGENT_PORT=$port');
    expect(packageScript).toContain('SUPPORT_DIRECTORY_NAME=Wishly Dev');
    expect(packageScript).toContain('INSTANCE_LOCK_NAME=wishly-dev-agent.lock');
    expect(packageScript).not.toMatch(/git (tag|push)|supabase|wrangler/);
    expect(launcher).toContain('__AGENT_PORT__');
    expect(launcher).toContain('__SUPPORT_DIRECTORY_NAME__');
  });
});
