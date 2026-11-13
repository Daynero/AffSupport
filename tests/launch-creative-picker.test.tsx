// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
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
  seams.folder.mockRejectedValueOnce(new Error('DRIVE_NOT_CONNECTED'));
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
  expect((await screen.findByRole('alert')).textContent).toBe('The file could not be uploaded.');
  expect(change).not.toHaveBeenCalled();
  expect(seams.upload).not.toHaveBeenCalled();
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
  const folder = deferred<{ folderId: string }>();
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
  await act(async () => folder.resolve({ folderId: 'folder' }));
  expect(seams.folder).toHaveBeenCalledOnce();
  expect(seams.upload).toHaveBeenCalledOnce();
  expect(change).toHaveBeenCalledWith({ materialId: 'new', creativeAlias: 'video' });
  expect(busy.mock.calls).toEqual([[true], [false]]);
});
