// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskAttachmentPicker } from '../apps/web/src/team/tasks/TaskAttachmentPicker';

// next QA 2026-11-21: a video and a picture could both be ticked for one Launch, and only
// the confirm refused the whole choice. Once one kind is ticked, the other is unavailable.

afterEach(cleanup);

const material = (id: string, name: string, category: string) => ({
  id,
  name,
  teamId: 'team',
  kind: 'file',
  category,
  parentFolderId: null
});

it('shows a file unavailable, with the reason, once it cannot join what is ticked', async () => {
  const client = {
    listMaterials: vi.fn(async () => [
      material('11111111-1111-4111-8111-000000000001', 'clip.mp4', 'video'),
      material('11111111-1111-4111-8111-000000000002', 'still.png', 'image')
    ])
  };
  render(
    <TaskAttachmentPicker
      teamId="team"
      client={client as never}
      attachedMaterialIds={new Set()}
      onAdd={vi.fn()}
      trigger={open => (
        <button type="button" onClick={open}>
          Open picker
        </button>
      )}
      unavailableWith={(file, chosen) =>
        chosen.length > 0 && chosen[0]!.category !== file.category ? 'Video or images' : null
      }
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open picker' }));
  const video = await screen.findByRole('button', { name: /clip\.mp4/u });
  const image = screen.getByRole('button', { name: /still\.png/u });
  expect((image as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(video);
  await waitFor(() => expect((image as HTMLButtonElement).disabled).toBe(true));
  expect(image.textContent).toContain('Video or images');
  // Unticking the video makes the picture available again.
  fireEvent.click(video);
  await waitFor(() => expect((image as HTMLButtonElement).disabled).toBe(false));
});
