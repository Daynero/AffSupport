import { isRecord } from './contract.js';
import type { CatalogMaterialItem, CatalogSearchResponse } from './catalog-search.js';
import type { TeamTransferGrant } from './transport.js';

/** Shared contract for the team landings gallery (feature 004). */
export type LandingRenderState = 'rendering' | 'ready' | 'stale' | 'failed';

export type LandingRenderFailureReason =
  'unsupported' | 'corrupt' | 'protected' | 'too_large' | 'render_error';

/** Derived per-tile state. `ready` guarantees a currently fetchable render. */
export type LandingTileState =
  'ready' | 'candidate' | 'rendering' | 'needs_agent' | 'agent_outdated' | 'error';

export type LandingDevicePreset = 'desktop' | 'tablet' | 'mobile';
export type LandingColorScheme = 'light' | 'dark';

export const LANDING_RENDER_PRESET_DEFAULT = 'default';
export const LANDING_ZOOM_MIN = 0.25;
export const LANDING_ZOOM_MAX = 3;

export interface LandingViewerPreset {
  device: LandingDevicePreset;
  colorScheme: LandingColorScheme;
  zoom: number;
}

export const DEFAULT_LANDING_VIEWER_PRESET: LandingViewerPreset = {
  device: 'desktop',
  colorScheme: 'light',
  zoom: 1
};

/** Opaque handle used to fetch cached render bytes. No Drive path/id crosses the boundary. */
export interface RenderArtifactRef {
  materialId: string;
  sourceVersion: string;
  fingerprint: string;
  preset: string;
  segmentCount: number;
  artifactToken: string;
  /** One short-lived, segment-bound token per WebP segment. `artifactToken` is segment 0. */
  segmentTokens?: string[];
}

export interface LandingRenderPointer {
  materialId: string;
  state: LandingRenderState;
  failureReason?: LandingRenderFailureReason;
  sourceVersion: string;
  fingerprint: string;
  preset: string;
  artifact?: RenderArtifactRef;
}

export interface LandingGalleryItem {
  material: CatalogMaterialItem;
  isCandidate: boolean;
  tile: LandingTileState;
  render?: LandingRenderPointer;
  unavailableReason?: LandingRenderFailureReason;
  canDownload: boolean;
  canEdit: boolean;
}

export interface LandingGalleryPage {
  items: LandingGalleryItem[];
  total: number;
  freshness: CatalogSearchResponse['catalogFreshness'];
}

export interface TeamLandingRenderRequest {
  teamId: string;
  materialId: string;
  preset: LandingViewerPreset;
}

/** Browser-authorized, provider-credential-free job handed to the paired local agent. */
export interface TeamLandingRenderJob {
  operationId: string;
  renderId: string;
  teamId: string;
  materialId: string;
  preset: string;
  transferUrl: string;
  artifactUploadUrl: string;
  sourceGrant: TeamTransferGrant;
  artifactGrant: TeamTransferGrant;
}

export interface TeamLandingAgentRenderResult {
  renderId: string;
  state: 'ready';
  segmentCount: number;
  fingerprint: string;
}

export type TeamLandingRenderResult =
  { ok: true; pointer: LandingRenderPointer } | { ok: false; reason: LandingRenderFailureReason };

const DEVICES = new Set<LandingDevicePreset>(['desktop', 'tablet', 'mobile']);
const SCHEMES = new Set<LandingColorScheme>(['light', 'dark']);
const RENDER_STATES = new Set<LandingRenderState>(['rendering', 'ready', 'stale', 'failed']);
const FAILURE_REASONS = new Set<LandingRenderFailureReason>([
  'unsupported',
  'corrupt',
  'protected',
  'too_large',
  'render_error'
]);

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LANDING_VIEWER_PRESET.zoom;
  return Math.min(LANDING_ZOOM_MAX, Math.max(LANDING_ZOOM_MIN, value));
}

export function normalizeLandingViewerPreset(value: unknown): LandingViewerPreset {
  if (!isRecord(value)) return { ...DEFAULT_LANDING_VIEWER_PRESET };
  const device = DEVICES.has(value.device as LandingDevicePreset)
    ? (value.device as LandingDevicePreset)
    : DEFAULT_LANDING_VIEWER_PRESET.device;
  const colorScheme = SCHEMES.has(value.colorScheme as LandingColorScheme)
    ? (value.colorScheme as LandingColorScheme)
    : DEFAULT_LANDING_VIEWER_PRESET.colorScheme;
  const zoom =
    typeof value.zoom === 'number' ? clampZoom(value.zoom) : DEFAULT_LANDING_VIEWER_PRESET.zoom;
  return { device, colorScheme, zoom };
}

function parseArtifactRef(value: unknown): RenderArtifactRef | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.materialId !== 'string' ||
    typeof value.sourceVersion !== 'string' ||
    typeof value.fingerprint !== 'string' ||
    typeof value.preset !== 'string' ||
    typeof value.artifactToken !== 'string' ||
    typeof value.segmentCount !== 'number' ||
    !Number.isInteger(value.segmentCount) ||
    value.segmentCount < 1
  ) {
    return null;
  }
  const segmentTokens = value.segmentTokens;
  if (
    segmentTokens !== undefined &&
    (!Array.isArray(segmentTokens) ||
      segmentTokens.length !== value.segmentCount ||
      segmentTokens.some(token => typeof token !== 'string' || token.length < 16))
  ) {
    return null;
  }
  return {
    materialId: value.materialId,
    sourceVersion: value.sourceVersion,
    fingerprint: value.fingerprint,
    preset: value.preset,
    segmentCount: value.segmentCount,
    artifactToken: value.artifactToken,
    ...(segmentTokens ? { segmentTokens: [...segmentTokens] } : {})
  };
}

export function parseLandingRenderPointer(value: unknown): LandingRenderPointer | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.materialId !== 'string' ||
    typeof value.sourceVersion !== 'string' ||
    typeof value.fingerprint !== 'string' ||
    typeof value.preset !== 'string' ||
    !RENDER_STATES.has(value.state as LandingRenderState)
  ) {
    return null;
  }
  const state = value.state as LandingRenderState;
  const failureReason = FAILURE_REASONS.has(value.failureReason as LandingRenderFailureReason)
    ? (value.failureReason as LandingRenderFailureReason)
    : undefined;
  const artifact = state === 'ready' ? (parseArtifactRef(value.artifact) ?? undefined) : undefined;
  return {
    materialId: value.materialId,
    state,
    failureReason,
    sourceVersion: value.sourceVersion,
    fingerprint: value.fingerprint,
    preset: value.preset,
    artifact
  };
}

export function parseTeamLandingRenderResult(value: unknown): TeamLandingRenderResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) {
    const pointer = parseLandingRenderPointer(value.pointer);
    return pointer ? { ok: true, pointer } : null;
  }
  if (value.ok === false && FAILURE_REASONS.has(value.reason as LandingRenderFailureReason)) {
    return { ok: false, reason: value.reason as LandingRenderFailureReason };
  }
  return null;
}

export function isValidReadyRender(
  pointer: LandingRenderPointer | undefined,
  material: Pick<CatalogMaterialItem, 'id'> & { sourceVersion: string; fingerprint: string }
): pointer is LandingRenderPointer & { artifact: RenderArtifactRef } {
  return (
    !!pointer &&
    pointer.state === 'ready' &&
    !!pointer.artifact &&
    pointer.materialId === material.id &&
    pointer.sourceVersion === material.sourceVersion &&
    pointer.fingerprint === material.fingerprint
  );
}

export interface LandingTileContext {
  isCandidate: boolean;
  hasValidReadyRender: boolean;
  renderState?: LandingRenderState;
  failureReason?: LandingRenderFailureReason;
  agentPaired: boolean;
  agentCompatible: boolean;
}

/** Structural resolution guarantees zero false-ready states. */
export function resolveLandingTileState(ctx: LandingTileContext): LandingTileState {
  if (ctx.hasValidReadyRender) return 'ready';
  if (ctx.renderState === 'rendering') return 'rendering';
  if (ctx.renderState === 'failed') return 'error';
  if (ctx.isCandidate && !ctx.agentPaired) return 'candidate';
  if (ctx.agentPaired && !ctx.agentCompatible) return 'agent_outdated';
  if (!ctx.agentPaired) return 'needs_agent';
  return ctx.isCandidate ? 'candidate' : 'needs_agent';
}
