// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { BulkTrashGroup, TeamMaterialRow } from '@video-compressor/shared';
import { useBulkTrash, type BulkTrashClient } from '../apps/web/src/team/explorer/useBulkTrash';
const team = '37000000-0000-4000-8000-000000000001';
const actor = '37000000-0000-4000-8000-000000000002';
const rows = Array.from(
  { length: 50 },
  (_, i) =>
    ({
      id: `37000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`,
      name: `File ${i}`,
      category: null
    }) as TeamMaterialRow
);
afterEach(cleanup);
it('renders 50 authoritative results, continues after failure, and recovers the same group from another session', async () => {
  let hosted: BulkTrashGroup[] = [];
  const writes = new Map<string, number>();
  let retry = false;
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn(async () => structuredClone(hosted)),
    startBulkTrash: vi.fn(async (_team: string, id: string, ids: string[]) => {
      const group: BulkTrashGroup = {
        id,
        teamId: team,
        actorId: actor,
        items: ids.map(materialId => ({
          materialId,
          idempotencyKey: `${id}:${materialId}`,
          state: 'queued',
          errorCode: null
        }))
      };
      hosted = [group];
      return structuredClone(group);
    }),
    prepareBulkTrashItem: vi.fn(async () => structuredClone(hosted[0]!)),
    markBulkTrashRequest: vi.fn(async (_team, _group, id) => {
      const item = hosted[0]!.items.find(item => item.materialId === id)!;
      if (item.state === 'queued') item.state = 'unknown';
    })
  };
  const tail = {
    trashMaterial: vi.fn(async ({ materialId }: { materialId: string }) => {
      writes.set(materialId, (writes.get(materialId) ?? 0) + 1);
      const item = hosted[0]!.items.find(item => item.materialId === materialId)!;
      if (materialId === rows[4]!.id && !retry) {
        item.state = 'failed';
        item.errorCode = 'DRIVE_UNAVAILABLE';
        throw new Error('failure');
      }
      item.state = 'confirmed';
      item.errorCode = null;
    })
  };
  function View() {
    const state = useBulkTrash(team, 0, client);
    return (
      <>
        <button onClick={() => void state.start(rows, tail)}>Start</button>
        <button onClick={() => void state.retry(state.groups[0]!, rows, tail)}>Retry</button>
        {state.groups.flatMap(group =>
          group.items.map(item => (
            <p key={item.materialId}>
              {item.materialId}:{item.state}
            </p>
          ))
        )}
      </>
    );
  }
  const first = render(<View />);
  fireEvent.click(screen.getByText('Start'));
  await waitFor(() => expect(screen.getAllByText(/:confirmed$/u)).toHaveLength(49));
  expect(screen.getAllByText(/:failed$/u)).toHaveLength(1);
  const invalidatedAt = performance.now();
  first.unmount();
  render(<View />);
  await waitFor(() => expect(screen.getAllByText(/:confirmed$/u)).toHaveLength(49));
  expect(performance.now() - invalidatedAt).toBeLessThan(1000);
  retry = true;
  fireEvent.click(screen.getByText('Retry'));
  await waitFor(() => expect(screen.getAllByText(/:confirmed$/u)).toHaveLength(50));
  expect(writes.get(rows[4]!.id)).toBe(2);
  expect([...writes].filter(([id]) => id !== rows[4]!.id).every(([, count]) => count === 1)).toBe(
    true
  );
});
it('does not publish a delayed old-space receipt after switching spaces', async () => {
  let finish: (groups: BulkTrashGroup[]) => void = () => {};
  const client: BulkTrashClient = {
    listBulkTrash: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve;
          })
      )
      .mockResolvedValue([]),
    startBulkTrash: vi.fn(),
    prepareBulkTrashItem: vi.fn(),
    markBulkTrashRequest: vi.fn()
  };
  function View({ id }: { id: string }) {
    const state = useBulkTrash(id, 0, client);
    return <span>{state.groups.length}</span>;
  }
  const view = render(<View id={team} />);
  view.rerender(<View id="other" />);
  await act(async () => finish([{ id: 'old', teamId: team, actorId: actor, items: [] }]));
  expect(screen.getByText('0')).toBeTruthy();
});
