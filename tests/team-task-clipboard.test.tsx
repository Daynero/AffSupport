// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { TeamTaskSummary } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { useTaskClipboard } from '../apps/web/src/team/tasks/useTaskClipboard';

const TEAM = '10000000-0000-4000-8000-000000000001';
const IDS = ['10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003'];
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ToastProvider>{children}</ToastProvider>
);
function clipboard() {
  let text = '';
  return {
    getData: () => text,
    setData: (_type: string, next: string) => {
      text = next;
    }
  };
}
it('copies selected tasks through native events and pastes a single batch, ignoring fields and ordinary clipboard text', async () => {
  const client = { copyTasks: vi.fn().mockResolvedValue(['copy-1', 'copy-2']) };
  const onPasted = vi.fn();
  renderHook(
    () =>
      useTaskClipboard({
        teamId: TEAM,
        selected: IDS.map(id => ({ id }) as TeamTaskSummary),
        canEdit: true,
        client,
        onPasted
      }),
    { wrapper }
  );
  const data = clipboard();
  fireEvent.copy(document, { clipboardData: data });
  expect(JSON.parse(data.getData().split(':').slice(1).join(':'))).toEqual({
    teamId: TEAM,
    taskIds: IDS
  });
  fireEvent.paste(document, { clipboardData: data });
  await waitFor(() => expect(onPasted).toHaveBeenCalledWith(['copy-1', 'copy-2']));
  expect(client.copyTasks).toHaveBeenCalledWith({
    teamId: TEAM,
    taskIds: IDS,
    idempotencyKey: expect.any(String)
  });
  const input = document.createElement('textarea');
  document.body.append(input);
  fireEvent.paste(input, { clipboardData: data });
  fireEvent.paste(document, { clipboardData: { getData: () => 'ordinary text' } });
  expect(client.copyTasks).toHaveBeenCalledTimes(1);
  input.remove();
});
it('ignores read-only boards and prevents cross-space pastes', async () => {
  const client = { copyTasks: vi.fn().mockResolvedValue([]) };
  const options = {
    teamId: TEAM,
    selected: IDS.map(id => ({ id }) as TeamTaskSummary),
    client,
    onPasted: vi.fn()
  };
  const view = renderHook(({ canEdit }) => useTaskClipboard({ ...options, canEdit }), {
    initialProps: { canEdit: false },
    wrapper
  });
  const data = clipboard();
  fireEvent.copy(document, { clipboardData: data });
  expect(data.getData()).toBe('');
  view.rerender({ canEdit: true });
  data.setData('text/plain', 'SOTY_TASKS_V1:' + JSON.stringify({ teamId: 'other', taskIds: IDS }));
  await act(async () => fireEvent.paste(document, { clipboardData: data }));
  expect(client.copyTasks).not.toHaveBeenCalled();
});
it('leaves copy and paste alone while the board is hidden behind another section', async () => {
  const client = { copyTasks: vi.fn().mockResolvedValue(['copy-1']) };
  const section = document.createElement('div');
  const inside = document.createElement('input');
  section.append(inside);
  document.body.append(section);
  const anchor = { current: inside };
  renderHook(
    () =>
      useTaskClipboard({
        anchor,
        teamId: TEAM,
        selected: IDS.map(id => ({ id }) as TeamTaskSummary),
        canEdit: true,
        client,
        onPasted: vi.fn()
      }),
    { wrapper }
  );
  section.hidden = true;
  const data = clipboard();
  fireEvent.copy(document, { clipboardData: data });
  expect(data.getData()).toBe('');
  data.setData('text/plain', 'SOTY_TASKS_V1:' + JSON.stringify({ teamId: TEAM, taskIds: IDS }));
  await act(async () => fireEvent.paste(document, { clipboardData: data }));
  expect(client.copyTasks).not.toHaveBeenCalled();
  // Back on screen, the board answers again.
  section.hidden = false;
  fireEvent.copy(document, { clipboardData: data });
  expect(data.getData()).toContain(IDS[0]);
  section.remove();
});
it('keeps one attempt key after a lost reply and suppresses concurrent paste', async () => {
  let reject: (cause: Error) => void = () => {};
  const client = {
    copyTasks: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          })
      )
      .mockResolvedValue(['copied'])
  };
  const onPasted = vi.fn();
  renderHook(
    () =>
      useTaskClipboard({
        teamId: TEAM,
        selected: IDS.map(id => ({ id }) as TeamTaskSummary),
        canEdit: true,
        client,
        onPasted
      }),
    { wrapper }
  );
  const data = clipboard();
  fireEvent.copy(document, { clipboardData: data });
  fireEvent.paste(document, { clipboardData: data });
  fireEvent.paste(document, { clipboardData: data });
  expect(client.copyTasks).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error('reply lost')));
  fireEvent.paste(document, { clipboardData: data });
  await waitFor(() => expect(onPasted).toHaveBeenCalled());
  expect(client.copyTasks.mock.calls[0][0].idempotencyKey).toEqual(expect.any(String));
  expect(client.copyTasks.mock.calls[1][0].idempotencyKey).toBe(
    client.copyTasks.mock.calls[0][0].idempotencyKey
  );
});
