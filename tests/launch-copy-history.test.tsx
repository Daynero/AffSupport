// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LaunchCopyHistory } from '../apps/web/src/team/launches/LaunchCopyHistory';
import { CopyResultField } from '../apps/web/src/team/launches/CopyResultField';
import { LaunchNotesResult } from '../apps/web/src/team/launches/LaunchNotes';
import { launchCopyMarksApi, type LaunchCopyScope } from '../apps/web/src/api/launch-copy-marks';
vi.mock('../apps/web/src/api/launch-copy-marks', () => ({
  launchCopyMarksApi: { read: vi.fn(), write: vi.fn() }
}));
const scope: LaunchCopyScope = {
  actorId: 'actor-a',
  teamId: 'team',
  launchId: 'launch',
  revisionId: 'base'
};
const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
let stored: Map<string, string>;
const key = (s: LaunchCopyScope, field: string) =>
  `${s.actorId}:${s.teamId}:${s.launchId}:${field.startsWith('note:') ? 'note' : s.revisionId}:${field}`;
function Host({
  value = 'Alpha',
  actor = 'actor-a',
  revision = 'base'
}: {
  value?: string;
  actor?: string;
  revision?: string;
}) {
  return (
    <LaunchCopyHistory
      scope={{ ...scope, actorId: actor, revisionId: revision }}
      lineageId={revision}
      values={{ 'campaign:1': value }}
    >
      <CopyResultField
        compact
        copyKey="campaign:1"
        label="Campaign #1"
        value={value}
        baseline={value}
      />
    </LaunchCopyHistory>
  );
}
const row = () =>
  screen.getByRole('button', { name: 'Copy Campaign #1' }).closest('.launch-result-row')!;
async function tick() {
  await act(async () => {
    await Promise.resolve();
  });
}
async function copy() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Copy Campaign #1' }));
  });
}
beforeEach(() => {
  stored = new Map();
  vi.mocked(launchCopyMarksApi.read).mockImplementation(async (s, values) =>
    Object.keys(values).filter(field => stored.get(key(s, field)) === values[field])
  );
  vi.mocked(launchCopyMarksApi.write).mockImplementation(async (s, values, copied) => {
    for (const [field, value] of Object.entries(values)) {
      if (copied) stored.set(key(s, field), value);
      else stored.delete(key(s, field));
    }
  });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(launchCopyMarksApi.read).mockReset();
  vi.mocked(launchCopyMarksApi.write).mockReset();
  if (original) Object.defineProperty(navigator, 'clipboard', original);
  else Reflect.deleteProperty(navigator, 'clipboard');
});
it('flashes green then remains quiet, survives remount and resets when text, actor or generation changes', async () => {
  vi.useFakeTimers();
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  let view = render(<Host />);
  await tick();
  await copy();
  expect(row().classList.contains('launch-result-copied')).toBe(true);
  await act(async () => {
    vi.advanceTimersByTime(1600);
  });
  expect(row().classList.contains('launch-result-already-copied')).toBe(true);
  expect(screen.getByText('Already copied')).toBeTruthy();
  expect(screen.getByText('Copied 1 of 1')).toBeTruthy();
  view.unmount();
  view = render(<Host />);
  await tick();
  expect(row().classList.contains('launch-result-already-copied')).toBe(true);
  expect(row().classList.contains('launch-result-copied')).toBe(false);
  view.rerender(<Host value="Changed" />);
  await tick();
  expect(row().classList.contains('launch-result-already-copied')).toBe(false);
  view.rerender(<Host actor="actor-b" />);
  await tick();
  expect(row().classList.contains('launch-result-already-copied')).toBe(false);
  view.rerender(<Host revision="new-generation" />);
  await tick();
  expect(row().classList.contains('launch-result-already-copied')).toBe(false);
  expect(storage).not.toHaveBeenCalled();
});
it('does not record a failed clipboard attempt and permits another copy of a marked row', async () => {
  vi.useFakeTimers();
  const write = vi.mocked(navigator.clipboard.writeText);
  write.mockRejectedValueOnce(new Error('denied'));
  render(<Host />);
  await tick();
  await copy();
  expect(launchCopyMarksApi.write).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toBeTruthy();
  await copy();
  await act(async () => {
    vi.advanceTimersByTime(1600);
  });
  expect(row().classList.contains('launch-result-already-copied')).toBe(true);
  await copy();
  expect(row().classList.contains('launch-result-copied')).toBe(true);
  expect(write).toHaveBeenCalledTimes(3);
});
it('a late clipboard completion cannot mark changed text or another actor', async () => {
  let finish!: () => void;
  vi.mocked(navigator.clipboard.writeText).mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  const view = render(<Host />);
  await tick();
  fireEvent.click(screen.getByRole('button', { name: 'Copy Campaign #1' }));
  view.rerender(<Host actor="actor-b" value="Changed" />);
  await tick();
  await act(async () => {
    finish();
  });
  expect(launchCopyMarksApi.write).not.toHaveBeenCalled();
  expect(row().classList.contains('launch-result-already-copied')).toBe(false);
  expect(row().classList.contains('launch-result-copied')).toBe(false);
});
it('does not resurrect a successful reset from a stale read, and supports undo', async () => {
  stored.set(key(scope, 'campaign:1'), 'Alpha');
  render(<Host />);
  await tick();
  let reply!: (value: string[]) => void;
  vi.mocked(launchCopyMarksApi.read).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        reply = resolve;
      })
  );
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Reset copy marks' }));
  });
  expect(stored.has(key(scope, 'campaign:1'))).toBe(false);
  await act(async () => {
    reply(['campaign:1']);
  });
  expect(row().classList.contains('launch-result-already-copied')).toBe(false);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Undo reset' }));
  });
  expect(stored.get(key(scope, 'campaign:1'))).toBe('Alpha');
  expect(row().classList.contains('launch-result-already-copied')).toBe(true);
});
it('keeps tab-local proof after a receipt write failure and retries without copying again', async () => {
  vi.useFakeTimers();
  vi.mocked(launchCopyMarksApi.write).mockRejectedValueOnce(new Error('network'));
  render(<Host />);
  await tick();
  await copy();
  await act(async () => {
    vi.advanceTimersByTime(1600);
  });
  expect(row().classList.contains('launch-result-already-copied')).toBe(true);
  expect(
    screen.getByText('Copy marks are not saved yet; they are only available in this tab.')
  ).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  });
  expect(stored.get(key(scope, 'campaign:1'))).toBe('Alpha');
  expect(navigator.clipboard.writeText).toHaveBeenCalledOnce();
});
it('retains note marks on title changes and removes them on body changes', async () => {
  const note = { id: '80000000-0000-4000-8000-000000000001', title: 'First', text: 'Exact\nbody' };
  stored.set(key(scope, `note:${note.id}`), note.text);
  const display = (title: string, text: string) => (
    <LaunchCopyHistory scope={scope} lineageId="base" values={{ [`note:${note.id}`]: text }}>
      <LaunchNotesResult notes={[{ ...note, title, text }]} disabled={false} />
    </LaunchCopyHistory>
  );
  const view = render(display('First', note.text));
  await tick();
  expect(
    screen.getByRole('button', { name: 'First' }).classList.contains('launch-note-already-copied')
  ).toBe(true);
  view.rerender(display('Renamed', note.text));
  await tick();
  expect(
    screen.getByRole('button', { name: 'Renamed' }).classList.contains('launch-note-already-copied')
  ).toBe(true);
  view.rerender(display('Renamed', 'Different'));
  await tick();
  expect(
    screen.getByRole('button', { name: 'Renamed' }).classList.contains('launch-note-already-copied')
  ).toBe(false);
});

it('drains already queued owner-scoped writes after the result closes', async () => {
  let finish!: () => void;
  vi.mocked(launchCopyMarksApi.write).mockImplementationOnce(async (s, values, copied) => {
    await new Promise<void>(resolve => {
      finish = resolve;
    });
    for (const [field, value] of Object.entries(values))
      if (copied) stored.set(key(s, field), value);
  });
  function Pair() {
    return (
      <LaunchCopyHistory
        scope={scope}
        lineageId="base"
        values={{ 'campaign:1': 'Alpha', 'campaign:2': 'Beta' }}
      >
        <CopyResultField
          compact
          copyKey="campaign:1"
          label="Campaign #1"
          value="Alpha"
          baseline="Alpha"
        />
        <CopyResultField
          compact
          copyKey="campaign:2"
          label="Campaign #2"
          value="Beta"
          baseline="Beta"
        />
      </LaunchCopyHistory>
    );
  }
  const view = render(<Pair />);
  await tick();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Copy Campaign #1' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Copy Campaign #2' }));
  });
  expect(launchCopyMarksApi.write).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => {
    finish();
  });
  expect(stored.get(key(scope, 'campaign:1'))).toBe('Alpha');
  expect(stored.get(key(scope, 'campaign:2'))).toBe('Beta');
});

it('keeps reset tombstones when a read begins during the write and no visible-tab refresh follows', async () => {
  stored.set(key(scope, 'campaign:1'), 'Alpha');
  render(<Host />);
  await tick();
  let finish!: () => void;
  let reply!: (fields: string[]) => void;
  vi.mocked(launchCopyMarksApi.write).mockImplementationOnce(async (s, values) => {
    await new Promise<void>(resolve => {
      finish = resolve;
    });
    for (const field of Object.keys(values)) stored.delete(key(s, field));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Reset copy marks' }));
  });
  vi.mocked(launchCopyMarksApi.read).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        reply = resolve;
      })
  );
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => {
    finish();
  });
  await act(async () => {
    reply(['campaign:1']);
  });
  expect(row().classList.contains('launch-result-already-copied')).toBe(false);
  visibility.mockRestore();
});

it('does not flash another actor green when a pending copy resolves with identical visible text', async () => {
  let finish!: () => void;
  vi.mocked(navigator.clipboard.writeText).mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  const view = render(<Host />);
  await tick();
  fireEvent.click(screen.getByRole('button', { name: 'Copy Campaign #1' }));
  view.rerender(<Host actor="actor-b" />);
  await tick();
  await act(async () => {
    finish();
  });
  expect(row().classList.contains('launch-result-copied')).toBe(false);
  expect(row().classList.contains('launch-result-already-copied')).toBe(false);
  expect(launchCopyMarksApi.write).not.toHaveBeenCalled();
});

it('debounces receipt reads during manual typing and excludes uncopyable empty values', async () => {
  vi.useFakeTimers();
  const view = render(<Host />);
  await tick();
  expect(launchCopyMarksApi.read).toHaveBeenCalledTimes(1);
  view.rerender(<Host value="A" />);
  await tick();
  view.rerender(<Host value="AB" />);
  await tick();
  view.rerender(<Host value="ABC" />);
  await tick();
  expect(launchCopyMarksApi.read).toHaveBeenCalledTimes(1);
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  expect(launchCopyMarksApi.read).toHaveBeenLastCalledWith(scope, { 'campaign:1': 'ABC' });
  view.rerender(<Host value="" />);
  await tick();
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  expect(launchCopyMarksApi.read).toHaveBeenLastCalledWith(scope, {});
});
