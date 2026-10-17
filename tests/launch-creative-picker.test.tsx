// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
const seams = vi.hoisted(() => ({ folder: vi.fn(), upload: vi.fn() }));
vi.mock('../apps/web/src/api/team', () => ({ teamApi: { ensureTaskDropFolder: seams.folder } }));
vi.mock('../apps/web/src/team/catalog/material-actions-client', () => ({
  uploadTeamFile: seams.upload
}));
vi.mock('../apps/web/src/team/tasks/TaskAttachmentPicker', () => ({
  TaskAttachmentPicker: ({ trigger }: { trigger: (open: () => void) => React.ReactNode }) =>
    trigger(vi.fn())
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
  const field = screen.getByRole('button', { name: 'Choose creative' }).closest('.ui-field');
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
  fireEvent.drop(screen.getByRole('button', { name: 'Choose creative' }), {
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

it('opens the persisted selected material between the alias and chooser, and closes stale previews', () => {
  const props = {
    teamId: 'team',
    config: { materialId: 'saved-creative', creativeAlias: 'saved_alias' },
    onChange: vi.fn(),
    disabled: false
  };
  const view = render(<LaunchCreativePicker {...props} />);
  const eye = screen.getByRole('button', { name: 'Preview creative' });
  const controls = eye.parentElement!;
  expect(Array.from(controls.children).indexOf(eye)).toBeGreaterThan(
    Array.from(controls.children).indexOf(screen.getByRole('textbox', { name: 'Creative name' }))
  );
  fireEvent.click(eye);
  expect(screen.getByRole('dialog', { name: 'Creative viewer' }).textContent).toContain(
    'saved-creative'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(eye);
  view.rerender(
    <LaunchCreativePicker {...props} config={{ ...props.config, materialId: 'different' }} />
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(<LaunchCreativePicker {...props} config={{ creativeAlias: 'name' }} />);
  expect(screen.getByRole('button', { name: 'Preview creative' }).hasAttribute('disabled')).toBe(
    true
  );
});
