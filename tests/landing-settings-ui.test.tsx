// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LandingSettingsPanel } from '../apps/web/src/landing/LandingOptimizerPage';
import { translate } from '../apps/web/src/i18n';
import type { Translate } from '../apps/web/src/components/ui';

const t: Translate = (key, values) => translate('en', key, values);

afterEach(cleanup);

describe('landing optimizer settings', () => {
  it('keeps the compact controls in one row and moves explanations into tooltips', async () => {
    const user = userEvent.setup();
    const update = vi.fn();
    const { container } = render(
      <LandingSettingsPanel
        settings={{ imageQuality: 'optimal', videoQuality: 'high', archive: false }}
        disabled={false}
        update={update}
        t={t}
      />
    );

    const row = container.querySelector('.landing-settings-primary-row');
    expect(row).toBeTruthy();
    expect(row?.children).toHaveLength(3);
    expect(screen.getByRole('radiogroup', { name: 'Image quality' }).parentElement).toBe(
      row?.children[0]
    );
    expect(screen.getByRole('radiogroup', { name: 'Video quality' }).parentElement).toBe(
      row?.children[1]
    );
    expect(screen.getByRole('checkbox', { name: 'Create ZIP' }).closest('.field-group')).toBe(
      row?.children[2]
    );

    expect(
      screen.queryByText('Balanced WebP that noticeably reduces weight while looking clean.')
    ).toBeNull();
    await user.click(
      screen.getByRole('button', {
        name: 'Balanced WebP that noticeably reduces weight while looking clean.'
      })
    );
    expect(screen.getByRole('tooltip').textContent).toBe(
      'Balanced WebP that noticeably reduces weight while looking clean.'
    );

    await user.click(screen.getByRole('checkbox', { name: 'Create ZIP' }));
    expect(update).toHaveBeenCalledWith({ archive: true });
  });
});
