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
    requestId: expect.any(String)
  });
  const input = document.createElement('textarea');
  document.body.append(input);
  fireEvent.paste(input, { clipboardData: data });
  fireEvent.paste(document, { clipboardData: { getData: () => 'ordinary text' } });
  expect(client.copyTasks).toHaveBeenCalledTimes(1);
  input.remove();
});
it('reuses an unconfirmed request after remount and starts a new one after confirmation', async () => {
  sessionStorage.clear();
  const data = clipboard();
  data.setData('text/plain', 'SOTY_TASKS_V1:' + JSON.stringify({ teamId: TEAM, taskIds: IDS }));
  const client = { copyTasks: vi.fn().mockRejectedValueOnce(new Error('NETWORK')) };
  const props = {
    teamId: TEAM,
    selected: [] as TeamTaskSummary[],
    canEdit: true,
    client,
    onPasted: vi.fn()
  };
  const first = renderHook(() => useTaskClipboard(props), { wrapper });
  fireEvent.paste(document, { clipboardData: data });
  await waitFor(() => expect(client.copyTasks).toHaveBeenCalledTimes(1));
  const firstId = client.copyTasks.mock.calls[0]?.[0].requestId;
  await waitFor(() => expect(sessionStorage.length).toBe(1));
  first.unmount();

  client.copyTasks.mockResolvedValue(['copy-1']);
  renderHook(() => useTaskClipboard(props), { wrapper });
  fireEvent.paste(document, { clipboardData: data });
  await waitFor(() => expect(props.onPasted).toHaveBeenCalledWith(['copy-1']));
  expect(client.copyTasks.mock.calls[1]?.[0].requestId).toBe(firstId);
  await waitFor(() => expect(sessionStorage.length).toBe(0));

  fireEvent.paste(document, { clipboardData: data });
  await waitFor(() => expect(client.copyTasks).toHaveBeenCalledTimes(3));
  expect(client.copyTasks.mock.calls[2]?.[0].requestId).not.toBe(firstId);
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
