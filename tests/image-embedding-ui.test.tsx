// @vitest-environment jsdom

import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  formatTimeInput,
  isSupportedImageFile,
  parseTimeInput
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

describe('image embedding settings UI', () => {
  it('keeps the compact section hidden until the switch is enabled', async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<SettingsHarness />);
    expect(screen.queryByText('Opening frame')).toBeNull();
    await user.click(screen.getByText('Embed images into video'));
    expect(screen.getByText('Opening frame')).toBeTruthy();
    expect(screen.getByText('Final image')).toBeTruthy();
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
            startImage: asset('opening.png'),
            endImage: asset('ending.webp', 'asset-2')
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
    expect(updateSettings.mock.calls.at(-1)?.[0]).not.toHaveProperty('imageEmbedding.startImage');
    expect(updateSettings.mock.calls.at(-1)?.[0]).not.toHaveProperty('imageEmbedding.endImage');
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
    const first = new File(['png'], 'opening image.png', { type: 'image/png' });
    await user.upload(input, first);
    expect(uploaded).toHaveLength(1);
    expect(screen.getByText('opening image.png')).toBeTruthy();
    expect(screen.getByText('640×360')).toBeTruthy();
    expect(document.querySelector('img')?.getAttribute('src')).toContain('asset-1');

    const second = new File(['webp'], 'replacement.webp', { type: 'image/webp' });
    fireEvent.drop(screen.getByRole('group'), { dataTransfer: { files: [second] } });
    await waitFor(() => expect(uploaded).toHaveLength(2));
    expect(uploaded[1]).toMatchObject({ slot: 'start', file: second });
    expect(screen.getByText('replacement.webp')).toBeTruthy();
  });

  it('supports obvious replacement and removal actions', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const onRemove = vi.fn(async () => {});
    render(<ImageAreaHarness initial={asset('existing.png')} onRemove={onRemove} />);
    await user.click(screen.getByRole('button', { name: 'Replace' }));
    await user.upload(
      screen.getByLabelText('Choose opening-frame image'),
      new File(['jpeg'], 'new photo.jpg', { type: 'image/jpeg' })
    );
    expect(screen.getByText('new photo.jpg')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onRemove).toHaveBeenCalledWith('start');
    expect(screen.getByText('Drag an image here or choose a file')).toBeTruthy();
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

  it('supports every duration range, validates custom HH:MM:SS, and switches fit modes', async () => {
    const user = userEvent.setup();
    const validity = vi.fn();
    render(<SettingsHarness enabled endImage={asset('end.webp')} onValidity={validity} />);
    const duration = screen.getByLabelText('Final image duration');
    for (const value of ['random-30-40', 'random-40-50', 'random-50-60']) {
      await user.selectOptions(duration, value);
      expect((duration as HTMLSelectElement).value).toBe(value);
    }
    await user.selectOptions(duration, 'custom');
    const custom = screen.getByLabelText('Custom duration in HH:MM:SS format');
    await user.clear(custom);
    await user.type(custom, '00:00:00');
    expect(screen.getByText(/valid time greater than 00:00:00/)).toBeTruthy();
    await user.clear(custom);
    await user.type(custom, '01:02:03');
    await waitFor(() => expect(validity).toHaveBeenLastCalledWith(true));

    const fit = screen.getByLabelText('Frame fit');
    for (const value of ['cover', 'contain', 'stretch']) {
      await user.selectOptions(fit, value);
      expect((fit as HTMLSelectElement).value).toBe(value);
    }
    expect(screen.getByText('Stretching can distort the image proportions.')).toBeTruthy();
  });

  it('does not require a final-image duration when only the opening frame is selected', async () => {
    const user = userEvent.setup();
    const validity = vi.fn();
    render(<SettingsHarness enabled startImage={asset('opening.png')} onValidity={validity} />);
    await user.selectOptions(screen.getByLabelText('Final image duration'), 'custom');
    const custom = screen.getByLabelText('Custom duration in HH:MM:SS format');
    await user.clear(custom);
    await user.type(custom, '00:00:00');
    await waitFor(() => expect(validity).toHaveBeenLastCalledWith(true));
  });

  it('preserves selected images and settings when the language changes', () => {
    const settings = {
      ...optimalSettings,
      imageEmbedding: {
        ...defaultImageEmbeddingSettings(),
        enabled: true,
        startImage: asset('opening.png'),
        fitMode: 'contain' as const
      }
    };
    const view = render(
      <SettingsPanel
        settings={settings}
        disabled={false}
        updateSettings={() => {}}
        chooseOutputFolder={() => {}}
        imageUrl={id => `preview://${id}`}
        t={t('en')}
      />
    );
    expect(screen.getByText('opening.png')).toBeTruthy();
    view.rerender(
      <SettingsPanel
        settings={settings}
        disabled={false}
        updateSettings={() => {}}
        chooseOutputFolder={() => {}}
        imageUrl={id => `preview://${id}`}
        t={t('uk')}
      />
    );
    expect(screen.getByText('opening.png')).toBeTruthy();
    expect(screen.getByText('Вмістити повністю')).toBeTruthy();
    expect(settings.imageEmbedding.startImage?.id).toBe('asset-1');
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
        fitMode: 'cover'
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
    expect(parseTimeInput('00:00:01')).toBe(1);
    expect(parseTimeInput('01:02:03')).toBe(3723);
    expect(parseTimeInput('99:59:59')).toBe(359_999);
    expect(parseTimeInput('00:60:00')).toBeNull();
    expect(parseTimeInput('00:00:00')).toBeNull();
    expect(formatTimeInput(3723)).toBe('01:02:03');
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
    imageEmbedding: { ...defaultImageEmbeddingSettings(), enabled, startImage, endImage }
  });
  return (
    <SettingsPanel
      settings={settings}
      disabled={false}
      updateSettings={patch => setSettings(current => mergeSettings(current, patch))}
      chooseOutputFolder={() => {}}
      uploadImage={async () => {}}
      removeImage={async () => {}}
      imageUrl={id => `preview://${id}`}
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
  onRemove?: (slot: ImageSlot) => Promise<void>;
}) {
  const [selected, setSelected] = useState(initial);
  let nextId = 1;
  return (
    <ImageDropArea
      slot="start"
      asset={selected}
      disabled={false}
      uploadImage={async (slot, file) => {
        await onUpload(slot, file);
        setSelected(asset(file.name, `asset-${nextId++}`));
      }}
      removeImage={async slot => {
        await onRemove(slot);
        setSelected(null);
      }}
      imageUrl={id => `preview://${id}`}
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
