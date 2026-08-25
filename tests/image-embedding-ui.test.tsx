// @vitest-environment jsdom

import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  defaultImageEmbeddingSettings,
  type AgentSettings,
  type AgentSettingsPatch,
  type ImageAsset,
  type ImageSlot
} from '../packages/shared/src/types.js';
import {
  ImageDropArea,
  formatMinutesInput,
  isSupportedImageFile,
  parseMillisecondsInput,
  parseMinutesInput
} from '../apps/web/src/components/ImageEmbeddingSection';
import { SettingsPanel } from '../apps/web/src/components/SettingsPanel';
import { JobRow } from '../apps/web/src/components/JobRow';
import { translate, type Language } from '../apps/web/src/i18n';
import type { Translate } from '../apps/web/src/components/ui';
import { makeJob, optimalSettings } from './helpers.js';
import { mergeSettingsPatches } from '../apps/web/src/settings-patch';

const t =
  (language: Language): Translate =>
  (key, values) =>
    translate(language, key, values);
afterEach(cleanup);

/**
 * Thumbnails carry a capability ticket now, so the component asks the local app
 * for one before it has a URL to render. Stubbed here rather than left
 * unmocked: without it every image in these tests renders as nothing, and the
 * failures read as missing markup instead of a missing round trip.
 */
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ ticket: '9999999999.stub', expiresInMs: 300_000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('image embedding settings UI', () => {
  it('keeps the compact section hidden until the switch is enabled', async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<SettingsHarness />);
    // The panel stays mounted for a smooth expand animation but is hidden
    // from assistive technology until the switch is enabled.
    const hiddenPanel = screen.getByText('Opening frame').closest('.collapse');
    expect(hiddenPanel?.getAttribute('aria-hidden')).toBe('true');
    expect(hiddenPanel?.classList.contains('is-open')).toBe(false);
    await user.click(screen.getByText('Embed images into video'));
    expect(
      screen.getByText('Opening frame').closest('.collapse')?.getAttribute('aria-hidden')
    ).toBe(null);
    expect(
      screen.getByText('Opening frame').closest('.collapse')?.classList.contains('is-open')
    ).toBe(true);
    expect(screen.getByText('Opening frame')).toBeTruthy();
    expect(screen.getByText('Final image')).toBeTruthy();
    expect(screen.getByText('Replace existing')).toBeTruthy();
    expect(
      screen.getByText('Add at least one image or turn this option off before starting.')
    ).toBeTruthy();
  });

  it('sends only writable image settings when the switch is clicked', async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn();
    render(
      <SettingsPanel
        settings={{
          ...optimalSettings,
          imageEmbedding: {
            ...defaultImageEmbeddingSettings(),
            startImages: [asset('opening.png')],
            endImages: [asset('ending.webp', 'asset-2')]
          }
        }}
        disabled={false}
        updateSettings={updateSettings}
        chooseOutputFolder={() => {}}
        t={t('en')}
      />
    );

    await user.click(screen.getByText('Embed images into video'));

    expect(updateSettings.mock.calls.at(-1)?.[0]).toEqual({
      imageEmbedding: { enabled: true }
    });
    expect(updateSettings.mock.calls.at(-1)?.[0]).not.toHaveProperty('imageEmbedding.startImages');
    expect(updateSettings.mock.calls.at(-1)?.[0]).not.toHaveProperty('imageEmbedding.endImages');
  });

  it('merges debounced writable image settings without adding asset metadata', () => {
    expect(
      mergeSettingsPatches(
        { imageEmbedding: { customFinalDurationSeconds: 123 } },
        { imageEmbedding: { fitMode: 'contain' } }
      )
    ).toEqual({
      imageEmbedding: { customFinalDurationSeconds: 123, fitMode: 'contain' }
    });
  });

  it('updates the replace-existing option independently of image assets', async () => {
    const updateSettings = vi.fn();
    render(
      <SettingsPanel
        settings={{
          ...optimalSettings,
          imageEmbedding: {
            ...defaultImageEmbeddingSettings(),
            enabled: true,
            startImages: [asset('opening.png')]
          }
        }}
        disabled={false}
        updateSettings={updateSettings}
        chooseOutputFolder={() => {}}
        t={t('en')}
      />
    );

    await userEvent.click(screen.getByText('Replace existing'));
    expect(updateSettings.mock.calls.at(-1)?.[0]).toEqual({
      imageEmbedding: { replaceExisting: true }
    });
  });

  it('accepts file-picker and drag-and-drop images and shows preview metadata', async () => {
    const uploaded: Array<{ slot: ImageSlot; file: File }> = [];
    const user = userEvent.setup();
    render(
      <ImageAreaHarness
        onUpload={async (slot, file) => {
          uploaded.push({ slot, file });
        }}
      />
    );
    const input = screen.getByLabelText('Choose opening-frame image');
    expect(input.hasAttribute('multiple')).toBe(true);
    const first = new File(['png'], 'opening image.png', { type: 'image/png' });
    await user.upload(input, first);
    expect(uploaded).toHaveLength(1);
    expect(screen.getByAltText('opening image.png')).toBeTruthy();
    expect(screen.getByText('640×360')).toBeTruthy();
    expect(document.querySelector('img')?.getAttribute('src')).toContain('asset-1');

    const second = new File(['webp'], 'replacement.webp', { type: 'image/webp' });
    fireEvent.drop(screen.getByRole('group'), { dataTransfer: { files: [second] } });
    await waitFor(() => expect(uploaded).toHaveLength(2));
    expect(uploaded[1]).toMatchObject({ slot: 'start', file: second });
    expect(await screen.findByAltText('replacement.webp')).toBeTruthy();
    expect(screen.getByAltText('opening image.png')).toBeTruthy();
  });

  it('keeps the add action available and removes individual images', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const onRemove = vi.fn(async () => {});
    render(<ImageAreaHarness initial={asset('existing.png')} onRemove={onRemove} />);
    await user.click(screen.getByText('Add image'));
    await user.upload(
      screen.getByLabelText('Choose opening-frame image'),
      new File(['jpeg'], 'new photo.jpg', { type: 'image/jpeg' })
    );
    // Awaited, not read: each thumbnail resolves a capability ticket before it
    // has a URL, so it appears a tick after the row it belongs to.
    expect(await screen.findByAltText('existing.png')).toBeTruthy();
    expect(await screen.findByAltText('new photo.jpg')).toBeTruthy();
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    expect(onRemove).toHaveBeenCalledWith('start', 'asset-1');
    expect(screen.queryByAltText('existing.png')).toBeNull();
    expect(screen.getByAltText('new photo.jpg')).toBeTruthy();
  });

  it('rejects unsupported files before upload with a localized error', async () => {
    const upload = vi.fn(async () => {});
    const user = userEvent.setup({ applyAccept: false });
    render(<ImageAreaHarness onUpload={upload} />);
    await user.upload(
      screen.getByLabelText('Choose opening-frame image'),
      new File(['gif'], 'animation.gif', { type: 'image/gif' })
    );
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByText('Choose a PNG, JPG/JPEG or WebP image.')).toBeTruthy();
  });

  it('supports every duration range, validates custom minutes, and switches fit modes', async () => {
    const user = userEvent.setup();
    const validity = vi.fn();
    render(<SettingsHarness enabled endImage={asset('end.webp')} onValidity={validity} />);
    const duration = screen.getByLabelText('Final image duration');
    for (const value of ['random-30-40', 'random-40-50', 'random-50-60']) {
      await user.selectOptions(duration, value);
      expect((duration as HTMLSelectElement).value).toBe(value);
    }
    await user.selectOptions(duration, 'custom');
    const custom = screen.getByLabelText('Custom duration in minutes');
    expect(screen.getByText('minutes')).toBeTruthy();
    await user.clear(custom);
    await user.type(custom, '0');
    expect(screen.getByText(/whole number of minutes greater than 0/)).toBeTruthy();
    await user.clear(custom);
    await user.type(custom, '54');
    await waitFor(() => expect(validity).toHaveBeenLastCalledWith(true));

    const fit = screen.getByLabelText('Frame fit');
    for (const value of ['cover', 'contain', 'stretch']) {
      await user.selectOptions(fit, value);
      expect((fit as HTMLSelectElement).value).toBe(value);
    }
    expect(screen.getByText('Stretching can distort the image proportions.')).toBeTruthy();
  });

  it('offers short start-frame presets and validates a custom millisecond duration', async () => {
    const user = userEvent.setup();
    const validity = vi.fn();
    render(<SettingsHarness enabled startImage={asset('opening.png')} onValidity={validity} />);
    const duration = screen.getByLabelText('First frame duration');
    expect((duration as HTMLSelectElement).value).toBe('one-frame');
    for (const value of ['ms-2', 'ms-5', 'ms-10']) {
      await user.selectOptions(duration, value);
      expect((duration as HTMLSelectElement).value).toBe(value);
    }
    await user.selectOptions(duration, 'custom');
    const custom = screen.getByLabelText('Custom duration in milliseconds');
    await user.clear(custom);
    await user.type(custom, '0');
    expect(screen.getByText(/whole number of milliseconds from 1 to 60000/)).toBeTruthy();
    await waitFor(() => expect(validity).toHaveBeenLastCalledWith(false));
    await user.clear(custom);
    await user.type(custom, '250');
    await waitFor(() => expect(validity).toHaveBeenLastCalledWith(true));
  });

  it('does not require a final-image duration when only the opening frame is selected', async () => {
    const user = userEvent.setup();
    const validity = vi.fn();
    render(<SettingsHarness enabled startImage={asset('opening.png')} onValidity={validity} />);
    await user.selectOptions(screen.getByLabelText('Final image duration'), 'custom');
    const custom = screen.getByLabelText('Custom duration in minutes');
    await user.clear(custom);
    await user.type(custom, '0');
    await waitFor(() => expect(validity).toHaveBeenLastCalledWith(true));
  });

  it('preserves selected images and settings when the language changes', async () => {
    const settings = {
      ...optimalSettings,
      imageEmbedding: {
        ...defaultImageEmbeddingSettings(),
        enabled: true,
        startImages: [asset('opening.png')],
        fitMode: 'contain' as const
      }
    };
    const view = render(
      <SettingsPanel
        settings={settings}
        disabled={false}
        updateSettings={() => {}}
        chooseOutputFolder={() => {}}
        t={t('en')}
      />
    );
    // Awaited: the thumbnail resolves a capability ticket before it has a URL,
    // so it appears a tick after the row does.
    expect(await screen.findByAltText('opening.png')).toBeTruthy();
    view.rerender(
      <SettingsPanel
        settings={settings}
        disabled={false}
        updateSettings={() => {}}
        chooseOutputFolder={() => {}}
        t={t('uk')}
      />
    );
    expect(await screen.findByAltText('opening.png')).toBeTruthy();
    expect(screen.getByText('Вмістити повністю')).toBeTruthy();
    expect(settings.imageEmbedding.startImages[0]?.id).toBe('asset-1');
  });

  it('shows the concrete frozen duration and expected total in each video card', () => {
    const job = makeJob('embedded-card', 'queued', {
      durationSeconds: 10,
      sourceFrameRate: 30,
      imageEmbedding: {
        startImage: asset('opening.png'),
        endImage: asset('ending.webp', 'asset-2'),
        finalDurationMode: 'random-40-50',
        finalDurationSeconds: 2778,
        fitMode: 'cover',
        replaceExisting: false,
        sourceTrimStartSeconds: 0,
        sourceTrimEndSeconds: 0
      }
    });
    render(
      <JobRow
        job={job}
        selected={false}
        disabled={false}
        compressionRunning
        language="uk"
        onSelected={() => {}}
        action={() => {}}
        t={t('uk')}
      />
    );
    expect(screen.getByText('Зашивання')).toBeTruthy();
    expect(screen.getByText('Початок: 1 кадр')).toBeTruthy();
    expect(screen.getByText('Фінальне зображення: 46 хв 18 с')).toBeTruthy();
    expect(screen.getByText('Адаптація: Заповнити з обрізанням')).toBeTruthy();
    expect(screen.getByText('Очікувана тривалість: 00:46:28')).toBeTruthy();
  });
});

describe('image setting validation helpers', () => {
  it('validates image types and custom durations', () => {
    expect(isSupportedImageFile({ name: 'photo.JPEG', type: 'image/jpeg' })).toBe(true);
    expect(isSupportedImageFile({ name: 'photo.webp', type: '' })).toBe(true);
    expect(isSupportedImageFile({ name: 'photo.png', type: 'image/gif' })).toBe(false);
    expect(parseMinutesInput('1')).toBe(60);
    expect(parseMinutesInput('54')).toBe(3240);
    expect(parseMinutesInput('5999')).toBe(359_940);
    expect(parseMinutesInput('6000')).toBeNull();
    expect(parseMinutesInput('0')).toBeNull();
    expect(parseMinutesInput('12:00')).toBeNull();
    expect(formatMinutesInput(3240)).toBe('54');
    expect(parseMillisecondsInput('1')).toBe(1);
    expect(parseMillisecondsInput('250')).toBe(250);
    expect(parseMillisecondsInput('60000')).toBe(60_000);
    expect(parseMillisecondsInput('60001')).toBeNull();
    expect(parseMillisecondsInput('0')).toBeNull();
    expect(parseMillisecondsInput('5.5')).toBeNull();
  });
});

function SettingsHarness({
  enabled = false,
  startImage = null,
  endImage = null,
  onValidity = () => {}
}: {
  enabled?: boolean;
  startImage?: ImageAsset | null;
  endImage?: ImageAsset | null;
  onValidity?: (valid: boolean) => void;
}) {
  const [settings, setSettings] = useState<AgentSettings>({
    ...optimalSettings,
    imageEmbedding: {
      ...defaultImageEmbeddingSettings(),
      enabled,
      startImages: startImage ? [startImage] : [],
      endImages: endImage ? [endImage] : []
    }
  });
  return (
    <SettingsPanel
      settings={settings}
      disabled={false}
      updateSettings={patch => setSettings(current => mergeSettings(current, patch))}
      chooseOutputFolder={() => {}}
      uploadImages={async () => {}}
      removeImage={async () => {}}
      onEmbeddingValidityChange={onValidity}
      t={t('en')}
    />
  );
}

function ImageAreaHarness({
  initial = null,
  onUpload = async () => {},
  onRemove = async () => {}
}: {
  initial?: ImageAsset | null;
  onUpload?: (slot: ImageSlot, file: File) => Promise<void>;
  onRemove?: (slot: ImageSlot, id: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<ImageAsset[]>(initial ? [initial] : []);
  return (
    <ImageDropArea
      slot="start"
      assets={selected}
      disabled={false}
      uploadImages={async (slot, files) => {
        for (const file of files) await onUpload(slot, file);
        setSelected(current => [
          ...current,
          ...files.map((file, index) => asset(file.name, `asset-${current.length + index + 1}`))
        ]);
      }}
      removeImage={async (slot, id) => {
        await onRemove(slot, id);
        setSelected(current => current.filter(asset => asset.id !== id));
      }}
      t={t('en')}
    />
  );
}

function mergeSettings(current: AgentSettings, patch: AgentSettingsPatch): AgentSettings {
  return {
    ...current,
    ...patch,
    imageEmbedding: {
      ...current.imageEmbedding,
      ...patch.imageEmbedding
    }
  };
}

function asset(fileName: string, id = 'asset-1'): ImageAsset {
  const extension = fileName.endsWith('.webp')
    ? '.webp'
    : fileName.endsWith('.jpg')
      ? '.jpg'
      : '.png';
  return {
    id,
    fileName,
    width: 640,
    height: 360,
    size: 1234,
    mimeType:
      extension === '.webp' ? 'image/webp' : extension === '.jpg' ? 'image/jpeg' : 'image/png',
    extension
  };
}
