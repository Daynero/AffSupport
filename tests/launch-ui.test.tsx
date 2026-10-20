// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyResultField } from '../apps/web/src/team/launches/CopyResultField';
import { SubBuilder } from '../apps/web/src/team/launches/SubBuilder';
import { LaunchCard } from '../apps/web/src/team/launches/LaunchCard';
import { LaunchChangeReview } from '../apps/web/src/team/launches/LaunchChangeReview';
import type { LaunchSummary } from '../packages/shared/src/team/launches';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('reviews only affected outputs and lets the user return before confirming', async () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const props = {
    impact: { namesChanged: false, urlChanged: false, catalogChanged: false, mediaChanged: true },
    restitch: true,
    unsavedOutputs: true,
    disabled: false,
    onConfirm,
    onCancel
  };
  const view = render(<LaunchChangeReview {...props} />);
  expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual([
    'Reprocess video'
  ]);
  expect(screen.getByRole('status').textContent).toContain('Unsaved manual edits');
  fireEvent.click(screen.getByRole('button', { name: 'Back to editing' }));
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Update launch' }));
  expect(onConfirm).toHaveBeenCalledOnce();
  view.rerender(<LaunchChangeReview {...props} disabled />);
  fireEvent.click(screen.getByRole('button', { name: 'Update launch' }));
  expect(onConfirm).toHaveBeenCalledOnce();
  view.rerender(<LaunchChangeReview {...props} restitch={false} unsavedOutputs={false} />);
  expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual([
    'Configuration only — same results'
  ]);
  expect(screen.queryByRole('status')).toBeNull();
});
it('hides workflow and completed badges while keeping generation problems visible', () => {
  const value: LaunchSummary = {
    id: 'launch',
    version: '1',
    launchDate: '2026-10-13',
    offer: 'Offer',
    social: 'g1',
    creativeAlias: 'v5',
    method: 'other',
    workStatus: 'todo',
    assigneeId: null,
    budgets: [30],
    generationState: 'canceled'
  };
  const view = render(<LaunchCard value={value} onOpen={vi.fn()} />);
  expect(screen.queryByText('Ready')).toBeNull();
  expect(screen.queryByText('To do')).toBeNull();
  view.rerender(
    <LaunchCard value={{ ...value, budgets: [], generationState: null }} onOpen={vi.fn()} />
  );
  expect(screen.queryByText('Draft')).toBeNull();
  view.rerender(
    <LaunchCard value={{ ...value, generationState: 'interrupted' }} onOpen={vi.fn()} />
  );
  expect(screen.getByText('Generation needs attention')).toBeTruthy();
});
describe('Launch UI primitives', () => {
  it('opens edit and copies the resulting value with keyboard controls', async () => {
    const user = userEvent.setup();
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: write }
    });
    function Harness() {
      const [value, setValue] = useState('generated');
      return (
        <CopyResultField
          label="Campaign"
          baseline="generated"
          value={value}
          onChange={setValue}
          editable
        />
      );
    }
    render(<Harness />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit Campaign' }));
    await user.keyboard('{Enter}');
    const editor = screen.getByRole('textbox');
    expect(document.activeElement).toBe(editor);
    await user.clear(editor);
    await user.type(editor, 'keyboard value');
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Copy Campaign' }));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(write).toHaveBeenCalledWith('keyboard value'));
  });
  it('copies the current manual value and keeps the override badge after copy', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: write }
    });
    function Harness() {
      const [value, setValue] = useState('generated');
      return (
        <CopyResultField
          label="Campaign"
          baseline="generated"
          value={value}
          onChange={setValue}
          editable
        />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Campaign' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'manual' } });
    expect(write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy Campaign' }));
    await waitFor(() => expect(write).toHaveBeenCalledWith('manual'));
    expect(screen.getByText('Changed manually')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore generated' }));
    expect(screen.queryByText('Changed manually')).toBeNull();
  });
  it('does not claim copy success when clipboard is denied', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
    });
    render(<CopyResultField label="URL" baseline="text" value="text" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'Could not copy. Select the text to copy it manually.'
      )
    );
    expect(screen.queryByText('Copied')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'URL' })).toBeTruthy();
  });
  it('shows real clipboard success even when outcome telemetry rejects the signal', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: write }
    });
    render(
      <CopyResultField
        label="URL"
        baseline="https://example.invalid"
        value="https://example.invalid"
        onCopyOutcome={() => {
          throw new DOMException('quota', 'QuotaExceededError');
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(write).toHaveBeenCalledWith('https://example.invalid');
  });
  it('lets a user select result text without copying it', () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: write }
    });
    render(<CopyResultField label="URL" baseline="long exact result" value="long exact result" />);
    const button = screen.getByRole('button', { name: 'Copy URL' });
    const text = button.querySelector('.ui-button-label')?.firstChild;
    if (!text) throw new Error('copy value text missing');
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.click(button, { detail: 1 });
    expect(write).not.toHaveBeenCalled();
    fireEvent.click(button, { detail: 0 });
    expect(write).toHaveBeenCalledWith('long exact result');
    window.getSelection()?.removeAllRanges();
  });
  it('preserves selection order and allows keyboard-operable reorder buttons', () => {
    const change = vi.fn();
    render(
      <SubBuilder
        slot="sub2"
        selected={['creative', 'buyer']}
        onChange={change}
        preview="v5-patrik"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'SUB2' }));
    const orderedAttributes = document.querySelector('.launch-sub-order-list');
    expect(orderedAttributes?.children).toHaveLength(2);
    for (const item of Array.from(orderedAttributes?.children ?? [])) {
      expect(item.querySelector('.launch-sub-order-label')).toBeTruthy();
      expect(
        item.querySelector('.launch-sub-order-actions')?.querySelectorAll('button')
      ).toHaveLength(2);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Move Buyer earlier' }));
    expect(change).toHaveBeenCalledWith(['buyer', 'creative']);
    expect(screen.getByText('v5-patrik')).toBeTruthy();
  });
  it('does not present an unresolved initial SUB preview as an error before input', () => {
    const change = vi.fn();
    const view = render(
      <SubBuilder slot="sub1" selected={['buyer']} onChange={change} preview={null} />
    );
    expect(screen.queryByText('Required')).toBeNull();
    view.rerender(
      <SubBuilder slot="sub1" selected={['buyer']} onChange={change} preview={null} submitted />
    );
    expect(screen.getByText('Required')).toBeTruthy();
  });
});

it('keeps unsaved overrides attached to the observed version when another member publishes a result', async () => {
  const { renderHook, act } = await import('@testing-library/react');
  const { useLaunchOverrides } = await import('../apps/web/src/team/launches/useLaunchOverrides');
  const { launchConfig, launchSources } = await import('./fixtures/launches');
  const { launchPreview } = await import('../packages/shared/src/team/launches');
  const config = launchConfig();
  const preview = launchPreview(config, launchSources);
  if (!preview.ok) throw new Error('fixture');
  const revision = {
    id: 'revision-1',
    revisionNo: 1,
    kind: 'generated' as const,
    config,
    sources: launchSources,
    baselineRevisionId: null,
    baseline: preview.value,
    overrides: {},
    catalog: null,
    createdAt: '2026-10-12T12:00:00Z'
  };
  const detail = {
    id: 'launch',
    version: '3',
    draft: config,
    expectedSourceSnapshot: null,
    assigneeId: null,
    workStatus: 'todo' as const,
    activeRevision: revision,
    generation: null
  };
  const hook = renderHook(({ current }) => useLaunchOverrides(current), {
    initialProps: { current: detail }
  });
  act(() => hook.result.current.setOverrides({ advertisingUrl: 'https://example.invalid/local' }));
  hook.rerender({
    current: {
      ...detail,
      version: '4',
      activeRevision: { ...revision, id: 'revision-2', revisionNo: 2 }
    }
  });
  expect(hook.result.current.revision?.id).toBe('revision-1');
  expect(hook.result.current.baseVersion).toBe('3');
  expect(hook.result.current.overrides.advertisingUrl).toBe('https://example.invalid/local');
});

it('does not copy invalid edits or report stale copy success', async () => {
  let resolveWrite: () => void = () => {};
  const write = vi.fn(
    () =>
      new Promise<void>(resolve => {
        resolveWrite = resolve;
      })
  );
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: write }
  });
  const view = render(
    <CopyResultField
      label="URL"
      baseline="https://example.invalid"
      value="https://example.invalid"
      validate={v => v.startsWith('https://')}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
  view.rerender(
    <CopyResultField
      label="URL"
      baseline="https://example.invalid"
      value="bad"
      validate={v => v.startsWith('https://')}
    />
  );
  const { act } = await import('@testing-library/react');
  await act(async () => resolveWrite());
  expect(screen.queryByText('Copied')).toBeNull();
  expect(screen.getByRole('button', { name: 'Copy URL' }).hasAttribute('disabled')).toBe(true);
  expect(write).toHaveBeenCalledTimes(1);
});

it('opens a Launch from its heading, padding and date while keeping selection and menu separate', async () => {
  const open = vi.fn(),
    select = vi.fn();
  const value: LaunchSummary = {
    id: 'clickable',
    version: '1',
    launchDate: '2026-10-16',
    createdAt: '2026-10-16T12:00:00Z',
    offer: 'Whole card',
    social: 'g1',
    creativeAlias: 'v5',
    method: 'other',
    workStatus: 'todo',
    assigneeId: null,
    budgets: [10],
    generationState: null
  };
  const view = render(
    <LaunchCard value={value} onOpen={open} onSelectedChange={select} onCopyLink={vi.fn()} />
  );
  fireEvent.click(screen.getByText('Whole card'));
  fireEvent.click(view.container.querySelector('[data-launch-id]')!);
  fireEvent.click(view.container.querySelector('time')!);
  expect(open).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole('checkbox'));
  expect(select).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Launch actions' }));
  expect(open).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link to launch' }));
  expect(open).toHaveBeenCalledTimes(3);
  const user = userEvent.setup();
  const button = screen.getByRole('button', { name: 'Whole card' });
  button.focus();
  await user.keyboard('{Enter}');
  expect(open).toHaveBeenCalledTimes(4);
});
