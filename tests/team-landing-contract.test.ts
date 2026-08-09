import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANDING_VIEWER_PRESET,
  LANDING_RENDER_PRESET_DEFAULT,
  LANDING_ZOOM_MAX,
  LANDING_ZOOM_MIN,
  TEAM_ANALYTICS_EVENT_NAMES,
  TEAM_ANALYTICS_FORBIDDEN_FIELDS,
  clampZoom,
  containsForbiddenTeamAnalyticsField,
  isValidReadyRender,
  normalizeLandingViewerPreset,
  parseLandingRenderPointer,
  parseTeamLandingRenderResult,
  resolveLandingTileState,
  sanitizeTeamAnalyticsProperties
} from '../packages/shared/src/team/index';

const validArtifact = {
  materialId: 'm1',
  sourceVersion: 'v1',
  fingerprint: 'fp1',
  preset: LANDING_RENDER_PRESET_DEFAULT,
  segmentCount: 3,
  artifactToken: 'tok_abc'
};

const readyPointer = {
  materialId: 'm1',
  state: 'ready',
  sourceVersion: 'v1',
  fingerprint: 'fp1',
  preset: LANDING_RENDER_PRESET_DEFAULT,
  artifact: validArtifact
};

describe('landing gallery contract', () => {
  it('clamps zoom into the shared bounds and falls back for non-finite input', () => {
    expect(clampZoom(0)).toBe(LANDING_ZOOM_MIN);
    expect(clampZoom(99)).toBe(LANDING_ZOOM_MAX);
    expect(clampZoom(1.5)).toBe(1.5);
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_LANDING_VIEWER_PRESET.zoom);
  });

  it('normalizes an untrusted viewer preset to safe values', () => {
    expect(normalizeLandingViewerPreset(null)).toEqual(DEFAULT_LANDING_VIEWER_PRESET);
    expect(
      normalizeLandingViewerPreset({ device: 'phone', colorScheme: 'sepia', zoom: 12 })
    ).toEqual({ device: 'desktop', colorScheme: 'light', zoom: LANDING_ZOOM_MAX });
    expect(
      normalizeLandingViewerPreset({ device: 'mobile', colorScheme: 'dark', zoom: 2 })
    ).toEqual({ device: 'mobile', colorScheme: 'dark', zoom: 2 });
  });

  it('parses a ready render pointer and keeps its artifact', () => {
    const parsed = parseLandingRenderPointer(readyPointer);
    expect(parsed?.state).toBe('ready');
    expect(parsed?.artifact?.artifactToken).toBe('tok_abc');
  });

  it('drops an artifact on any non-ready pointer (no false-ready leakage)', () => {
    const parsed = parseLandingRenderPointer({ ...readyPointer, state: 'stale' });
    expect(parsed?.state).toBe('stale');
    expect(parsed?.artifact).toBeUndefined();
  });

  it('rejects malformed pointers and results', () => {
    expect(parseLandingRenderPointer({ materialId: 'm1', state: 'bogus' })).toBeNull();
    expect(parseLandingRenderPointer(null)).toBeNull();
    expect(parseTeamLandingRenderResult({ ok: false, reason: 'nope' })).toBeNull();
    expect(parseTeamLandingRenderResult({ ok: false, reason: 'too_large' })).toEqual({
      ok: false,
      reason: 'too_large'
    });
    expect(parseTeamLandingRenderResult({ ok: true, pointer: readyPointer })?.ok).toBe(true);
  });

  it('treats a render as valid only when state + source identity match', () => {
    const pointer = parseLandingRenderPointer(readyPointer)!;
    expect(isValidReadyRender(pointer, { id: 'm1', sourceVersion: 'v1', fingerprint: 'fp1' })).toBe(
      true
    );
    expect(isValidReadyRender(pointer, { id: 'm1', sourceVersion: 'v2', fingerprint: 'fp1' })).toBe(
      false
    );
    expect(
      isValidReadyRender(pointer, { id: 'other', sourceVersion: 'v1', fingerprint: 'fp1' })
    ).toBe(false);
  });

  it('derives tile state structurally, never claiming ready without a fetchable render', () => {
    const base = { isCandidate: false, agentPaired: true, agentCompatible: true } as const;
    expect(resolveLandingTileState({ ...base, hasValidReadyRender: true })).toBe('ready');
    expect(
      resolveLandingTileState({ ...base, hasValidReadyRender: false, renderState: 'rendering' })
    ).toBe('rendering');
    expect(
      resolveLandingTileState({
        ...base,
        hasValidReadyRender: false,
        renderState: 'failed',
        failureReason: 'corrupt'
      })
    ).toBe('error');
    expect(
      resolveLandingTileState({
        isCandidate: false,
        hasValidReadyRender: false,
        agentPaired: false,
        agentCompatible: false
      })
    ).toBe('needs_agent');
    expect(
      resolveLandingTileState({
        isCandidate: false,
        hasValidReadyRender: false,
        agentPaired: true,
        agentCompatible: false
      })
    ).toBe('agent_outdated');
    expect(
      resolveLandingTileState({
        isCandidate: true,
        hasValidReadyRender: false,
        agentPaired: false,
        agentCompatible: false
      })
    ).toBe('candidate');
  });

  it('registers the three content-free landing analytics events', () => {
    for (const name of [
      'team_landing_gallery_view',
      'team_landing_open',
      'team_landing_render'
    ] as const) {
      expect(TEAM_ANALYTICS_EVENT_NAMES).toContain(name);
    }
  });

  it('sanitizes landing analytics props and keeps content-free guarantees', () => {
    const clean = sanitizeTeamAnalyticsProperties({
      attempt_id: 'abc123',
      item_count: 300,
      ready_count: 42,
      tile_state: 'ready',
      had_agent: true,
      duration_ms: 1200,
      // forbidden / bogus fields must be dropped
      material_id: 'leak',
      item_count_bogus: 5,
      tile_state_bad: 'nope'
    });
    expect(clean).toEqual({
      attempt_id: 'abc123',
      item_count: 300,
      ready_count: 42,
      tile_state: 'ready',
      had_agent: true,
      duration_ms: 1200
    });
    expect(containsForbiddenTeamAnalyticsField({ material_id: 'x' })).toBe(true);
    expect(TEAM_ANALYTICS_FORBIDDEN_FIELDS).toContain('material_id');
  });
});
