import type { LandingPreviewPhase } from '@video-compressor/shared';
import type { TranslationKey } from '../../i18n';

export function phaseKey(phase: LandingPreviewPhase): TranslationKey {
  const keys: Record<LandingPreviewPhase, TranslationKey> = {
    idle: 'landingGalleryPhaseIdle',
    scanning: 'landingGalleryPhaseScanning',
    downloading: 'landingGalleryPhaseDownloading',
    inspecting: 'landingGalleryPhaseInspecting',
    extracting: 'landingGalleryPhaseExtracting',
    rendering: 'landingGalleryPhaseRendering',
    completed: 'landingGalleryPhaseCompleted',
    cancelled: 'landingGalleryPhaseCancelled',
    failed: 'landingGalleryPhaseFailed'
  };
  return keys[phase];
}
