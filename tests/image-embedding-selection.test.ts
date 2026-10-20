import { imageSelectionSupported, AGENT_TOOL_CONTRACTS } from '../packages/shared/src/release.js';
import { expect, it } from 'vitest';
import {
  activeEmbeddingImages,
  imageEmbeddingSelectionError,
  defaultImageEmbeddingSettings
} from '../packages/shared/src/types.js';
import { freezeImageEmbedding } from '../apps/agent/src/images/embedding.js';
import { parseSettingsPatch } from '../apps/agent/src/compressor/settings-validation.js';
import { makeEmbeddingSettings } from './helpers.js';
const image = (id: string) => ({
  id,
  fileName: `${id}.png`,
  path: `/tmp/${id}.png`,
  width: 10,
  height: 10,
  size: 10,
  mimeType: 'image/png' as const,
  extension: '.png' as const
});
it('pins a specific image for both estimation and frozen execution', () => {
  const settings = makeEmbeddingSettings({
    enabled: true,
    startImages: [image('a'), image('b')],
    selectedStartImageId: 'b'
  });
  expect(activeEmbeddingImages(settings, 'start').map(asset => asset.id)).toEqual(['b']);
  const frozen = freezeImageEmbedding(settings);
  settings.selectedStartImageId = 'a';
  expect(frozen?.startImage?.id).toBe('b');
});
it('retains legacy random pools but never substitutes a missing or disabled explicit choice', () => {
  const settings = makeEmbeddingSettings({ startImages: [image('a'), image('b')] });
  expect(activeEmbeddingImages(settings, 'start')).toHaveLength(2);
  settings.selectedStartImageId = 'missing';
  expect(activeEmbeddingImages(settings, 'start')).toEqual([]);
  expect(imageEmbeddingSelectionError({ ...settings, enabled: true })).toBe('start');
  settings.selectedStartImageId = 'a';
  settings.disabledImageIds = ['a'];
  expect(activeEmbeddingImages(settings, 'start')).toEqual([]);
  expect(imageEmbeddingSelectionError({ ...settings, enabled: true })).toBe('start');
  settings.startEnabled = false;
  expect(activeEmbeddingImages(settings, 'start')).toEqual([]);
});
it('validates explicit IDs at the settings boundary and supports returning to random', () => {
  const current = makeEmbeddingSettings({ startImages: [image('a')] });
  expect(
    parseSettingsPatch({ imageEmbedding: { selectedStartImageId: 'missing' } }, current).ok
  ).toBe(false);
  expect(parseSettingsPatch({ imageEmbedding: { selectedStartImageId: 'a' } }, current).ok).toBe(
    true
  );
  expect(parseSettingsPatch({ imageEmbedding: { selectedStartImageId: null } }, current).ok).toBe(
    true
  );
  expect(defaultImageEmbeddingSettings().selectedStartImageId).toBeNull();
});

it('gates the optional control for old agents without disabling their existing image tool', () => {
  expect(imageSelectionSupported(null)).toBe(false);
  expect(imageSelectionSupported({ imageEmbedding: 2 })).toBe(false);
  expect(imageSelectionSupported({ imageSelection: 1 })).toBe(true);
  expect(imageSelectionSupported({ imageSelection: 2 })).toBe(true);
  expect(AGENT_TOOL_CONTRACTS.imageEmbedding).toBe(2);
});
