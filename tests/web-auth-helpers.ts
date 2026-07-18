import {
  DEFAULT_CRF,
  DEFAULT_VIDEO_BITRATE_KBPS,
  defaultImageEmbeddingSettings,
  type QueueState
} from '../packages/shared/src/types';

export const emptyQueueState: QueueState = {
  jobs: [],
  running: false,
  tools: { ffmpeg: true, ffprobe: true },
  settings: {
    mode: 'optimal',
    outputMode: 'next-to-originals',
    outputFolder: null,
    frameRate: null,
    resolutionLimit: null,
    rateControl: 'crf',
    crf: DEFAULT_CRF,
    videoBitrateKbps: DEFAULT_VIDEO_BITRATE_KBPS,
    imageEmbedding: defaultImageEmbeddingSettings()
  },
  batch: null,
  warning: null
};
