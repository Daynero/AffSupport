// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AccountNameRow } from '../apps/web/src/team/accounts/AccountGroup';
describe('account editor after authoritative permission loss', () => {
  it('keeps the unsaved name but blocks both the save button and Enter', () => {
    const save = vi.fn();
    const { rerender } = render(
      <AccountNameRow initialName="Original" canSave onSave={save} onCancel={() => {}} />
    );
    const name = screen.getAllByRole('textbox')[0] as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Unsaved draft' } });
    rerender(
      <AccountNameRow initialName="Original" canSave={false} onSave={save} onCancel={() => {}} />
    );
    expect(name.value).toBe('Unsaved draft');
    const button = screen.getByRole('button', { name: /^(Save|Зберегти)$/ }) as HTMLButtonElement;
    expect(button.disabled || button.getAttribute('aria-disabled') === 'true').toBe(true);
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/permission|дозвол/i);
  });
  it('explains an authoritative server denial instead of a generic retry suggestion', async () => {
    const save = vi.fn().mockRejectedValue({ code: 'PERMISSION_DENIED' });
    render(<AccountNameRow initialName="Original" onSave={save} onCancel={() => {}} />);
    fireEvent.keyDown(screen.getAllByRole('textbox')[0], { key: 'Enter' });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/permission|дозвол/i)
    );
  });
});
