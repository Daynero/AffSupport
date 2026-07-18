import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Button,
  ProgressBar,
  SegmentedControl,
  StatusBadge,
  WishlyLoader
} from '../apps/web/src/components/ui';
import { WishlyLogo, WishlyMark } from '../apps/web/src/components/WishlyLogo';
import { translate } from '../apps/web/src/i18n';
import type { TranslationKey } from '../apps/web/src/i18n';

const t = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate('en', key, values);

describe('Wishly UI components', () => {
  it('keeps button width stable while loading (overlay spinner, label kept)', () => {
    const markup = renderToStaticMarkup(
      <Button variant="primary" loading>
        Compress selected
      </Button>
    );
    expect(markup).toContain('is-loading');
    expect(markup).toContain('Compress selected');
    expect(markup).toContain('button-spinner');
    expect(markup).toContain('disabled');
  });

  it('renders the segmented control as an accessible radiogroup', () => {
    const markup = renderToStaticMarkup(
      <SegmentedControl
        label="Mode"
        value="optimal"
        options={[
          { value: 'optimal', label: 'Optimal' },
          { value: 'custom', label: 'Custom settings' }
        ]}
        onChange={() => {}}
      />
    );
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-checked="true"');
    // Static render has no measured indicator yet; the fallback style keeps
    // the active option visible.
    expect(markup).toContain('no-indicator');
  });

  it('marks completed status with an animated check and processing with the Wishly loader', () => {
    const completed = renderToStaticMarkup(<StatusBadge status="completed" t={t} />);
    expect(completed).toContain('status-check');
    expect(completed).toContain('Completed');

    const processing = renderToStaticMarkup(<StatusBadge status="processing" t={t} />);
    expect(processing).toContain('wishly-loader');
  });

  it('lets the progress gradient flow only while actively processing', () => {
    expect(renderToStaticMarkup(<ProgressBar value={40} label="p" active />)).toContain(
      'is-flowing'
    );
    expect(renderToStaticMarkup(<ProgressBar value={40} label="p" />)).not.toContain('is-flowing');
    expect(renderToStaticMarkup(<ProgressBar value={100} label="p" active />)).not.toContain(
      'is-flowing'
    );
    expect(renderToStaticMarkup(<ProgressBar value={null} label="p" />)).toContain(
      'is-indeterminate'
    );
  });

  it('exposes the Wishly mark and wordmark for the header and drop zones', () => {
    const logo = renderToStaticMarkup(<WishlyLogo name="Wishly" />);
    expect(logo).toContain('wishly-mark');
    expect(logo).toContain('Wishly');
    expect(renderToStaticMarkup(<WishlyMark size={20} />)).toContain('viewBox="0 0 64 64"');
    expect(renderToStaticMarkup(<WishlyLoader />)).toContain('ribbon-center');
  });
});
