// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { defaultLandingSettings } from '@video-compressor/shared';
import { LandingSettingsPanel } from '../apps/web/src/landing/LandingOptimizerPage';
import { translate } from '../apps/web/src/i18n';
import type { Translate } from '../apps/web/src/components/ui';

const t: Translate = (key, values) => translate('en', key, values);

afterEach(cleanup);

/**
 * The Landing Optimizer's settings, in the compressor's idiom.
 *
 * Four groups in one row, each of them a row of pictos with the answer spelled out
 * underneath: the two kinds of media, where the result goes, and the switches that apply to
 * the landing as a whole. Explanations live in tooltips, never in the row, because a row that
 * explains itself in prose is a row that wraps onto three lines.
 */
describe('landing optimizer settings', () => {
  function panel(overrides = {}) {
    const update = vi.fn();
    const chooseOutputFolder = vi.fn();
    const view = render(
      <LandingSettingsPanel
        settings={{ ...defaultLandingSettings(), ...overrides }}
        disabled={false}
        update={update}
        chooseOutputFolder={chooseOutputFolder}
        t={t}
      />
    );
    return { ...view, update, chooseOutputFolder };
  }

  it('keeps the compact controls in one row and moves explanations into tooltips', async () => {
    const user = userEvent.setup();
    const { container } = panel({ videoQuality: 'high' });

    const row = container.querySelector('.landing-settings-primary-row');
    expect(row).toBeTruthy();
    expect(row?.children).toHaveLength(4);
    expect(screen.getByRole('radiogroup', { name: 'Image quality' }).parentElement).toBe(
      row?.children[0]
    );
    expect(screen.getByRole('radiogroup', { name: 'Video quality' }).parentElement).toBe(
      row?.children[1]
    );
    expect(screen.getByRole('radiogroup', { name: 'Save results' }).parentElement).toBe(
      row?.children[2]
    );
    expect(screen.getByRole('checkbox', { name: 'Create ZIP' }).closest('.field-group')).toBe(
      row?.children[3]
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
  });

  it('turns one kind of media off without touching the other', async () => {
    const user = userEvent.setup();
    const { update } = panel();
    await user.click(screen.getByRole('radio', { name: 'Image quality: Off' }));
    // Only the switch, never the quality: turning images back on has to remember what they
    // were set to, and a patch that carried the quality would flatten it to the default.
    expect(update).toHaveBeenCalledWith({ optimizeImages: false });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('turns it back on at the quality that was pressed', async () => {
    const user = userEvent.setup();
    const { update } = panel({ optimizeVideos: false });
    await user.click(screen.getByRole('radio', { name: 'Video quality: High Quality' }));
    expect(update).toHaveBeenCalledWith({ optimizeVideos: true, videoQuality: 'high' });
  });

  it('says which of the three a kind of media is on', () => {
    panel({ optimizeImages: false });
    expect(
      screen.getByRole('radio', { name: 'Image quality: Off' }).getAttribute('aria-checked')
    ).toBe('true');
    // Both the summary under the pictos and the collapsed header now say it.
    expect(screen.getAllByText('Off').length).toBeGreaterThan(0);
  });

  it('offers the compressor’s two destinations, and names the chosen folder', async () => {
    const user = userEvent.setup();
    const { chooseOutputFolder, update } = panel({
      outputMode: 'chosen-folder',
      outputFolder: '/Users/someone/Landings'
    });
    // A path is shown, so a person can see where the next result is going without pressing
    // anything — the complaint that started this was not knowing.
    expect(screen.getByText(/Landings/u)).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'Separate folder' }));
    // The dialog decides; nothing is written until it returns a folder.
    expect(chooseOutputFolder).toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('carries the switches that apply to the whole landing', async () => {
    const user = userEvent.setup();
    const { update } = panel();
    await user.click(screen.getByRole('checkbox', { name: 'Create ZIP' }));
    expect(update).toHaveBeenCalledWith({ archive: true });
    await user.click(screen.getByRole('checkbox', { name: 'Remove metadata' }));
    expect(update).toHaveBeenCalledWith({ stripMetadata: false });
    await user.click(screen.getByRole('checkbox', { name: 'Wipe names' }));
    expect(update).toHaveBeenCalledWith({ renameMedia: true });
  });
});
