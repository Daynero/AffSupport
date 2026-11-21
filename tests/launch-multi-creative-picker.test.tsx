// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LaunchCreative, LaunchDraft } from '../packages/shared/src/team/launches';
vi.mock('../apps/web/src/team/preview/MaterialPreview', () => ({ MaterialPreview: () => null }));
const seams = vi.hoisted(() => ({
  folder: vi.fn(),
  upload: vi.fn(),
  picked: vi.fn(),
  dialog: { title: '', confirm: (_count: number): string => '' }
}));
vi.mock('../apps/web/src/team/explorer/useThumbnailSession', () => ({
  useThumbnailSession: () => null
}));
vi.mock('../apps/web/src/api/team', () => ({ teamApi: { ensureTaskDropFolder: seams.folder } }));
vi.mock('../apps/web/src/team/catalog/material-actions-client', () => ({
  uploadTeamFile: seams.upload
}));
vi.mock('../apps/web/src/team/tasks/TaskAttachmentPicker', () => ({
  TaskAttachmentPicker: ({
    trigger,
    onAdd,
    title,
    confirmLabel
  }: {
    trigger: (open: () => void) => React.ReactNode;
    onAdd: (items: Array<{ id: string; name: string; category: string }>) => void;
    title: string;
    confirmLabel: (count: number) => string;
  }) => {
    seams.picked.mockImplementation(onAdd);
    seams.dialog = { title, confirm: confirmLabel };
    return trigger(() => undefined);
  }
}));
import { LaunchCreativePicker } from '../apps/web/src/team/launches/LaunchCreativePicker';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const catalog = (productCount = 100) => ({
  productCount,
  restitchEnabled: false,
  finalDurationMode: 'random-30-40' as const,
  customFinalDurationSeconds: null
});
const creative = (n: number, copies: number): LaunchCreative => ({
  materialId: `m${n}`,
  alias: `clip_${n}`,
  copies,
  pinned: null
});
const videos = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => new File(['x'], `clip ${i + 1}.mp4`, { type: 'video/mp4' })
  );
const dropOn = (files: File[]) =>
  fireEvent.drop(screen.getByRole('button', { name: /Choose a creative|Add/ }), {
    dataTransfer: { files }
  });

function picker(config: LaunchDraft, onChange = vi.fn()) {
  render(
    <LaunchCreativePicker teamId="team" config={config} disabled={false} onChange={onChange} />
  );
  return onChange;
}

it('uploads several videos from one drop and shares the products evenly', async () => {
  seams.folder.mockResolvedValue({ materialId: 'folder' });
  let n = 0;
  seams.upload.mockImplementation(async () => ({ materialId: `m${++n}`, state: 'succeeded' }));
  const change = picker({ method: 'catalog', catalog: catalog() });
  await act(async () => dropOn(videos(4)));
  expect(seams.upload).toHaveBeenCalledTimes(4);
  const patch = change.mock.calls.at(-1)![0] as LaunchDraft;
  expect(patch.creativeKind).toBe('video');
  expect(patch.materialId).toBe('m1');
  expect(patch.creativeAlias).toBe('clip_1');
  expect(patch.creatives?.map(c => c.copies)).toEqual([25, 25, 25, 25]);
});

it('raises the product count to the number of creatives', () => {
  const change = picker({ method: 'catalog', catalog: catalog(2) });
  act(() =>
    seams.picked([1, 2, 3].map(i => ({ id: `m${i}`, name: `pic${i}.png`, category: 'image' })))
  );
  const patch = change.mock.calls.at(-1)![0] as LaunchDraft;
  expect(patch.catalog?.productCount).toBe(3);
  expect(patch.creativeKind).toBe('image');
});

it('refuses a mixed drop without uploading anything', () => {
  const change = picker({ method: 'catalog', catalog: catalog() });
  dropOn([
    new File(['a'], 'a.mp4', { type: 'video/mp4' }),
    new File(['b'], 'b.png', { type: 'image/png' })
  ]);
  expect(seams.folder).not.toHaveBeenCalled();
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toMatch(/either videos or images/);
});

it('refuses an image when videos are chosen, from the workspace too', () => {
  const change = picker({
    method: 'catalog',
    catalog: catalog(),
    materialId: 'm1',
    creativeAlias: 'clip_1',
    creativeKind: 'video',
    creatives: [creative(1, 100)]
  });
  act(() => seams.picked([{ id: 'p1', name: 'a.png', category: 'image' }]));
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toMatch(/either videos or images/);
});

it('says when a file is already chosen', () => {
  const change = picker({
    method: 'catalog',
    catalog: catalog(),
    materialId: 'm1',
    creativeAlias: 'clip_1',
    creativeKind: 'video',
    creatives: [creative(1, 100)]
  });
  act(() => seams.picked([{ id: 'm1', name: 'clip 1.mp4', category: 'video' }]));
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toMatch(/already selected/);
});

it('removes a creative and gives its products back', () => {
  const change = picker({
    method: 'catalog',
    catalog: catalog(),
    materialId: 'm1',
    creativeAlias: 'clip_1',
    creativeKind: 'video',
    creatives: [creative(1, 50), creative(2, 50)]
  });
  fireEvent.click(screen.getByRole('button', { name: 'Remove clip_2' }));
  const patch = change.mock.calls.at(-1)![0] as LaunchDraft;
  expect(patch.creatives?.map(c => [c.materialId, c.copies])).toEqual([['m1', 100]]);
});

it('shows the share of each creative in its own row and lets a typed share hold', () => {
  const change = picker({
    method: 'catalog',
    catalog: catalog(),
    materialId: 'm1',
    creativeAlias: 'clip_1',
    creativeKind: 'video',
    creatives: [1, 2, 3, 4].map(i => creative(i, 25))
  });
  // Names are not typed here: no text field per creative.
  expect(screen.queryByRole('textbox')).toBeNull();
  expect((screen.getByRole('button', { name: 'Even' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Copies for clip_1' }), {
    target: { value: '40' }
  });
  const patch = change.mock.calls.at(-1)![0] as LaunchDraft;
  expect(patch.creatives?.map(c => c.copies)).toEqual([40, 20, 20, 20]);
  expect(patch.creatives?.[0]?.pinned).toBe(1);
});

it('gives one creative every product without a slider', () => {
  picker({
    method: 'catalog',
    catalog: catalog(),
    materialId: 'm1',
    creativeAlias: 'clip_1',
    creativeKind: 'video',
    creatives: [creative(1, 100)]
  });
  expect(screen.queryByRole('slider')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Even' })).toBeNull();
});

/** Found on next 2026-11-21: three ticked files, and the dialog still said «Choose creative». */
it('names the picked count in a catalog launch, and stays singular for one creative', () => {
  picker({ method: 'catalog', catalog: catalog() } as LaunchDraft);
  expect(seams.dialog.title).toBe('Choose creatives');
  expect(seams.dialog.confirm(0)).toBe('Choose creative');
  expect(seams.dialog.confirm(1)).toBe('Choose 1 creative');
  expect(seams.dialog.confirm(3)).toBe('Choose 3 creatives');
  cleanup();
  picker({ method: 'other' } as LaunchDraft);
  expect(seams.dialog.title).toBe('Choose creative');
  expect(seams.dialog.confirm(1)).toBe('Choose creative');
});

it('heads the list «Creatives» once there is more than one', () => {
  picker({
    method: 'catalog',
    catalog: catalog(),
    creativeKind: 'video',
    creatives: [creative(1, 50), creative(2, 50)]
  } as LaunchDraft);
  expect(screen.getByText('Creatives')).toBeTruthy();
});
