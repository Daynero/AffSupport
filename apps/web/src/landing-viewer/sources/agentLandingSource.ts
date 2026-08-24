import type { LandingPreviewEvent, LandingPreviewState } from '@video-compressor/shared';
import {
  landingGalleryActivate,
  landingGalleryCancel,
  landingGalleryClearCache,
  toolEventUrl,
  landingGalleryImageUrl,
  landingGalleryOpen,
  landingGalleryOpenExtracted,
  landingGalleryRefresh,
  landingGalleryRemoveCatalog,
  landingGalleryResolveDrop,
  landingGalleryReveal,
  landingGallerySelect,
  landingGallerySettings,
  request
} from '../../api/client';
import type { LandingViewerSource } from '../types';

import { streamClient } from '../../api/stream-client';

/**
 * The local, agent-backed {@link LandingViewerSource}: wraps the existing `api/client` landing
 * endpoints 1:1. It advertises every capability. The `subscribe` implementation intentionally
 * reproduces the original raw `EventSource` behaviour (no auto-reconnect; status flips to `open`
 * on connect and on every frame, `lost` on error) so the extraction is behaviour-preserving.
 */
export function agentLandingSource(multiplexed = false): LandingViewerSource {
  return {
    capabilities: {
      chooseFolder: true,
      openPaths: true,
      refresh: true,
      cancel: true,
      reveal: true,
      openExtracted: true,
      clearCache: true,
      removeCatalog: true,
      settings: true
    },
    fetchState: signal => request<LandingPreviewState>('/api/landing-preview/state', 'GET', signal),
    subscribe: ({ onState, onStatus }) => {
      // The shared connection when the agent offers one. This page opening a socket of its
      // own is one of the seven the multiplexed stream replaces, and — because it is built
      // outside React — the one place that cannot read the capability from context, so it is
      // told instead.
      if (multiplexed) {
        onStatus?.('open');
        return streamClient.subscribe('landing-preview', event => {
          onStatus?.('open');
          onState((event as LandingPreviewEvent).state);
        });
      }

      const source = new EventSource(toolEventUrl('landing-preview'));
      source.onmessage = event => {
        onStatus?.('open');
        try {
          onState((JSON.parse(event.data) as LandingPreviewEvent).state);
        } catch {
          // Ignore a malformed frame; the next snapshot restores the state.
        }
      };
      source.onopen = () => onStatus?.('open');
      source.onerror = () => onStatus?.('lost');
      return () => source.close();
    },
    imageUrl: (item, segment) => landingGalleryImageUrl(item.id, item.renderedAt, segment),
    activate: landingGalleryActivate,
    chooseFolder: landingGallerySelect,
    openPaths: landingGalleryOpen,
    resolveDroppedFolder: landingGalleryResolveDrop,
    refresh: landingGalleryRefresh,
    cancel: landingGalleryCancel,
    reveal: landingGalleryReveal,
    openExtracted: landingGalleryOpenExtracted,
    clearCache: landingGalleryClearCache,
    removeCatalog: landingGalleryRemoveCatalog,
    updateSettings: landingGallerySettings
  };
}
