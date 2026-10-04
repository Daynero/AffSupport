// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DailyFinanceField } from '../apps/web/src/team/accounts/finance/DailyFinanceFields';
import type { FinanceField } from '@video-compressor/shared';

afterEach(cleanup);
it('shows saved feedback as a side icon inside the field control, not a line under the row', async () => {
  render(
    <DailyFinanceField
      metric="spend"
      field={field}
      canEdit
      save={vi.fn().mockResolvedValue(undefined)}
    />
  );
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '45' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  const status = await screen.findByRole('status');
  expect(status.tagName).toBe('SPAN');
  expect(status.title).toBe('Saved');
  expect(status.querySelector('svg')).toBeTruthy();
  expect(input.closest('.ui-field-control')?.contains(status)).toBe(true);
  expect(status.querySelector('.visually-hidden')?.textContent).toBe('Saved');
});
it('registers a save-all action that refuses invalid drafts and reports failures without losing input', async () => {
  let action: (() => Promise<boolean>) | null = null;
  const register = (_key: string, next: typeof action) => {
    action = next;
  };
  const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  render(
    <DailyFinanceField
      metric="spend"
      field={field}
      canEdit
      save={save}
      draftKey="a/spend"
      onRegisterSave={register}
    />
  );
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '-1' } });
  let result: boolean | undefined;
  await act(async () => {
    result = await action!();
  });
  expect(result).toBe(false);
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '20' } });
  await act(async () => {
    result = await action!();
  });
  expect(result).toBe(false);
  expect((input as HTMLInputElement).value).toBe('20');
  await act(async () => {
    result = await action!();
  });
  expect(result).toBe(true);
  expect(save.mock.calls[0]).toEqual(save.mock.calls[1]);
});
const field: FinanceField = {
  agentRowId: 'a',
  date: '2026-09-10',
  metric: 'spend',
  value: '12.34',
  currency: 'USD',
  version: '1',
  placementId: 'p',
  updatedAt: '2026-09-10T10:00:00Z',
  updatedBy: null
};
it('retains a draft across authoritative rereads and submits exact cents with original version', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const view = render(<DailyFinanceField metric="spend" field={field} canEdit save={save} />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '125,50' } });
  view.rerender(
    <DailyFinanceField
      metric="spend"
      field={{ ...field, value: '50.00', version: '2' }}
      canEdit
      save={save}
    />
  );
  expect((input as HTMLInputElement).value).toBe('125,50');
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(save).toHaveBeenCalledWith('125.50', '1', expect.any(String)));
});
it('does not submit invalid amounts and does not allow viewer edits', async () => {
  const save = vi.fn();
  const view = render(<DailyFinanceField metric="spend" field={field} canEdit save={save} />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '1.234' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('true');
  view.rerender(<DailyFinanceField metric="spend" field={field} canEdit={false} save={save} />);
  expect((screen.getByRole('textbox') as HTMLInputElement).readOnly).toBe(true);
});
it('retains the idempotency key when retrying a transport failure', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  render(<DailyFinanceField metric="spend" field={field} canEdit save={save} />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '20' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() =>
    expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('true')
  );
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[0]).toEqual(save.mock.calls[1]);
});
it('saves a valid draft on Tab without swallowing native navigation', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<DailyFinanceField metric="spend" field={field} canEdit save={save} />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '0' } });
  expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
  await waitFor(() => expect(save).toHaveBeenCalledWith('0.00', '1', expect.any(String)));
});
it('keeps focus on an invalid Tab and exposes the agent/date context', () => {
  const save = vi.fn();
  render(
    <DailyFinanceField
      metric="spend"
      field={field}
      canEdit
      save={save}
      contextLabel="00123 · 2026-09-10"
    />
  );
  const input = screen.getByRole('textbox', { name: /00123.*2026-09-10.*Spend/ });
  input.focus();
  fireEvent.change(input, { target: { value: '-1' } });
  expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(false);
  expect(document.activeElement).toBe(input);
  expect(save).not.toHaveBeenCalled();
});
