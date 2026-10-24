import { afterEach, expect, it } from 'vitest';
import { setQueryExecutor } from '../scripts/analytics/db';
import { getWorkspaceEvidence } from '../scripts/analytics/workspace';

const actor = '36000000-0000-4000-8000-000000000139';
const id = '36000000-0000-4000-8000-000000000141';
const at = '2026-10-22T10:00:00Z';
const base = {
  id,
  action: 'process_output_cleanup',
  state: 'attention',
  code: 'PROCESS_RESULT_UNCERTAIN',
  item_count: 1,
  confirmed_count: 0,
  created_at: at,
  updated_at: at
};
const detail = {
  id,
  upload_state: 'started',
  cleanup_state: 'attention',
  attempts: 24,
  max_attempts: 24,
  captured_handoff_expires_at: at,
  next_attempt_at: null,
  lease_expires_at: null,
  provider_mutation_reserved: false,
  provider_material_registered: false,
  provider_result_recorded: false,
  updated_at: at
};
afterEach(() => setQueryExecutor(null));

function reader(
  options: {
    missing?: boolean;
    detail?: Record<string, unknown>;
    row?: Record<string, unknown>;
    queryFails?: boolean;
  } = {}
) {
  setQueryExecutor(async (sql, parameters) => {
    expect(sql).toMatch(/^\s*select/iu);
    if (sql.includes('information_schema.columns'))
      return [
        { kind: 'table', name: 'analytics_workspace_operations' },
        ...(!options.missing ? [{ kind: 'table', name: 'analytics_process_output_cleanup' }] : [])
      ];
    expect(parameters[0]).toBe(actor);
    expect(sql).toContain('limit 101');
    if (sql.includes('from public.analytics_workspace_operations')) return [options.row ?? base];
    if (sql.includes('from public.analytics_process_output_cleanup')) {
      if (options.queryFails) throw new Error('projection unavailable');
      return [options.detail ?? detail];
    }
    throw new Error('unexpected diagnostic query');
  });
  return getWorkspaceEvidence(actor, null, at);
}

it('reports finite exhausted recovery from the bounded authoritative projection', async () => {
  const evidence = await reader();
  expect(evidence.operations[0]?.cleanup).toMatchObject({
    state: 'attention',
    attempts: 24,
    max_attempts: 24
  });
});
it('keeps missing ownership capture explicit instead of reporting zero failed uploads', async () => {
  const evidence = await reader({ missing: true });
  expect(evidence.operations[0]?.cleanup).toBeUndefined();
  expect(
    evidence.blind_spots.some(value => value.includes('ownership projection is unavailable'))
  ).toBe(true);
});
it('does not combine an old status with a newer cleanup snapshot', async () => {
  const evidence = await reader({ detail: { ...detail, updated_at: '2026-10-22T10:00:01Z' } });
  expect(evidence.operations[0]?.cleanup).toBeUndefined();
  expect(
    evidence.blind_spots.some(value =>
      value.includes('exact stage and retry budget remain unknown')
    )
  ).toBe(true);
});
it('retains the observed status when optional detailed evidence cannot be read', async () => {
  const evidence = await reader({ queryFails: true });
  expect(evidence.operations[0]).toMatchObject({
    id,
    state: 'attention',
    code: 'PROCESS_RESULT_UNCERTAIN'
  });
  expect(evidence.operations[0]?.cleanup).toBeUndefined();
  expect(evidence.blind_spots.some(value => value.includes('detail was unavailable'))).toBe(true);
});
it.each(['code', 'state'] as const)(
  'omits an unsupported process %s without echoing its payload',
  async field => {
    const evidence = await reader({
      row: { ...base, [field]: 'private-user-content@example.invalid' }
    });
    expect(evidence.operations).toEqual([]);
    expect(JSON.stringify(evidence)).not.toContain('private-user-content');
    expect(
      evidence.blind_spots.some(value => value.includes('unsupported workspace receipt'))
    ).toBe(true);
  }
);
it('does not expose malformed timestamp content from a changed projection', async () => {
  const evidence = await reader({
    detail: { ...detail, captured_handoff_expires_at: 'private-user-content@example.invalid' }
  });
  expect(evidence.operations[0]?.cleanup).toBeUndefined();
  expect(JSON.stringify(evidence)).not.toContain('private-user-content');
});

it('explains a durable provider mutation reservation without provider identifiers', async () => {
  const evidence = await reader({ detail: { ...detail, provider_mutation_reserved: true } });
  expect(evidence.operations[0]?.cleanup?.provider_mutation_reserved).toBe(true);
  expect(JSON.stringify(evidence)).not.toMatch(/file_id|nonce|credential_id/);
});
it('keeps missing reservation support explicit rather than assuming adoption is safe', async () => {
  const evidence = await reader({ detail: { ...detail, provider_mutation_reserved: undefined } });
  expect(evidence.operations[0]?.cleanup).toBeUndefined();
  expect(
    evidence.blind_spots.some(value =>
      value.includes('exact stage and retry budget remain unknown')
    )
  ).toBe(true);
});

it('reports a reference guard fact while leaving ingestion versus explicit adoption unknown', async () => {
  const evidence = await reader({
    detail: { ...detail, provider_material_registered: true },
    row: { ...base, code: 'SOURCE_CHANGED' }
  });
  expect(evidence.operations[0]?.cleanup).toMatchObject({
    provider_material_registered: true,
    provider_result_recorded: false
  });
  expect(JSON.stringify(evidence)).not.toMatch(/file_id|nonce|credential_id/);
});

it('does not describe observed references as reconstructed historical registration', async () => {
  const evidence = await reader({ detail: { ...detail, provider_material_registered: true } });
  expect(evidence.blind_spots.some(value => value.includes('not their history at as-of'))).toBe(
    true
  );
});
