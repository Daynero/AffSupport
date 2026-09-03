import type { ComponentType } from 'react';
import type { SotyToolId } from '@video-compressor/shared';
import type { AnalyticsTool } from '../analytics/events';
import type { TranslationKey } from '../i18n';
import { isProtected, type FeatureId } from './feature-flags';
import {
  CompressorIcon,
  LandingIcon,
  LandingPreviewIcon,
  StitcherIcon,
  TranscriptionIcon,
  TwoFactorIcon
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
const StitcherPage = lazy(() => import('../stitcher/StitcherPage'));
const TwoFactorPage = lazy(() => import('../two-factor/TwoFactorPage'));

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

/**
 * A tool that runs entirely in the browser and asks the local app for nothing.
 *
 * These ids are deliberately NOT in `WEB_TOOL_REQUIREMENTS`. That map is the set
 * of agent contracts a tool page needs, and `verify-release.mjs` byte-compares
 * it against the signed, published `stable.json` — so adding a key there blocks
 * `deploy:web` until an agent release publishes it. That gate is right for a
 * tool that needs the agent and exactly wrong for one that does not: it would
 * hold a browser-only page hostage to a release it has no stake in.
 */
export type BrowserToolId = 'twoFactor';

/**
 * Where a tool actually runs.
 *
 * `'agent'` tools are gated on a connected, compatible local app — the
 * capability check, the setup dialog, the whole path that existed before this
 * field. `'browser'` tools skip all of it: there is nothing to install, so an
 * offer to install something would be a lie.
 */
export type WebToolRuntime = 'agent' | 'browser';

type WebToolShared = {
  /** Kebab-case identifier used by analytics events and route classification. */
  analyticsId: AnalyticsTool;
  path: `/${string}`;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  icon: ComponentType;
  /** Web-only acknowledgment gate; null when the tool has no flag. */
  featureFlag: FeatureId | null;
  status: WebToolStatus;
  /** Rendered synchronously inside the ProtectedSoty chunk. */
  page: ComponentType;
};

export type AgentWebTool = WebToolShared & {
  runtime: 'agent';
  /** Canonical id, aligned with the SotyToolId agent contract. */
  id: SotyToolId;
  /**
   * Agent capability the tool needs. Capability tools render their own
   * pairing/onboarding while disconnected instead of the generic setup dialog,
   * and a connected agent without the capability redirects home.
   */
  capability: string | null;
};

export type BrowserWebTool = WebToolShared & {
  runtime: 'browser';
  id: BrowserToolId;
  /**
   * Absent by construction. A browser tool has no agent capability to wait for,
   * and `runtime` is the discriminant that keeps the capability checks — and
   * `toolAvailable`, whose argument is a `SotyToolId` — off this branch at the
   * type level rather than by remembering to check.
   */
  capability?: never;
};

/**
 * Discriminated on `runtime`, so a branch that has established "this is an agent
 * tool" also has a `SotyToolId` in hand, and a browser tool cannot be passed to
 * a capability check by accident.
 */
export type WebTool = AgentWebTool | BrowserWebTool;

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
    runtime: 'agent',
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
    runtime: 'agent',
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
    runtime: 'agent',
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
    // Placed next to the compressor: the two share a screen library and answer the same
    // question — "same video, new photo" goes here, "make it smaller" goes there.
    id: 'stitcher',
    runtime: 'agent',
    analyticsId: 'stitcher',
    path: '/stitcher',
    labelKey: 'videoStitcher',
    descriptionKey: 'videoStitcherDescription',
    icon: StitcherIcon,
    featureFlag: 'videoStitcher',
    status: statusFor('videoStitcher'),
    capability: 'stitcher',
    page: StitcherPage
  },
  {
    // The first tool in the catalogue that runs entirely in the browser. It sits
    // after the stitcher because it answers a different question from the media
    // tools above it, and because the tile order is the reading order.
    id: 'twoFactor',
    runtime: 'browser',
    analyticsId: 'two-factor',
    path: '/2fa',
    labelKey: 'twoFactorNotebook',
    descriptionKey: 'twoFactorNotebookDescription',
    icon: TwoFactorIcon,
    featureFlag: 'twoFactorNotebook',
    status: statusFor('twoFactorNotebook'),
    page: TwoFactorPage
  },
  {
    id: 'transcription',
    runtime: 'agent',
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
