import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamLandingRenderJob } from '../packages/shared/src/team/landing-gallery.js';
import { TeamOperationEvents } from '../apps/agent/src/team-bridge/events.js';
import {
  TeamLandingRenderBridge,
  TeamLandingRenderError
} from '../apps/agent/src/team-bridge/landing-gallery.js';
import type { TeamPreviewBridge } from '../apps/agent/src/team-bridge/preview.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

const roots: string[] = [];
const TEAM_ID = '41000000-0000-4000-8000-000000000001';
const MATERIAL_ID = '41000000-0000-4000-8000-000000000002';
const OPERATION_ID = '41000000-0000-4000-8000-000000000003';
const RENDER_ID = '41000000-0000-4000-8000-000000000004';
const FINGERPRINT = 'a'.repeat(64);

afterEach(async () => {
  while (roots.length) await removeTemporaryDirectory(roots.pop()!);
});

function job(): TeamLandingRenderJob {
  const grant = {
    ticket: 'opaque-ticket-with-at-least-thirty-two-characters',
    purpose: 'preview_range' as const,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxRangeBytes: 32 * 1024 * 1024,
    maxUses: 66
  };
  return {
    operationId: OPERATION_ID,
    renderId: RENDER_ID,
    teamId: TEAM_ID,
    materialId: MATERIAL_ID,
    preset: 'default',
    transferUrl: 'https://example.test/functions/v1/drive-transfer/range',
    artifactUploadUrl: 'https://example.test/functions/v1/drive-transfer/landing-artifacts',
    sourceGrant: grant,
    artifactGrant: { ...grant, ticket: `${grant.ticket}-artifact` }
  };
}

describe('team shared landing renderer', () => {
  it('uploads bounded WebP segments, commits the validation fingerprint, and cleans the session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wishly-shared-render-'));
    roots.push(root);
    const segment = path.join(root, 'fallback.webp');
    await writeFile(
      segment,
      Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)])
    );
    const close = vi.fn().mockResolvedValue(true);
    const preview = {
      previewLanding: vi.fn().mockResolvedValue({
        kind: 'landing',
        operationId: OPERATION_ID,
        url: 'http://127.0.0.1:43121/preview',
        sandbox: 'allow-scripts',
        warning: 'external_navigation_blocked',
        screenshotAvailable: true,
        validation: {
          sourceVersion: '7',
          sourceChecksum: 'checksum-7',
          fingerprint: FINGERPRINT,
          landingRoot: ''
        }
      }),
      screenshotPath: (_operationId: string, index: number) => (index === 0 ? segment : null),
      close
    } as unknown as TeamPreviewBridge;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/commit')) {
        expect(JSON.parse(String(init?.body))).toEqual({
          fingerprint: FINGERPRINT,
          segmentCount: 1
        });
        return Response.json({
          ok: true,
          value: {
            renderId: RENDER_ID,
            state: 'ready',
            segmentCount: 1,
            fingerprint: FINGERPRINT
          }
        });
      }
      expect(url).toMatch(/\/landing-artifacts\/.+\/0$/u);
      const headers = new Headers(init?.headers);
      expect(headers.get('x-wishly-transfer-grant')).toContain('artifact');
      expect(headers.get('x-wishly-landing-fingerprint')).toBe(FINGERPRINT);
      return Response.json({ ok: true, value: { uploaded: true, segment: 0 } });
    });
    const events = new TeamOperationEvents();
    const bridge = new TeamLandingRenderBridge({ preview, events, fetchImpl });

    await expect(bridge.render(job())).resolves.toEqual({
      renderId: RENDER_ID,
      state: 'ready',
      segmentCount: 1,
      fingerprint: FINGERPRINT
    });
    expect(close).toHaveBeenCalledWith(OPERATION_ID);
    expect(events.snapshot().operations[0]).toMatchObject({
      state: 'succeeded',
      stage: 'completed',
      progress: 100
    });
  });

  it('records a typed failure without leaking landing content', async () => {
    const preview = {
      previewLanding: vi.fn().mockResolvedValue({
        kind: 'unavailable',
        operationId: OPERATION_ID,
        reason: 'protected'
      }),
      screenshotPath: vi.fn().mockReturnValue(null),
      close: vi.fn().mockResolvedValue(true)
    } as unknown as TeamPreviewBridge;
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ ok: true, value: { failed: true, reason: 'protected' } }));
    const bridge = new TeamLandingRenderBridge({
      preview,
      events: new TeamOperationEvents(),
      fetchImpl
    });

    await expect(bridge.render(job())).rejects.toMatchObject({
      message: 'RENDER_FAILED',
      reason: 'protected'
    } satisfies Partial<TeamLandingRenderError>);
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).toBe('{"reason":"protected"}');
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toMatch(
      /password|landingRoot|sourceChecksum/i
    );
  });

  it('cancels an in-flight artifact upload and always closes the temporary preview', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wishly-shared-render-cancel-'));
    roots.push(root);
    const segment = path.join(root, 'fallback.webp');
    await writeFile(
      segment,
      Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)])
    );
    const close = vi.fn().mockResolvedValue(true);
    const preview = {
      previewLanding: vi.fn().mockResolvedValue({
        kind: 'landing',
        operationId: OPERATION_ID,
        url: 'http://127.0.0.1:43121/preview',
        sandbox: 'allow-scripts',
        warning: null,
        screenshotAvailable: true,
        validation: {
          sourceVersion: '7',
          sourceChecksum: 'checksum-7',
          fingerprint: FINGERPRINT,
          landingRoot: ''
        }
      }),
      screenshotPath: (_operationId: string, index: number) => (index === 0 ? segment : null),
      close
    } as unknown as TeamPreviewBridge;
    let uploadStarted!: () => void;
    const started = new Promise<void>(resolve => {
      uploadStarted = resolve;
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/fail')) {
        return Response.json({ ok: true, value: { failed: true, reason: 'render_error' } });
      }
      uploadStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true }
        );
      });
    });
    const events = new TeamOperationEvents();
    const bridge = new TeamLandingRenderBridge({ preview, events, fetchImpl });
    const rendering = bridge.render(job());
    await started;
    expect(bridge.cancel(OPERATION_ID)).toBe(true);
    await expect(rendering).rejects.toThrow('PREVIEW_CANCELED');
    expect(close).toHaveBeenCalledWith(OPERATION_ID);
    expect(events.snapshot().operations[0]).toMatchObject({
      state: 'canceled',
      stage: 'canceled'
    });
  });

  it('watchdogs a stalled upload into a terminal failure and closes the preview', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wishly-shared-render-timeout-'));
    roots.push(root);
    const segment = path.join(root, 'fallback.webp');
    await writeFile(
      segment,
      Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)])
    );
    const close = vi.fn().mockResolvedValue(true);
    const preview = {
      previewLanding: vi.fn().mockResolvedValue({
        kind: 'landing',
        operationId: OPERATION_ID,
        url: 'http://127.0.0.1:43121/preview',
        sandbox: 'allow-scripts',
        warning: null,
        screenshotAvailable: true,
        validation: {
          sourceVersion: '7',
          sourceChecksum: 'checksum-7',
          fingerprint: FINGERPRINT,
          landingRoot: ''
        }
      }),
      screenshotPath: (_operationId: string, index: number) => (index === 0 ? segment : null),
      close
    } as unknown as TeamPreviewBridge;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/fail')) {
        return Response.json({ ok: true, value: { failed: true, reason: 'render_error' } });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true }
        );
      });
    });
    const events = new TeamOperationEvents();
    const bridge = new TeamLandingRenderBridge({ preview, events, fetchImpl, watchdogMs: 20 });

    await expect(bridge.render(job())).rejects.toThrow('RENDER_TIMEOUT');
    expect(fetchImpl.mock.calls.some(call => String(call[0]).endsWith('/fail'))).toBe(true);
    expect(close).toHaveBeenCalledWith(OPERATION_ID);
    expect(events.snapshot().operations[0]).toMatchObject({
      state: 'failed',
      stage: 'failed',
      errorCode: 'RENDER_TIMEOUT'
    });
  });
});
