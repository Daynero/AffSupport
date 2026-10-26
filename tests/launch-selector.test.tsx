// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../apps/web/src/components/ui/index';
import { LaunchSelector } from '../apps/web/src/team/launches/LaunchSelectors';
afterEach(cleanup);
it('opens a searchable choice once and commits only an actual option', async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  function Harness() {
    const [value, setValue] = useState('patrik');
    return (
      <LaunchSelector
        id="launch-selector-test"
        label="Buyer"
        value={value}
        options={[
          { value: 'patrik', label: 'Patrik' },
          { value: 'roman', label: 'Roman' }
        ]}
        onChange={next => {
          changed(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Harness />);
  const input = screen.getByRole('combobox', { name: 'Buyer' });
  await user.click(input);
  expect(screen.getAllByRole('listbox')).toHaveLength(1);
  await user.clear(input);
  await user.type(input, 'rom');
  expect(changed).not.toHaveBeenCalled();
  await user.click(screen.getByRole('option', { name: 'Roman' }));
  expect(changed).toHaveBeenCalledWith('roman');
  expect(input).toHaveProperty('value', 'Roman');
  expect(screen.queryByRole('listbox')).toBeNull();
  await user.clear(input);
  await user.type(input, 'not_an_option');
  await user.tab();
  expect(input).toHaveProperty('value', 'Roman');
  expect(changed).toHaveBeenCalledOnce();
});
it('creates the searched value once and selects the returned dictionary choice', async () => {
  const user = userEvent.setup();
  const created = vi.fn();
  function Harness() {
    const [value, setValue] = useState('');
    const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
    return (
      <LaunchSelector
        id="launch-selector-test"
        label="Buyer"
        value={value}
        options={options}
        onChange={setValue}
        onCreate={async candidate => {
          created(candidate);
          setOptions([{ value: 'created', label: candidate }]);
          setValue('created');
        }}
      />
    );
  }
  render(<Harness />);
  const input = screen.getByRole('combobox', { name: 'Buyer' });
  await user.type(input, 'new_buyer');
  await user.click(screen.getByRole('option', { name: 'Create “new_buyer”' }));
  expect(created).toHaveBeenCalledOnce();
  expect(created).toHaveBeenCalledWith('new_buyer');
  await waitFor(() => expect(input).toHaveProperty('value', 'new_buyer'));
});
it('selects a created dictionary item from the id returned by the creator', async () => {
  const user = userEvent.setup();
  const selected = vi.fn();
  function Harness() {
    const [value, setValue] = useState('');
    const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
    return (
      <LaunchSelector
        id="launch-selector-test"
        label="Offer"
        value={value}
        options={options}
        onChange={next => {
          selected(next);
          setValue(next);
        }}
        onCreate={async candidate => {
          setOptions([{ value: 'offer-id', label: candidate }]);
          return 'offer-id';
        }}
      />
    );
  }
  render(<Harness />);
  const input = screen.getByRole('combobox', { name: 'Offer' });
  await user.type(input, 'New offer');
  await user.click(screen.getByRole('option', { name: 'Create “New offer”' }));
  await waitFor(() => expect(input).toHaveProperty('value', 'New offer'));
  expect(selected).toHaveBeenCalledWith('offer-id');
});
it('prevents searching or creating through a locked control', async () => {
  const created = vi.fn();
  render(
    <LaunchSelector
      id="launch-selector-test"
      label="Buyer"
      value=""
      options={[]}
      onChange={vi.fn()}
      onCreate={created}
      disabled
    />
  );
  expect(screen.getByRole('combobox', { name: 'Buyer' })).toHaveProperty('disabled', true);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Buyer' }));
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(created).not.toHaveBeenCalled();
});

it('keeps the offer list closed when an apply dialog returns focus to the selector', async () => {
  const user = userEvent.setup();
  function Harness() {
    const [value, setValue] = useState('');
    const [prompt, setPrompt] = useState(false);
    return (
      <>
        <LaunchSelector
          id="offer-focus-test"
          label="Offer"
          value={value}
          options={[{ value: 'offer', label: 'ProCaps TR' }]}
          onChange={next => {
            setValue(next);
            setPrompt(true);
          }}
        />
        {prompt && (
          <ConfirmDialog
            title="Apply saved settings?"
            body="Restore this offer"
            confirmLabel="Yes, apply"
            cancelLabel="No"
            tone="neutral"
            onConfirm={() => setPrompt(false)}
            onCancel={() => setPrompt(false)}
          />
        )}
      </>
    );
  }
  render(<Harness />);
  await user.click(screen.getByRole('combobox', { name: 'Offer' }));
  await user.click(screen.getByRole('option', { name: 'ProCaps TR' }));
  await user.click(await screen.findByRole('button', { name: 'Yes, apply' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Offer' })).toHaveProperty('value', 'ProCaps TR');
  await user.click(screen.getByRole('combobox', { name: 'Offer' }));
  expect(await screen.findByRole('option', { name: 'ProCaps TR' })).toBeTruthy();
});
