import { expect, it } from 'vitest';
import { safeBatchProperties } from '../apps/web/src/analytics/compression';
import { makeJob, optimalSettings } from './helpers';

it('reports aggregate batch intent without collecting file paths or image identifiers', () => {
  const properties = safeBatchProperties(
    {
      ...optimalSettings,
      frameRate: 30,
      resolutionLimit: 1080,
      imageEmbedding: {
        ...optimalSettings.imageEmbedding,
        enabled: true,
        selectedStartImageId: 'private-start-image',
        selectedEndImageId: 'private-end-image'
      }
    },
    [
      makeJob('synthetic-first', 'ready', { originalSize: 100 }),
      makeJob('synthetic-second', 'ready', { originalSize: -1 })
    ],
    'synthetic-run'
  );
  expect(properties).toMatchObject({
    run_id: 'synthetic-run',
    video_count: 2,
    total_input_bytes: 100,
    output_fps: 30,
    target_resolution: 1080,
    image_embedding: true,
    explicit_start_image: true,
    explicit_end_image: true,
    tool_identifier: 'compressor'
  });
  expect(JSON.stringify(properties)).not.toMatch(/private-|synthetic-first|synthetic-second|\/tmp/);
  const empty = safeBatchProperties({ ...optimalSettings, rateControl: 'bitrate' }, []);
  expect(empty).toMatchObject({ video_count: 0, total_input_bytes: 0 });
  expect(empty).not.toHaveProperty('run_id');
  expect(empty).not.toHaveProperty('crf');
  expect(empty).not.toHaveProperty('output_fps');
});
