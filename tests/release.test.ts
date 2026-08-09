import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AGENT_API_VERSION,
  AGENT_TOOL_CONTRACTS,
  BUILD_ID,
  BUILD_NUMBER,
  BUNDLE_VERSION,
  MAX_SUPPORTED_AGENT_API_VERSION,
  MIN_SUPPORTED_AGENT_API_VERSION,
  PRODUCT_VERSION,
  PRODUCTION_SITE_ORIGIN,
  RELEASE_ARTIFACT_NAME,
  RELEASE_DOWNLOAD_URL,
  RELEASE_DOWNLOAD_URL_WINDOWS,
  RELEASE_TAG,
  WEB_TOOL_REQUIREMENTS,
  compareProductVersions,
  toolContractCompatible
} from '../packages/shared/src/release';
import {
  downloadUrlForPlatform,
  installedReleaseStatus,
  localizedReleaseSummary,
  macAppleSiliconDownloadUrl
} from '../apps/web/src/release-manifest';

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

  it('selects the Apple Silicon artifact without browser platform detection', () => {
    const manifest = JSON.parse(
      readFileSync('apps/web/public/.well-known/wishly/stable.json', 'utf8')
    );
    expect(macAppleSiliconDownloadUrl(manifest)).toBe(manifest.artifacts['macos-arm64'].url);
    expect(macAppleSiliconDownloadUrl(null)).toBe(RELEASE_DOWNLOAD_URL);
  });

  it('resolves per-platform downloads from the manifest with safe fallbacks', () => {
    const manifest = JSON.parse(
      readFileSync('apps/web/public/.well-known/wishly/stable.json', 'utf8')
    );

    // Artifact present in the manifest wins.
    expect(downloadUrlForPlatform(manifest, 'macos-arm64')).toEqual({
      url: manifest.artifacts['macos-arm64'].url,
      available: true
    });
    const withWindows = {
      ...manifest,
      artifacts: {
        ...manifest.artifacts,
        'windows-x64': { url: 'https://example.com/Wishly-Agent-Windows-x64.exe', sha256: null }
      }
    };
    expect(downloadUrlForPlatform(withWindows, 'windows-x64')).toEqual({
      url: 'https://example.com/Wishly-Agent-Windows-x64.exe',
      available: true
    });

    // The mac fallback stays downloadable; the Windows fallback is only a
    // predicted URL, so the UI must keep its coming-soon treatment.
    expect(downloadUrlForPlatform(null, 'macos-arm64')).toEqual({
      url: RELEASE_DOWNLOAD_URL,
      available: true
    });
    const withoutWindows = {
      ...manifest,
      artifacts: { 'macos-arm64': manifest.artifacts['macos-arm64'] }
    };
    expect(downloadUrlForPlatform(withoutWindows, 'windows-x64')).toEqual({
      url: RELEASE_DOWNLOAD_URL_WINDOWS,
      available: false
    });
    expect(downloadUrlForPlatform(null, 'windows-x64')).toEqual({
      url: RELEASE_DOWNLOAD_URL_WINDOWS,
      available: false
    });
  });

  it('uses localized release copy and falls back to maintenance copy when it is absent', () => {
    const manifest = JSON.parse(
      readFileSync('apps/web/public/.well-known/wishly/stable.json', 'utf8')
    );
    expect(localizedReleaseSummary(manifest, 'en')).toBe(manifest.summary.en);
    expect(localizedReleaseSummary(manifest, 'uk')).toBe(manifest.summary.uk);
    expect(localizedReleaseSummary({ ...manifest, summary: undefined }, 'uk')).toBeNull();
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
    const [major, minor, patch] = PRODUCT_VERSION.split('-')[0].split('.').map(Number);
    const newerVersion = `${major}.${minor}.${patch + 1}`;

    expect(compareProductVersions('0.5.2', '0.5.1')).toBe(1);
    expect(compareProductVersions('0.5.1', '0.5.2')).toBe(-1);
    expect(compareProductVersions('development', '0.5.2')).toBeNull();
    expect(
      installedReleaseStatus({
        manifest: JSON.parse(
          readFileSync('apps/web/public/.well-known/wishly/stable.json', 'utf8')
        ),
        installedVersion: newerVersion,
        installedChannel: 'stable',
        compatible: true
      })
    ).toBe('newer');
  });

  it('gates each tool by its own contract', () => {
    expect(toolContractCompatible('compressor', { compressor: 1 })).toBe(false);
    expect(toolContractCompatible('compressor', { compressor: 2, imageEmbedding: 1 })).toBe(false);
    expect(toolContractCompatible('compressor', { compressor: 3, imageEmbedding: 2 })).toBe(true);
    expect(toolContractCompatible('landingOptimizer', { compressor: 1 })).toBe(false);
    expect(toolContractCompatible('landingOptimizer', { landingOptimizer: 1 })).toBe(false);
    expect(toolContractCompatible('landingOptimizer', { landingOptimizer: 2 })).toBe(true);
    expect(toolContractCompatible('landingPreview', { landingOptimizer: 2 })).toBe(false);
    expect(toolContractCompatible('landingPreview', { landingPreview: 1 })).toBe(false);
    expect(toolContractCompatible('landingPreview', { landingPreview: 2 })).toBe(true);
    expect(toolContractCompatible('transcription', { transcription: 1 })).toBe(false);
    expect(toolContractCompatible('transcription', { transcription: 2 })).toBe(false);
    expect(toolContractCompatible('transcription', { transcription: 3 })).toBe(false);
    expect(toolContractCompatible('transcription', { transcription: 4 })).toBe(false);
    expect(toolContractCompatible('transcription', { transcription: 5 })).toBe(true);
    expect(toolContractCompatible('teamWorkspace', {})).toBe(false);
    expect(toolContractCompatible('teamWorkspace', { teamWorkspace: 1 })).toBe(true);
    expect(toolContractCompatible('teamWorkspace', { teamWorkspace: 2 })).toBe(true);
  });

  it('keeps legacy agents compatible with existing tools while isolating team routes', () => {
    const legacyContracts = { ...AGENT_TOOL_CONTRACTS } as Record<string, number>;
    delete legacyContracts.teamWorkspace;

    expect(toolContractCompatible('teamWorkspace', legacyContracts)).toBe(false);
    for (const tool of [
      'compressor',
      'landingOptimizer',
      'landingPreview',
      'transcription'
    ] as const) {
      expect(toolContractCompatible(tool, legacyContracts), tool).toBe(true);
    }
    expect(WEB_TOOL_REQUIREMENTS.teamWorkspace).toEqual({ teamWorkspace: 1 });
    expect(AGENT_TOOL_CONTRACTS.teamWorkspace).toBe(2);

    const client = readFileSync('apps/web/src/api/client.ts', 'utf8');
    for (const route of ['/api/team/landings/render', '/api/landing-preview/team-space']) {
      expect(client).toContain(route);
    }
    expect(client.match(/AGENT_TOOL_CONTRACTS\.teamWorkspace/gu)?.length).toBeGreaterThanOrEqual(2);
  });

  it('pins production team OAuth and web origin to the shared release identity', () => {
    const production = readFileSync('config/production.env', 'utf8');
    expect(production.match(/^PUBLIC_SITE_ORIGIN=(.+)$/m)?.[1]?.trim()).toBe(
      PRODUCTION_SITE_ORIGIN
    );
    expect(production.match(/^DRIVE_OAUTH_MODE=(.+)$/m)?.[1]?.trim()).toBe('verified');

    const webGate = readFileSync('scripts/verify-web-env.mjs', 'utf8');
    const releaseGate = readFileSync('scripts/verify-release.mjs', 'utf8');
    const providerGate = readFileSync('scripts/verify-team-production.mjs', 'utf8');
    const rootPackage = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const realAgentGate = readFileSync('scripts/real-agent-check.mjs', 'utf8');
    for (const gate of [webGate, releaseGate]) {
      expect(gate).toContain('PRODUCTION_SITE_ORIGIN');
      expect(gate).toContain('DRIVE_OAUTH_MODE');
      expect(gate).toContain('verified');
    }
    expect(providerGate).toContain('drive-connect/readiness');
    expect(providerGate).toContain('missingTeamProductionSecrets');
    for (const script of ['deploy:web', 'release:check', 'package:mac', 'package:dmg']) {
      expect(rootPackage.scripts[script]).toContain('verify:team-production');
    }
    expect(rootPackage.scripts['deploy:web:member-pilot']).toContain('verify:team-member-pilot');
    expect(rootPackage.scripts['deploy:web:member-pilot']).toContain('--member-pilot');
    expect(realAgentGate).toContain('AGENT_UPDATE_REQUIRED');
    expect(realAgentGate).toContain('legacyContracts');
    expect(realAgentGate).toContain('/api/team/landings/render');
    expect(realAgentGate).toContain('/api/landing-preview/team-space');
  });

  it('keeps installable dev builds isolated from production identities and services', () => {
    const packageScript = readFileSync('scripts/package-dev-mac.sh', 'utf8');
    const devDmgScript = readFileSync('scripts/package-dev-dmg.sh', 'utf8');
    const productionPackageScript = readFileSync('scripts/package-mac.sh', 'utf8');
    const stageRuntimeScript = readFileSync('scripts/stage-agent-runtime.mjs', 'utf8');
    const stagingLibrary = readFileSync('scripts/lib/agent-staging.mjs', 'utf8');
    const stageWindowsScript = readFileSync('scripts/stage-windows-runtime.mjs', 'utf8');
    const productionVerifyScript = readFileSync('scripts/verify-package.sh', 'utf8');
    const developmentVerifyScript = readFileSync('scripts/verify-dev-package.sh', 'utf8');
    const launcher = readFileSync('packaging/Launcher.swift', 'utf8');
    expect(packageScript).toContain('VITE_ANALYTICS_ENABLED=false');
    expect(packageScript).toContain('VITE_LOCAL_DEV_AUTH=true');
    expect(packageScript).toContain('AGENT_PORT=$port');
    expect(packageScript).toContain('SUPPORT_DIRECTORY_NAME=Soty Dev');
    expect(packageScript).toContain('INSTANCE_LOCK_NAME=wishly-dev-agent.lock');
    expect(packageScript).not.toMatch(/git (tag|push)|supabase|wrangler/);
    for (const script of [packageScript, productionPackageScript]) {
      expect(script).toContain('scripts/stage-agent-runtime.mjs');
      expect(script).toContain('/usr/bin/strip -x');
      expect(script).not.toContain('cp -R apps/agent/dist apps/agent/package.json node_modules');
      expect(script).not.toContain('LLAMA_RUNTIME_ARCHIVE');
    }
    // Both packaging pipelines (mac CLI wrapper and Windows staging) must go
    // through the shared lockfile-exact dependency staging.
    expect(stageRuntimeScript).toContain('./lib/agent-staging.mjs');
    expect(stageWindowsScript).toContain('./lib/agent-staging.mjs');
    expect(stagingLibrary).toContain('does not match package-lock.json');
    expect(stagingLibrary).toContain('chromium-headless-shell');
    expect(stagingLibrary).toContain('browser-runtime.json');
    for (const script of [productionVerifyScript, developmentVerifyScript]) {
      expect(script).toContain('scripts/verify-staged-dependencies.mjs');
    }
    expect(devDmgScript).toContain('zlib-level=9');
    expect(launcher).toContain('__AGENT_PORT__');
    expect(launcher).toContain('__SUPPORT_DIRECTORY_NAME__');
    expect(launcher).toContain('installedLocationAllowed()');
    expect(launcher).toContain('finished.terminationStatus == 75');
    expect(readFileSync('scripts/verify-dmg.sh', 'utf8')).toContain(
      'WISHLY_ALLOW_UNINSTALLED_AGENT=1'
    );
  });
});
