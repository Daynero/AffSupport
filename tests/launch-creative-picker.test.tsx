// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { analytics } from '../apps/web/src/analytics/service';
const track = vi.spyOn(analytics, 'track').mockImplementation(() => undefined);
const fileEvents = () =>
  track.mock.calls.filter(([name]) =>
    ['team_file_attempt_started', 'team_file_attempt_completed', 'error_occurred'].includes(name)
  ) as [string, Record<string, unknown>][];
vi.mock('../apps/web/src/team/preview/MaterialPreview', () => ({
  MaterialPreview: ({ material, onClose }: { material: { id: string }; onClose: () => void }) => (
    <div role="dialog" aria-label="Creative viewer">
      {material.id}
      <button onClick={onClose}>Close preview</button>
    </div>
  )
}));
import { LaunchCreativePicker } from '../apps/web/src/team/launches/LaunchCreativePicker';
const seams = vi.hoisted(() => ({ folder: vi.fn(), upload: vi.fn(), openWorkspace: vi.fn() }));
vi.mock('../apps/web/src/team/explorer/useThumbnailSession', () => ({
  useThumbnailSession: () => null
}));
vi.mock('../apps/web/src/api/team', () => ({ teamApi: { ensureTaskDropFolder: seams.folder } }));
vi.mock('../apps/web/src/team/catalog/material-actions-client', () => ({
  uploadTeamFile: seams.upload
}));
vi.mock('../apps/web/src/team/tasks/TaskAttachmentPicker', () => ({
  TaskAttachmentPicker: ({ trigger }: { trigger: (open: () => void) => React.ReactNode }) =>
    trigger(seams.openWorkspace)
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('keeps a missing creative neutral until submit, then explains the required field', () => {
  const props = {
    teamId: 'team',
    config: { creativeAlias: 'video_5' },
    onChange: vi.fn(),
    disabled: false
  };
  const view = render(<LaunchCreativePicker {...props} />);
  const field = screen
    .getByRole('button', { name: 'Choose a creative or drop it here' })
    .closest('.ui-field');
  expect(field?.classList.contains('bg-warning-soft')).toBe(false);
  expect(screen.queryByText('Required')).toBeNull();
  view.rerender(<LaunchCreativePicker {...props} submitted />);
  expect(screen.getByText('Required')).toBeTruthy();
  expect(field?.classList.contains('bg-warning-soft')).toBe(false);
  view.rerender(
    <LaunchCreativePicker
      {...props}
      config={{ ...props.config, materialId: 'selected-material' }}
      submitted
    />
  );
  expect(field?.classList.contains('bg-warning-soft')).toBe(false);
  expect(screen.queryByText('Required')).toBeNull();
  expect(seams.folder).not.toHaveBeenCalled();
  expect(seams.upload).not.toHaveBeenCalled();
});
it('rejects a multi-file drop before creating a destination or uploading any file', () => {
  const change = vi.fn();
  render(
    <LaunchCreativePicker
      teamId="team"
      config={{ creativeAlias: 'video_5' }}
      onChange={change}
      disabled={false}
    />
  );
  fireEvent.drop(screen.getByRole('button', { name: 'Choose a creative or drop it here' }), {
    dataTransfer: {
      files: [
        new File(['a'], 'a.mp4', { type: 'video/mp4' }),
        new File(['b'], 'b.mp4', { type: 'video/mp4' })
      ]
    }
  });
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(change).not.toHaveBeenCalled();
  expect(seams.folder).not.toHaveBeenCalled();
  expect(seams.upload).not.toHaveBeenCalled();
});

it('reports a destination failure as upload failure rather than rejecting a valid video', async () => {
  seams.folder.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
  const change = vi.fn();
  render(
    <LaunchCreativePicker
      teamId="team"
      config={{ creativeAlias: 'video_5' }}
      onChange={change}
      disabled={false}
    />
  );
  fireEvent.drop(screen.getByRole('button', { name: 'Choose a creative or drop it here' }), {
    dataTransfer: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] }
  });
  expect((await screen.findByRole('alert')).textContent).toBe(
    'You do not have permission for this.'
  );
  expect(change).not.toHaveBeenCalled();
  expect(seams.upload).not.toHaveBeenCalled();
  const [[, started], [, completed]] = fileEvents();
  expect(completed).toMatchObject({
    attempt_id: started.attempt_id,
    stage: 'finding',
    outcome: 'blocked',
    production_completed: false
  });
});

it('opens the selected preview from its thumbnail and closes stale previews', () => {
  const props = {
    teamId: 'team',
    config: { materialId: 'saved-creative', creativeAlias: 'saved_alias' },
    onChange: vi.fn(),
    disabled: false
  };
  const view = render(<LaunchCreativePicker {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview creative' }));
  expect(screen.getByRole('dialog', { name: 'Creative viewer' }).textContent).toContain(
    'saved-creative'
  );
  view.rerender(
    <LaunchCreativePicker {...props} config={{ ...props.config, materialId: 'different' }} />
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Upload creative' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy();
  view.rerender(<LaunchCreativePicker {...props} config={{ creativeAlias: 'name' }} />);
  expect(screen.queryByRole('button', { name: 'Preview creative' })).toBeNull();
});

it('offers exactly the computer and workspace sources from the same field', async () => {
  render(<LaunchCreativePicker teamId="team" config={{}} disabled={false} onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose a creative or drop it here' }));
  expect(await screen.findByRole('menuitem', { name: 'From computer' })).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem', { name: 'From workspace' }));
  expect(seams.openWorkspace).toHaveBeenCalledOnce();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
const drop = () =>
  fireEvent.drop(screen.getByRole('button', { name: 'Choose a creative or drop it here' }), {
    dataTransfer: { files: [new File(['video'], 'video.mp4', { type: 'video/mp4' })] }
  });

it.each(['team', 'disabled', 'material', 'method', 'unmount'])(
  'revokes a pending destination when the form changes: %s',
  async reason => {
    const folder = deferred<{ folderId: string }>();
    seams.folder.mockReturnValueOnce(folder.promise);
    const change = vi.fn(),
      busy = vi.fn();
    const props = {
      teamId: 'team',
      config: { method: 'catalog' as const },
      disabled: false,
      onChange: change,
      onBusyChange: busy
    };
    const view = render(<LaunchCreativePicker {...props} />);
    drop();
    expect(busy).toHaveBeenCalledWith(true);
    if (reason === 'unmount') view.unmount();
    else
      view.rerender(
        <LaunchCreativePicker
          {...props}
          teamId={reason === 'team' ? 'other' : 'team'}
          disabled={reason === 'disabled'}
          config={
            reason === 'material'
              ? { materialId: 'new' }
              : reason === 'method'
                ? { method: 'other' }
                : props.config
          }
        />
      );
    await act(async () => folder.resolve({ folderId: 'folder' }));
    expect(seams.upload).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
    expect(busy.mock.calls).toEqual([[true], [false]]);
    expect(fileEvents()).toHaveLength(2);
    expect(fileEvents()[1][1]).toMatchObject({ outcome: 'skipped', production_completed: false });
  }
);

it('keeps the old selection when replacement fails and ignores a stale successful upload', async () => {
  seams.folder.mockResolvedValueOnce({ folderId: 'folder' });
  const upload = deferred<{ materialId: string; state: string }>();
  seams.upload.mockReturnValueOnce(upload.promise);
  const change = vi.fn();
  const props = {
    teamId: 'team',
    config: { materialId: 'old', creativeAlias: 'old' },
    onChange: change,
    disabled: false
  };
  const view = render(<LaunchCreativePicker {...props} />);
  fireEvent.drop(screen.getByRole('button', { name: 'Replace' }), {
    dataTransfer: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] }
  });
  await waitFor(() => expect(seams.upload).toHaveBeenCalledOnce());
  expect(screen.getByRole('textbox', { name: 'Creative name' })).toHaveProperty('value', 'old');
  view.rerender(<LaunchCreativePicker {...props} disabled />);
  await act(async () => upload.resolve({ materialId: 'late', state: 'succeeded' }));
  expect(change).not.toHaveBeenCalled();
});

it('accepts one video once, rejects duplicate drops while busy, and applies its name after success', async () => {
  const folder = deferred<{ folderId: string; materialId: string }>();
  seams.folder.mockReturnValueOnce(folder.promise);
  seams.upload.mockResolvedValueOnce({ materialId: 'new', state: 'succeeded' });
  const change = vi.fn(),
    busy = vi.fn();
  render(
    <LaunchCreativePicker
      teamId="team"
      config={{}}
      disabled={false}
      onChange={change}
      onBusyChange={busy}
    />
  );
  drop();
  fireEvent.drop(screen.getByRole('button', { name: 'Uploading…' }), {
    dataTransfer: { files: [new File(['a'], 'again.mp4', { type: 'video/mp4' })] }
  });
  await act(async () => folder.resolve({ folderId: 'drive-folder', materialId: 'catalog-folder' }));
  expect(seams.folder).toHaveBeenCalledOnce();
  expect(seams.upload).toHaveBeenCalledOnce();
  expect(seams.upload).toHaveBeenCalledWith(
    expect.objectContaining({ destinationFolderId: 'catalog-folder' })
  );
  expect(change).toHaveBeenCalledWith({ materialId: 'new', creativeAlias: 'video' });
  expect(busy.mock.calls).toEqual([[true], [false]]);
  expect(fileEvents()).toHaveLength(2);
  expect(fileEvents()[1][1]).toMatchObject({
    outcome: 'success',
    stage: 'finalizing',
    production_completed: true
  });
  expect(JSON.stringify(fileEvents())).not.toMatch(/video\.mp4|catalog-folder|drive-folder/);
});

it('diagnoses a destination outage through the real file lifecycle and read-only inspect query', async () => {
  const { createAnalyticsDb } = await import('./support/analytics-pglite');
  const { getInspect } = await import('../scripts/analytics/queries');
  const db = await createAnalyticsDb();
  try {
    seams.folder.mockRejectedValueOnce(
      Object.assign(new Error('DRIVE_UNAVAILABLE'), { retryable: true })
    );
    render(
      <LaunchCreativePicker teamId="private-team" config={{}} disabled={false} onChange={vi.fn()} />
    );
    drop();
    await screen.findByRole('alert');
    const events = fileEvents();
    expect(events.map(([name]) => name)).toEqual([
      'team_file_attempt_started',
      'error_occurred',
      'team_file_attempt_completed'
    ]);
    const attemptId = events[0][1].attempt_id as string;
    expect(events[1][1]).toMatchObject({
      attempt_id: attemptId,
      error_fingerprint: 'team:transfer:DRIVE_UNAVAILABLE',
      retryable: true
    });
    expect(events[2][1]).toMatchObject({
      attempt_id: attemptId,
      stage: 'finding',
      outcome: 'failure',
      production_completed: false
    });
    expect(JSON.stringify(events)).not.toMatch(/private-team|video\.mp4/);
    for (const [index, [name, properties]] of events.entries()) {
      await db.db.query(
        `insert into public.analytics_events(user_id,event_name,attempt_id,properties,occurred_at,created_at)
        values($1,$2,$3,$4,$5,$5)`,
        [
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          name,
          attemptId,
          JSON.stringify(properties),
          new Date(Date.UTC(2026, 10, 14, 10, 0, index)).toISOString()
        ]
      );
    }
    const result = await getInspect(attemptId, '2026-11-14T11:00:00Z');
    expect(result.found).toBe(true);
    if (!result.found) throw new Error('missing upload diagnosis');
    expect(result.capability).toBe('team.file_ops');
    expect(result.terminal?.outcome).toBe('failure');
    expect(result.events.some(event => event.properties.error_code === 'DRIVE_UNAVAILABLE')).toBe(
      true
    );
    expect(result.events.some(event => event.properties.stage === 'finding')).toBe(true);
  } finally {
    await db.close();
  }
}, 30_000);
