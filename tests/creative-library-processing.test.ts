import { describe, expect, it, vi } from 'vitest';
import {
  parseLibraryRequirementIdentity,
  parseLibraryVideoTextVariants,
  transcriptSidecarName,
  translationSidecarName,
  type LibraryJobFinalizeRequest
} from '@video-compressor/shared';
import { assertCurrentSourceVersion } from '../supabase/functions/_shared/library.js';
import { executeLibraryOpsCommand } from '../supabase/functions/library-ops/handler.js';

const TEAM_ID = '41000000-0000-4000-8000-000000000001';
const SOURCE_ID = '41000000-0000-4000-8000-000000000002';
const ATTEMPT_ID = '41000000-0000-4000-8000-000000000003';
const AGENT_ID = '41000000-0000-4000-8000-000000000004';
const RESULT_ID = '41000000-0000-4000-8000-000000000005';

describe('Creative Library processing identities and current results', () => {
  it('creates deterministic version-bound transcript and translation sidecar names', () => {
    expect(transcriptSidecarName('Launch: video.mp4', 'version-1/alpha')).toBe(
      'Launch_ video.transcript.version1alph.txt'
    );
    expect(translationSidecarName('Launch: video.mp4', 'version-1/alpha', 'uk')).toBe(
      'Launch_ video.transcript.version1alph.uk.txt'
    );
    expect(transcriptSidecarName('Launch: video.mp4', 'version-1/alpha')).toBe(
      transcriptSidecarName('Launch: video.mp4', 'version-1/alpha')
    );
  });

  it('keeps original and translated requirement variants distinct and closed', () => {
    expect(
      parseLibraryRequirementIdentity({
        teamId: TEAM_ID,
        sourceMaterialId: SOURCE_ID,
        sourceVersion: 'v1',
        kind: 'transcription',
        variant: 'original'
      })
    ).not.toBeNull();
    expect(
      parseLibraryRequirementIdentity({
        teamId: TEAM_ID,
        sourceMaterialId: SOURCE_ID,
        sourceVersion: 'v1',
        kind: 'translation',
        variant: 'original'
      })
    ).toBeNull();
    expect(
      parseLibraryRequirementIdentity({
        teamId: TEAM_ID,
        sourceMaterialId: SOURCE_ID,
        sourceVersion: 'v1',
        kind: 'translation',
        variant: 'uk'
      })
    ).not.toBeNull();
  });

  it('accepts only unique current text variants with a full closed payload', () => {
    const original = {
      materialId: RESULT_ID,
      kind: 'original',
      language: 'en',
      ingestState: 'full',
      truncated: false,
      text: 'Cached words',
      updatedAt: '2026-08-14T10:00:00.000Z'
    } as const;
    expect(
      parseLibraryVideoTextVariants({ sourceVersion: 'v1', variants: [original], canProcess: true })
    ).toMatchObject({ sourceVersion: 'v1', variants: [original] });
    expect(
      parseLibraryVideoTextVariants({
        sourceVersion: 'v1',
        variants: [original, { ...original, materialId: SOURCE_ID }],
        canProcess: true
      })
    ).toBeNull();
  });

  it('rejects a result after the live source version changes', () => {
    expect(() => assertCurrentSourceVersion({ version: 'v2', checksum: null }, 'v1')).toThrowError(
      expect.objectContaining({ code: 'SOURCE_CHANGED' })
    );
    expect(() => assertCurrentSourceVersion({ version: null, checksum: 'v1' }, 'v1')).not.toThrow();
  });

  it('finalizes through the service-only first-result acceptance primitive', async () => {
    const request: LibraryJobFinalizeRequest = {
      teamId: TEAM_ID,
      attemptId: ATTEMPT_ID,
      agentInstanceId: AGENT_ID,
      leaseToken: 'lease-token-with-enough-entropy-123',
      resultMaterialId: RESULT_ID,
      sourceVersion: 'v1',
      idempotencyKey: 'library.result.attempt-1'
    };
    const serviceRpc = vi.fn().mockResolvedValue({
      state: 'accepted',
      resultId: SOURCE_ID,
      materialId: RESULT_ID
    });
    await executeLibraryOpsCommand(
      { action: 'job_finalize', request },
      { actorId: 'actor-1', callerRpc: vi.fn(), serviceRpc }
    );
    expect(serviceRpc).toHaveBeenCalledWith('service_accept_library_result', {
      p_team: TEAM_ID,
      p_attempt: ATTEMPT_ID,
      p_actor: 'actor-1',
      p_agent_instance: AGENT_ID,
      p_lease_token: request.leaseToken,
      p_result_material: RESULT_ID,
      p_source_version: 'v1'
    });
  });
});
