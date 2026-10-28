import { describe, expect, it, vi } from 'vitest';
import {
  runCatalogTextScheduleTick,
  runCatalogTextScheduleTickSafely
} from '../supabase/functions/catalog-updater/text-schedule';
import { generateApparelTexts } from '../apps/web/src/team/product-catalog/apparelTexts';
const item = { teamId: 'team', runId: 'run', leaseToken: 'lease', count: 200 };
const random = () => {
  let seed = 17;
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
};
function rpcFor(inputs: unknown = { mode: 'legacy', names: [] }) {
  return vi.fn(async (name: string) => {
    if (name === 'service_claim_catalog_text_schedule') return [item];
    if (name === 'service_catalog_text_schedule_inputs') return inputs;
    return true;
  });
}
describe('weekly catalog text worker', () => {
  it('reuses the manual generator and commits the complete replacement without a browser or Drive', async () => {
    const rpc = rpcFor();
    expect(await runCatalogTextScheduleTick(rpc, random())).toEqual({
      claimed: 1,
      committed: 1,
      failed: 0,
      unsettled: 0
    });
    expect(rpc).toHaveBeenCalledWith('service_commit_catalog_text_schedule', {
      p_team: 'team',
      p_run: 'run',
      p_lease: 'lease',
      p_items: generateApparelTexts(200, random())
    });
  });
  it('uses admitted image pairs without inventing cross-pairs', async () => {
    const rpc = rpcFor({ mode: 'v2', pairs: [{ garment: 'Hoodie', color: 'black' }] });
    await runCatalogTextScheduleTick(rpc, random());
    const commit = rpc.mock.calls.find(
      ([name]) => name === 'service_commit_catalog_text_schedule'
    ) as unknown as [string, { p_items: Array<{ title: string; description: string }> }];
    expect(commit[1].p_items).toHaveLength(200);
    expect(
      commit[1].p_items.every(
        text => /hoodie/i.test(text.description) && /black/i.test(text.description)
      )
    ).toBe(true);
  });
  it('retains the old pool if generation is short or inputs cannot be read', async () => {
    const short = rpcFor();
    await runCatalogTextScheduleTick(short, () => 0.1);
    expect(short.mock.calls.some(([name]) => name === 'service_commit_catalog_text_schedule')).toBe(
      false
    );
    expect(short).toHaveBeenCalledWith(
      'service_fail_catalog_text_schedule',
      expect.objectContaining({ p_code: 'VALIDATION' })
    );
    const unreadable = rpcFor({ mode: 'v2', pairs: null });
    await runCatalogTextScheduleTick(unreadable);
    expect(unreadable).toHaveBeenCalledWith(
      'service_fail_catalog_text_schedule',
      expect.objectContaining({ p_code: 'READ_FAILED' })
    );
  });
  it('never replays an uncertain commit and lets its lease-fenced receipt determine recovery', async () => {
    const rpc = rpcFor();
    rpc.mockImplementation(async name => {
      if (name === 'service_claim_catalog_text_schedule') return [item];
      if (name === 'service_catalog_text_schedule_inputs') return { mode: 'legacy', names: [] };
      if (name === 'service_commit_catalog_text_schedule') throw new Error('lost reply');
      return false;
    });
    expect(await runCatalogTextScheduleTick(rpc, random())).toEqual({
      claimed: 1,
      committed: 0,
      failed: 1,
      unsettled: 1
    });
    expect(
      rpc.mock.calls.filter(([name]) => name === 'service_commit_catalog_text_schedule')
    ).toHaveLength(1);
  });
  it('settles a stale lease as conflict without a second generation', async () => {
    const rpc = rpcFor();
    rpc.mockImplementation(async name =>
      name === 'service_claim_catalog_text_schedule'
        ? [item]
        : name === 'service_catalog_text_schedule_inputs'
          ? { mode: 'legacy', names: [] }
          : name === 'service_commit_catalog_text_schedule'
            ? false
            : true
    );
    await runCatalogTextScheduleTick(rpc, random());
    expect(rpc).toHaveBeenCalledWith(
      'service_fail_catalog_text_schedule',
      expect.objectContaining({ p_code: 'CONFLICT' })
    );
  });
});

it('isolates a failed claim transport so unrelated worker lanes still execute', async () => {
  const rpc = vi.fn(async () => {
    throw new Error('private transport payload');
  });
  const nextLane = vi.fn();
  const run = async () => {
    const result = await runCatalogTextScheduleTickSafely(rpc);
    nextLane();
    return result;
  };
  expect(await run()).toEqual({ unavailable: true });
  expect(nextLane).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledTimes(1);
});
