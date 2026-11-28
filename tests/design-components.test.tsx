import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Button,
  Progress,
  SegmentedControl,
  StorageMeter
} from '../apps/web/src/components/ui/index';
import { StatusBadge } from '../apps/web/src/components/StatusBadge';
import { SotyLoader } from '../apps/web/src/components/SotyLoader';
import { SotyLogo, SotyMark } from '../apps/web/src/components/SotyLogo';
import { translate } from '../apps/web/src/i18n';
import type { TranslationKey } from '../apps/web/src/i18n';

/**
 * The product's own components, read through the inventory's marker grammar
 * (070, T040; was 024 T038).
 *
 * This file used to assert the pre-021 shim's literal classes —
 * `button-spinner`, `no-indicator`, a `ProgressBar` with `active`. The shim's
 * originals are gone from every screen outside the space, so the assertions
 * name what the inventory marks: `ui-<component>` for the part, `ui-<component>--<variant>`
 * and `ui-color-<role>` for its look, `is-<state>` for what it is doing.
 */

const t = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate('en', key, values);

function classes(markup: string, marker: string): string[] {
  const match = new RegExp(`class="([^"]*\\b${marker}\\b[^"]*)"`, 'u').exec(markup);
  return match ? match[1]!.split(/\s+/u) : [];
}

describe('Soty UI components', () => {
  it('keeps a loading button its label and its width: a spinner over it, the press off', () => {
    const markup = renderToStaticMarkup(
      <Button color="primary" loading>
        Compress selected
      </Button>
    );
    const button = classes(markup, 'ui-button');
    expect(button).toContain('ui-button--solid');
    expect(button).toContain('ui-color-primary');
    expect(button).toContain('is-loading');
    expect(markup).toContain('Compress selected');
    expect(markup).toContain('ui-button-spinner');
    expect(markup).toMatch(/disabled/u);
  });

  it('renders the segmented control as an accessible radiogroup with one chosen', () => {
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
    expect(classes(markup, 'ui-segmented').length).toBeGreaterThan(0);
    expect(markup).toContain('role="radiogroup"');
    expect(markup.match(/aria-checked="true"/gu)).toHaveLength(1);
  });

  it('marks completed status with a check and processing with the Soty loader', () => {
    const completed = renderToStaticMarkup(<StatusBadge status="completed" t={t} />);
    expect(classes(completed, 'status-badge')).toContain('ui-color-success');
    expect(completed).toContain('status-check');
    expect(completed).toContain('Completed');

    const processing = renderToStaticMarkup(<StatusBadge status="processing" t={t} />);
    expect(classes(processing, 'status-badge')).toContain('ui-color-info');
    expect(processing).toContain('soty-loader');
  });

  it('uses a speech waveform and transcription copy in transcription status badges', () => {
    const processing = renderToStaticMarkup(
      <StatusBadge status="processing" t={t} context="transcription" />
    );
    expect(processing).toContain('transcription-loader');
    expect(processing).toContain('Transcribing');
    expect(processing).not.toContain('soty-loader');
    expect(processing).not.toContain('Compressing');
  });

  it('lets the progress gradient flow only while work is really running', () => {
    const flowing = (node: React.ReactElement) =>
      classes(renderToStaticMarkup(node), 'ui-progress');
    expect(flowing(<Progress value={40} label="p" flowing />)).toContain('is-flowing');
    expect(flowing(<Progress value={40} label="p" />)).not.toContain('is-flowing');
    // A full bar describes work that has ended.
    expect(flowing(<Progress value={100} label="p" flowing />)).not.toContain('is-flowing');
    // A bar with no number slides instead; it does not also flow.
    const unknown = flowing(<Progress label="p" flowing />);
    expect(unknown).toContain('is-indeterminate');
    expect(unknown).not.toContain('is-flowing');
  });

  it('exposes the Soty mark and wordmark for the header and drop zones', () => {
    const logo = renderToStaticMarkup(<SotyLogo name="Soty" />);
    expect(logo).toContain('soty-wordmark-img');
    expect(logo).toContain('Soty');
    expect(renderToStaticMarkup(<SotyMark size={20} />)).toContain('/icon-192.png');
    expect(renderToStaticMarkup(<SotyLoader />)).toContain('ribbon-center');
  });
  it('draws the storage scale from the inventory: segments, hatch, free, words (057, T054)', () => {
    const markup = renderToStaticMarkup(
      <StorageMeter
        compact
        level="warning"
        segments={[
          { category: 'materials', label: 'Materials', bytes: 600 },
          { category: 'catalogs', label: 'Catalogs', bytes: 200 }
        ]}
        reservedBytes={50}
        capacityBytes={1000}
        formatBytes={bytes => `${bytes} B`}
        formatShare={share => `${Math.round(share * 100)} %`}
        labels={{
          name: 'Space storage',
          summary: 'Used 800 B of 1000 B',
          reserved: 'Being written',
          free: 'Free',
          level: 'Almost full'
        }}
      />
    );
    const root = classes(markup, 'ui-storage-meter');
    expect(root).toContain('is-compact');
    expect(markup).toContain('data-level="warning"');
    expect(markup).toContain('class="ui-storage-meter-segment" data-category="materials"');
    expect(markup).toContain(
      'class="ui-storage-meter-segment is-reserved" data-category="reserved"'
    );
    expect(markup).toContain('role="meter"');
    expect(markup).toContain('Almost full');
    expect(markup).toContain('150 B');
  });
});
