import type { ComponentType } from 'react';
import type { SotyToolId } from '@video-compressor/shared';
import type { AnalyticsTool } from '../analytics/events';
import type { TranslationKey } from '../i18n';
import { isProtected, type FeatureId } from './feature-flags';
import {
  CompressorIcon,
  LandingIcon,
  LandingPreviewIcon,
  TranscriptionIcon
} from '../components/tool-icons';
import { lazy } from 'react';

/**
 * Tool pages are loaded when a tool is opened, not when the application is.
 *
 * Four full pages — a compressor, two landing tools and a transcription editor
 * with its own text engine — were in the first download for everyone, including
 * someone who came to use exactly one of them. Nothing here is shared enough to
 * justify that: each page is reached by its own route, and the router already
 * renders one at a time.
 *
 * `lazy` needs a Suspense boundary, which ProtectedSoty provides around the
 * viewport where these render.
 */
const CompressorPage = lazy(() => import('../App'));
const LandingOptimizerPage = lazy(() => import('../landing/LandingOptimizerPage'));
const LandingPreviewPage = lazy(() => import('../landing-preview/LandingPreviewPage'));
const TranscriptionPage = lazy(() => import('../transcription/TranscriptionPage'));

// The single source of truth for the Soty web tools. Adding a tool here
// registers its route (ProtectedSoty), its home-page tile (HomePage) and its
// path classification (routeKind) in one step.
//
// Pages are imported statically on purpose: this module is only reachable
// through the lazily loaded ProtectedSoty chunk, so every page stays in that
// one chunk — exactly as before the registry existed. Importing this module
// from eagerly loaded code (Root, main) would pull all tool pages into the
// entry bundle; keep such code off the registry.

export type WebToolStatus = 'available' | 'beta' | 'coming-soon' | 'in-development';

export type WebTool = {
  /** Canonical id, aligned with the SotyToolId agent contract. */
  id: SotyToolId;
  /** Kebab-case identifier used by analytics events and route classification. */
  analyticsId: AnalyticsTool;
  path: `/${string}`;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  icon: ComponentType;
  /** Web-only acknowledgment gate; null when the tool has no flag. */
  featureFlag: FeatureId | null;
  status: WebToolStatus;
  /**
   * Agent capability the tool needs. Capability tools render their own
   * pairing/onboarding while disconnected instead of the generic setup dialog,
   * and a connected agent without the capability redirects home.
   */
  capability: string | null;
  /** Rendered synchronously inside the ProtectedSoty chunk. */
  page: ComponentType;
};

/**
 * A tool ships as 'in-development' while its feature flag is still protected;
 * flipping the flag in feature-flags.ts releases it without touching the
 * registry. 'coming-soon' entries would set their status explicitly.
 */
function statusFor(featureFlag: FeatureId | null): WebToolStatus {
  return featureFlag && isProtected(featureFlag) ? 'in-development' : 'available';
}

// Order defines the home-page tile order.
export const webTools: readonly WebTool[] = [
  {
    id: 'compressor',
    analyticsId: 'compressor',
    path: '/compressor',
    labelKey: 'videoCompressor',
    descriptionKey: 'videoCompressorDescription',
    icon: CompressorIcon,
    featureFlag: 'videoCompressor',
    status: statusFor('videoCompressor'),
    capability: null,
    page: CompressorPage
  },
  {
    // The Landing Optimizer stays visible in the catalogue before the local
    // app is installed. Agent capabilities only determine whether it opens.
    id: 'landingOptimizer',
    analyticsId: 'landing-optimizer',
    path: '/landing-optimizer',
    labelKey: 'landingOptimizer',
    descriptionKey: 'landingOptimizerDescription',
    icon: LandingIcon,
    featureFlag: 'landingOptimizer',
    status: statusFor('landingOptimizer'),
    capability: 'landing',
    page: LandingOptimizerPage
  },
  {
    id: 'landingPreview',
    analyticsId: 'landing-preview',
    path: '/landing-preview',
    labelKey: 'landingGallery',
    descriptionKey: 'landingGalleryDescription',
    icon: LandingPreviewIcon,
    featureFlag: 'landingPreview',
    status: statusFor('landingPreview'),
    capability: 'landing-preview',
    page: LandingPreviewPage
  },
  {
    id: 'transcription',
    analyticsId: 'transcription',
    path: '/transcription',
    labelKey: 'transcription',
    descriptionKey: 'transcriptionDescription',
    icon: TranscriptionIcon,
    featureFlag: 'transcription',
    status: 'beta',
    capability: null,
    page: TranscriptionPage
  }
];

export function toolByPath(path: string): WebTool | undefined {
  return webTools.find(tool => tool.path === path);
}

/** Classifies a pathname as a registered tool route or the home screen. */
export function routeKind(path: string): 'home' | AnalyticsTool {
  return toolByPath(path)?.analyticsId ?? 'home';
}
