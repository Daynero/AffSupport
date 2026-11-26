import { describe, expect, it } from 'vitest';
import { parseStep } from '../scripts/lib/native-update-capture.mjs';

/** The packaged-beta recorder accepts only its closed step language (052 qualification). */
describe('native update capture steps', () => {
  it('parses stage-bound actions', () => {
    expect(parseStep('prepared:accept')).toEqual({ stage: 'prepared', action: 'accept' });
    expect(parseStep('*:relaunch')).toEqual({ stage: '*', action: 'relaunch' });
    expect(parseStep('install_committed:freeze-new-agent')).toEqual({
      stage: 'install_committed',
      action: 'freeze-new-agent'
    });
    expect(parseStep('prepared:wait=2500')).toEqual({
      stage: 'prepared',
      action: 'wait',
      ms: 2500
    });
    expect(parseStep('prepared:power=20')).toEqual({
      stage: 'prepared',
      action: 'power',
      percent: 20
    });
    expect(parseStep('draining:get=/api/queue')).toEqual({
      stage: 'draining',
      action: 'get',
      route: '/api/queue'
    });
    expect(parseStep('prepared:upload=/api/files/upload@/tmp/a b.mp4@2500000')).toEqual({
      stage: 'prepared',
      action: 'upload',
      route: '/api/files/upload',
      file: '/tmp/a b.mp4',
      rate: 2500000
    });
    expect(parseStep('prepared:stitch-start=unstitch')).toEqual({
      stage: 'prepared',
      action: 'stitch-start',
      operation: 'unstitch'
    });
  });

  it('refuses unknown stages, actions and routes outside the API', () => {
    for (const raw of [
      'accept',
      'nowhere:accept',
      'prepared:format-disk',
      'prepared:get=/native/update/drain',
      'prepared:post=/api/queue@relative.json',
      'prepared:run=relative.mjs',
      'prepared:stitch-start=delete'
    ])
      expect(() => parseStep(raw)).toThrow('NATIVE_PROBE_STEP_INVALID');
  });
});
