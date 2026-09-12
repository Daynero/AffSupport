// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { StableReleaseManifest } from '../packages/shared/src/release';
import { installedReleaseStatus } from '../apps/web/src/release-manifest';
import { AgentContextOverride } from '../apps/web/src/AgentContext';
import ReleaseUpdateNotice from '../apps/web/src/components/ReleaseUpdateNotice';
import { agentContextStub } from './support/agent-stub';

/**
 * The version gate.
 *
 * Soty ships its web interface inside the app as well as to the site, so a
 * browser that cannot reach the local agent over https — Safari, which refuses
 * mixed content to loopback — runs whatever interface the installed app was
 * built with. That interface then stayed broken for as long as the app did,
 * against fixes that had been live on the site for days.
 *
 * A version the signed manifest no longer supports must therefore be stopped at
 * the door rather than warned about: the warning was dismissible, and the
 * person dismissing it had no idea what they were choosing.
 */

function manifest(minimumSupportedVersion: string): StableReleaseManifest {
  return {
    schemaVersion: 1,
    channel: 'stable',
    version: '1.1.0',
    buildNumber: '63',
    buildId: '1.1.0+63',
    apiVersion: 5,
    minimumSupportedVersion,
    publishedAt: '2026-09-06T12:00:00.000Z',
    summary: { en: 'Fixes', uk: 'Виправлення' },
    artifacts: {
      'macos-arm64': { url: 'https://example.test/Soty-v1.1.0.dmg', sha256: 'a'.repeat(64) }
    },
    toolRequirements: {
      compressor: { compressor: 2 },
      landingOptimizer: {},
      landingPreview: {},
      transcription: {},
      teamWorkspace: {},
      stitcher: {}
    }
  };
}

const status = (installedVersion: string, minimum: string) =>
  installedReleaseStatus({
    manifest: manifest(minimum),
    installedVersion,
    installedChannel: 'stable',
    compatible: true
  });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('language', 'uk');
});

afterEach(cleanup);

describe('an installation the manifest no longer supports', () => {
  it('is required to update, while a merely older one is only offered it', () => {
    // 1.0.3 is the version whose agent dropped its connection dozens of times a
    // week; 1.1.0 is the fix. Raising the minimum is what makes that a block.
    expect(status('1.0.3', '1.1.0')).toBe('update_required');
    expect(status('1.0.4', '1.1.0')).toBe('update_required');
    expect(status('1.0.3', '0.4.0')).toBe('update_available');
    expect(status('1.1.0', '1.1.0')).toBe('latest');
  });

  it('never blocks a development or beta build on the production channel', () => {
    expect(
      installedReleaseStatus({
        manifest: manifest('1.1.0'),
        installedVersion: '1.0.3',
        installedChannel: 'beta',
        compatible: true
      })
    ).toBe('development');
  });

  it('is no longer something a dismissible banner can wave away', () => {
    render(
      <AgentContextOverride
        value={agentContextStub({
          agentVersion: '1.0.3',
          agentChannel: 'stable',
          toolContracts: { compressor: 2 },
          releaseManifest: { status: 'ready', manifest: manifest('1.1.0') },
          releaseBlocked: true
        })}
      >
        <ReleaseUpdateNotice />
      </AgentContextOverride>
    );

    // The notice stays out of the way: this version is stopped at the tool gate,
    // and a "Later" button there would be an offer to keep using a broken build.
    expect(screen.queryByRole('button', { name: 'Пізніше' })).toBeNull();
  });

  it('still offers the ordinary update notice when the version is merely behind', () => {
    render(
      <AgentContextOverride
        value={agentContextStub({
          agentVersion: '1.0.3',
          agentChannel: 'stable',
          toolContracts: { compressor: 2 },
          releaseManifest: { status: 'ready', manifest: manifest('0.4.0') },
          releaseBlocked: false
        })}
      >
        <ReleaseUpdateNotice />
      </AgentContextOverride>
    );

    expect(screen.getByRole('button', { name: 'Пізніше' })).toBeTruthy();
  });
});
