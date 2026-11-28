import { describe, expect, it, vi } from 'vitest';
import { sampleCatalogVideoDuration } from '../supabase/functions/drive-ops/catalog-video-duration';
import {
  catalogVariantOutputName,
  parseCatalogVariantRunCommand,
  runCatalogVariant,
  SPACE_RESTITCHED_FOLDER_NAME
} from '../supabase/functions/space-storage/catalog-variants';
import {
  parseProcessStartCommand,
  type ProcessDeps
} from '../supabase/functions/space-storage/process';

/**
 * 057 T093: `/catalog-variants/run` hands one variation of an R2 catalog to the member's
 * agent. The server opens its run in «Restitched» under the variation's own key, binds it to the
 * variation, and answers two fresh tickets with the set's settings and a duration drawn from the
 * variation's identity. A variation already made, ended or canceled is answered as such.
 */

const ACTOR = '05794000-0000-4000-8000-000000000002';
const TEAM = '05794000-0000-4000-8000-000000000011';
const ROOT = '05794000-0000-4000-8000-000000000101';
const FOLDER = '05794000-0000-4000-8000-000000000102';
const SOURCE = '05794000-0000-4000-8000-0000000000a1';
const SET = '05794000-0000-4000-8000-0000000000b1';
const REQUEST = '05794000-0000-4000-8000-0000000000b2';
const OPERATION = '05794000-0000-4000-8000-0000000000c1';
const OUTPUT = '05794000-0000-4000-8000-0000000000e1';
const DIGEST = 'd'.repeat(64);
const settings = {
  operation: 'restitch',
  startImageIds: [],
  endImageIds: [],
  sourceMode: 'drive',
  builtin: { version: 1, start: true, end: true },
  fitMode: 'cover',
  finalDurationMode: 'random-40-50',
  customFinalDurationSeconds: 2700,
  startEnabled: true,
  endEnabled: true,
  startDurationMode: 'one-frame',
  customStartDurationMs: 100,
  configured: true,
  updatedAt: '',
  updatedBy: null
};

const command = { teamId: TEAM, setId: SET, index: 2, toolContractVersion: 2 };

function world(claim: Record<string, unknown>, options: { bind?: unknown; reused?: boolean } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push([name, args]);
    switch (name) {
      case 'service_space_catalog_variant_run':
        return { index: 2, ...claim };
      case 'service_mutate_space_materials':
        return {
          kind: 'ok',
          materials: [{ id: FOLDER, name: SPACE_RESTITCHED_FOLDER_NAME, kind: 'folder' }],
          created: false
        };
      case 'service_space_storage_context':
        return {
          member: true,
          storageBackend: 'r2',
          storagePilot: true,
          actorPilot: true,
          workspaceAllowed: true,
          archived: false,
          allowed: true,
          accessEpoch: '7',
          contentRevision: '0',
          rootMaterialId: ROOT
        };
      case 'service_space_process_source':
        return {
          materialId: SOURCE,
          name: 'Clip.mp4',
          category: 'video',
          mimeType: 'video/mp4',
          sizeBytes: '400',
          contentId: 'a'.repeat(64),
          destinationFolderId: FOLDER,
          childNames: ['Clip restitched 3.mp4']
        };
      case 'service_start_team_operation':
        return [{ operation_id: OPERATION, state: 'pending', reused: options.reused === true }];
      case 'service_set_team_operation_intent':
      case 'service_transition_team_operation':
      case 'issue_team_transfer_grant':
        return null;
      case 'service_bind_space_catalog_variant_run':
        if (options.bind instanceof Error) throw options.bind;
        return { bound: true, operationId: OPERATION };
      default:
        throw new Error(`unexpected rpc ${name}`);
    }
  });
  let ticket = 0;
  const deps: ProcessDeps = {
    actorId: ACTOR,
    rpc,
    bucket: null,
    readGrant: null,
    journal: vi.fn(async () => true),
    operationId: 'journal',
    client: { kind: 'web', version: 'test' },
    ticket: () => `ticket-${++ticket}-${'x'.repeat(40)}`
  };
  return { deps, rpc, calls };
}

const open = {
  state: 'open',
  requestId: REQUEST,
  attempt: 1,
  operationId: null,
  destinationFolderId: null,
  sourceMaterialId: SOURCE,
  sourceName: 'Clip.mp4',
  variantCount: 3,
  settings,
  settingsDigest: DIGEST
};

describe('handing a catalog variation of an R2 space to the agent', () => {
  it('opens its run in Restitched under its own key, binds it, and answers fresh tickets', async () => {
    const f = world(open);
    const answer = await runCatalogVariant(command, f.deps);
    expect(f.calls.map(([name]) => name)).toEqual([
      'service_space_catalog_variant_run',
      'service_mutate_space_materials',
      'service_space_storage_context',
      'service_space_process_source',
      'service_start_team_operation',
      'service_set_team_operation_intent',
      'service_transition_team_operation',
      'service_bind_space_catalog_variant_run',
      'issue_team_transfer_grant',
      'issue_team_transfer_grant'
    ]);
    expect(f.calls[1]![1]).toEqual({
      p_actor: ACTOR,
      p_team: TEAM,
      p_input: { action: 'create_folder', name: 'Restitched', ensure: true }
    });
    expect(f.calls[4]![1]).toMatchObject({
      p_idempotency_key: `space-variant:${REQUEST}:1`,
      p_source_material: SOURCE,
      p_destination_folder: FOLDER,
      // «Clip restitched 3.mp4» is taken: keep both.
      p_reserved_name_key: 'clip restitched 3 (2).mp4'
    });
    expect(f.calls[5]![1]).toMatchObject({ p_tool: 'restitch', p_tool_contract_version: 2 });
    expect(f.calls[7]![1]).toEqual({
      p_team: TEAM,
      p_actor: ACTOR,
      p_set: SET,
      p_index: 2,
      p_attempt: 1,
      p_operation: OPERATION
    });
    const expected = await sampleCatalogVideoDuration(settings as never, {
      setId: SET,
      requestId: REQUEST,
      settingsDigest: DIGEST
    });
    expect(answer).toMatchObject({
      state: 'run',
      index: 2,
      operationId: OPERATION,
      agentContractVersion: 3,
      sourceGrant: { purpose: 'process_input' },
      finalizeGrant: { purpose: 'finalize' },
      defaults: {
        finalDurationMode: 'custom',
        customFinalDurationSeconds: expected.customFinalDurationSeconds
      }
    });
    const seconds = (answer as { defaults: { customFinalDurationSeconds: number } }).defaults
      .customFinalDurationSeconds;
    expect(seconds).toBeGreaterThanOrEqual(2400);
    expect(seconds).toBeLessThanOrEqual(3000);
  });

  it('hands a run already open over again with fresh tickets and the same duration', async () => {
    const f = world({
      ...open,
      state: 'running',
      operationId: OPERATION,
      destinationFolderId: FOLDER
    });
    const first = await runCatalogVariant(command, f.deps);
    expect(f.calls.map(([name]) => name)).toEqual([
      'service_space_catalog_variant_run',
      'issue_team_transfer_grant',
      'issue_team_transfer_grant'
    ]);
    const second = await runCatalogVariant(
      command,
      world({ ...open, state: 'running', operationId: OPERATION, destinationFolderId: FOLDER }).deps
    );
    expect((first as { defaults: unknown }).defaults).toEqual(
      (second as { defaults: unknown }).defaults
    );
  });

  it('answers a variation made, ended, canceled or held by the background agent without opening anything', async () => {
    for (const claim of [
      { state: 'registered', outputMaterialId: OUTPUT },
      { state: 'failed' },
      { state: 'canceled' },
      // T106: the member's delegated agent holds it; the page waits.
      { state: 'background' }
    ]) {
      const f = world(claim);
      const answer = await runCatalogVariant(command, f.deps);
      expect(answer.state).toBe(claim.state);
      expect(f.calls).toHaveLength(1);
    }
  });

  it('closes its own new run when another page bound one first', async () => {
    const f = world(open, { bind: Object.assign(new Error('x'), { message: 'WRONG_STATE' }) });
    await expect(runCatalogVariant(command, f.deps)).rejects.toMatchObject({ code: 'WRONG_STATE' });
    const closed = f.calls.filter(([name]) => name === 'service_transition_team_operation');
    expect(closed.at(-1)![1]).toMatchObject({ p_operation: OPERATION, p_state: 'canceled' });
    expect(f.calls.map(([name]) => name)).not.toContain('issue_team_transfer_grant');
  });

  it('refuses settings that cannot make a file and a malformed request', async () => {
    const f = world({ ...open, settings: { ...settings, configured: false } });
    await expect(runCatalogVariant(command, f.deps)).rejects.toMatchObject({
      code: 'RESTITCH_INVALID'
    });
    for (const body of [
      { ...command, index: -1 },
      { ...command, setId: 'x' },
      { ...command, toolContractVersion: 0 }
    ])
      expect(() => parseCatalogVariantRunCommand(body)).toThrow();
    expect(parseCatalogVariantRunCommand(command)).toEqual(command);
  });

  it('keeps the catalog-variant keys away from a member’s own runs', () => {
    expect(() =>
      parseProcessStartCommand({
        teamId: TEAM,
        materialId: SOURCE,
        idempotencyKey: `space-variant:${REQUEST}:1`,
        toolId: 'restitch',
        outputName: 'x.mp4',
        conflictMode: 'keep_both',
        agentContractVersion: 3,
        toolContractVersion: 2
      })
    ).toThrow();
  });

  it('names each output after its source and its place', () => {
    expect(catalogVariantOutputName('Clip.mp4', 0)).toBe('Clip restitched 1.mp4');
    expect(catalogVariantOutputName('Clip', 9)).toBe('Clip restitched 10.mp4');
  });
});
