// @vitest-environment jsdom
/*
 * Owner, 2026-11-25: several creatives get one name of their own («пак 1»). It starts as the
 * automatic «<first>+N» and follows the list until typed; then SUB «Креатив», the campaign names
 * and the result's title carry the typed name.
 */
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  creativesPatch,
  launchAutoCreativeLabel,
  launchCreativeLabel,
  launchCreativeLabelInput,
  launchNamingPreview,
  launchPreview,
  launchSubPreview,
  normalizeLaunchCreativeLabel,
  parseLaunchConfig,
  parseLaunchDraft,
  type LaunchConfig,
  type LaunchCreative
} from '../packages/shared/src/team/launches';
import { LaunchCreativeLabelField } from '../apps/web/src/team/launches/LaunchCreativeList';
import { launchConfig, launchSources } from './fixtures/launches';

const video = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;
const creative = (n: number, copies: number): LaunchCreative => ({
  materialId: video(n),
  alias: `c${n}`,
  copies,
  pinned: null
});
const sources = {
  ...launchSources,
  materialType: 'video' as const,
  materials: [10, 13].map(n => ({ materialId: video(n), type: 'video' as const, version: '1' }))
};
const multi = (label?: string): LaunchConfig =>
  launchConfig({
    method: 'catalog',
    originalUrl: 'https://offer.example.test/?sub1=a&sub2=b&sub3=c',
    materialId: video(10),
    creativeAlias: 'c10',
    creativeKind: 'video',
    creatives: [creative(10, 2), creative(13, 2)],
    ...(label === undefined ? {} : { creativeLabel: label }),
    subConfig: {
      schemaVersion: 1,
      sub1: ['buyer'],
      sub2: ['social', 'creative'],
      sub3: ['creative']
    },
    catalog: {
      productCount: 4,
      restitchEnabled: false,
      finalDurationMode: 'random-30-40',
      customFinalDurationSeconds: null
    }
  });

describe('the name of several creatives', () => {
  it('is the typed name for several creatives, the automatic one otherwise', () => {
    expect(launchCreativeLabel(multi())).toBe('c10+1');
    expect(launchCreativeLabel(multi('pak_1'))).toBe('pak_1');
    expect(launchAutoCreativeLabel(multi('pak_1'))).toBe('c10+1');
    // One creative is its own name, whatever is stored.
    expect(launchCreativeLabel({ creativeAlias: 'c10', creativeLabel: 'pak_1' })).toBe('c10');
  });

  it('turns what is typed into the SUB alphabet', () => {
    expect(launchCreativeLabelInput('пак 1')).toBe('pak_1');
    expect(launchCreativeLabelInput('Пак ')).toBe('Pak_');
    expect(launchCreativeLabelInput(' пак 1 ', true)).toBe('pak_1');
    expect(launchCreativeLabelInput('10+13 / тест!')).toBe('10+13__test');
    expect(launchCreativeLabelInput('a'.repeat(200))).toHaveLength(80);
    expect(normalizeLaunchCreativeLabel('pak 1')).toBe('pak_1');
    expect(normalizeLaunchCreativeLabel('пак')).toBeNull();
  });

  it('is kept exactly by the config parser, and a broken one is refused', () => {
    const parsed = parseLaunchConfig(multi('pak_1'));
    expect(parsed.ok && parsed.value.creativeLabel).toBe('pak_1');
    // Admission compares the parsed config with the stored draft: nothing may be rewritten.
    for (const bad of ['pak 1', '', 'пак', 'a'.repeat(81)]) {
      const refused = parseLaunchConfig(multi(bad));
      expect(refused.ok ? null : refused.errors.creativeLabel, bad).toBe('LAUNCH_SUB_INVALID');
    }
    expect(parseLaunchDraft({ creativeLabel: 'pak_1' })?.creativeLabel).toBe('pak_1');
  });

  it('goes into SUB «Креатив», the link and the campaign names', () => {
    const preview = launchPreview(multi('10+13-pak'), sources);
    if (!preview.ok) throw new Error(JSON.stringify(preview.errors));
    expect(preview.value.subValues.sub3).toBe('10+13-pak');
    expect(preview.value.subValues.sub2).toBe('g1-10+13-pak');
    expect(preview.value.advertisingUrl).toContain('sub3=10%2B13-pak');
    expect(new URL(preview.value.advertisingUrl).searchParams.get('sub3')).toBe('10+13-pak');
    expect(preview.value.campaigns.every(c => c.name.includes('-10+13-pak-c]'))).toBe(true);
    expect(launchNamingPreview(multi('pak_1'), sources)[0]?.name).toContain('-pak_1-c]');
    expect(launchNamingPreview(multi(), sources)[0]?.name).toContain('-c10+1-c]');
    expect(launchSubPreview(multi().subConfig, 'pak_1', sources).sub3).toBe('pak_1');
  });

  it('goes away with the second creative and stays while there are several', () => {
    const config = multi('pak_1');
    expect(creativesPatch(config, [creative(10, 4)], 'video')).toHaveProperty(
      'creativeLabel',
      undefined
    );
    expect(creativesPatch(config, [], null)).toHaveProperty('creativeLabel', undefined);
    expect(
      'creativeLabel' in
        creativesPatch(config, [creative(10, 2), creative(13, 1), creative(14, 1)], 'video')
    ).toBe(false);
  });
});

describe('the field', () => {
  beforeEach(() => localStorage.setItem('language', 'en'));
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  function Field({ automatic, spy }: { automatic: string; spy: (v: string | undefined) => void }) {
    const [value, setValue] = useState<string | undefined>();
    return (
      <LaunchCreativeLabelField
        value={value}
        automatic={automatic}
        disabled={false}
        onChange={next => {
          spy(next);
          setValue(next);
        }}
      />
    );
  }

  it('shows the automatic name and follows the list until typed', () => {
    const spy = vi.fn();
    const { rerender } = render(<Field automatic="c10+1" spy={spy} />);
    const input = screen.getByLabelText('Creatives name') as HTMLInputElement;
    expect(input.value).toBe('c10+1');
    rerender(<Field automatic="c10+2" spy={spy} />);
    expect(input.value).toBe('c10+2');
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('keeps a typed name, transliterated, and gives the automatic one back on reset', () => {
    const spy = vi.fn();
    const { rerender } = render(<Field automatic="c10+1" spy={spy} />);
    const input = screen.getByLabelText('Creatives name') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'пак 1' } });
    expect(input.value).toBe('pak_1');
    fireEvent.blur(input);
    expect(spy).toHaveBeenLastCalledWith('pak_1');
    // A list change no longer renames it.
    rerender(<Field automatic="c10+2" spy={spy} />);
    expect(input.value).toBe('pak_1');
    expect(screen.getByText(/Automatic — c10\+2/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(spy).toHaveBeenLastCalledWith(undefined);
    expect(input.value).toBe('c10+2');
  });

  it('reads an emptied field as the automatic name', () => {
    const spy = vi.fn();
    render(<Field automatic="c10+1" spy={spy} />);
    const input = screen.getByLabelText('Creatives name') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    fireEvent.blur(input);
    expect(spy).toHaveBeenLastCalledWith(undefined);
    expect(input.value).toBe('c10+1');
  });
});
