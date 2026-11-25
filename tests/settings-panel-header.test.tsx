// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsPanelHeader } from '../apps/web/src/components/SettingsPanelHeader';

afterEach(cleanup);

function Panel() {
  const [open, setOpen] = useState(true);
  return (
    <SettingsPanelHeader
      title="Compression settings"
      titleId="title"
      bodyId="body"
      open={open}
      onToggle={() => setOpen(value => !value)}
      summary={<span data-testid="summary">720p · 30 FPS</span>}
    />
  );
}

const toggle = () => screen.getByRole('button', { name: 'Compression settings' });

describe('a tool’s settings header (owner, 25.11)', () => {
  it('folds from anywhere on its strip, not only from its title', () => {
    render(<Panel />);
    fireEvent.click(screen.getByTestId('summary'));
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(document.querySelector('.settings-collapse-row')!);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('folds once, not twice, when the title itself is pressed', () => {
    render(<Panel />);
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });
});
