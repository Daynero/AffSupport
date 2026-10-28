// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LaunchEditor } from '../apps/web/src/team/launches/LaunchEditor';
import { newLaunchDraft } from '../apps/web/src/team/launches/launchDraftDefaults';
vi.mock('../apps/web/src/team/launches/LaunchCreativePicker', () => ({
  LaunchCreativePicker: () => null
}));
afterEach(cleanup);
it('keeps the maximum focused through empty and reversed bounds while typing 250', () => {
  function Editor() {
    const [config, setConfig] = useState({
      ...newLaunchDraft(),
      campaignCount: 5,
      minBudget: 140,
      maxBudget: 250
    });
    return (
      <LaunchEditor
        teamId="team"
        config={config}
        sources={null}
        accounts={[]}
        offers={[]}
        buyers={[]}
        disabled={false}
        onRefreshSources={() => {}}
        onChange={patch => setConfig(previous => ({ ...previous, ...patch }))}
      />
    );
  }
  render(<Editor />);
  const maximum = screen.getByRole('spinbutton', { name: 'Maximum' });
  fireEvent.focus(maximum);
  maximum.focus();
  for (const value of ['', '2', '25', '250']) {
    fireEvent.change(maximum, { target: { value } });
    expect(screen.getByRole('spinbutton', { name: 'Maximum' })).toBe(maximum);
    expect(document.activeElement).toBe(maximum);
    expect(maximum.getAttribute('aria-invalid')).not.toBe('true');
  }
  fireEvent.blur(maximum);
  expect(maximum.getAttribute('aria-invalid')).not.toBe('true');
  fireEvent.focus(maximum);
  fireEvent.change(maximum, { target: { value: '2' } });
  fireEvent.blur(maximum);
  expect(maximum.getAttribute('aria-invalid')).toBe('true');
});
