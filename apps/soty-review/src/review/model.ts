import type { ReactNode } from 'react';

export const canonicalStateKinds = [
  'default',
  'loading',
  'empty',
  'success',
  'error',
  'active',
  'confirmation',
  'disabled'
] as const;

export type CanonicalStateKind = (typeof canonicalStateKinds)[number];
export type Theme = 'light' | 'dark';
export type ReviewLocale = 'uk' | 'en-long';
export type SurfaceGroup = 'auth' | 'shell' | 'home' | 'tool' | 'team' | 'account' | 'components';
export type SurfaceId =
  | 'auth-entry'
  | 'global-shell'
  | 'home-tools'
  | 'compressor'
  | 'landing-optimizer'
  | 'landing-gallery'
  | 'transcription'
  | 'team-lobby'
  | 'team-create-space'
  | 'team-workspace'
  | 'team-settings'
  | 'account-profile'
  | 'component-showcase';
export type StateId = string;
export type RequirementId = `FR-${string}` | `SC-${string}`;
export type ReviewElementId = string;

export type CoverageDecision =
  | { applicability: 'scenario'; scenarioId: string }
  | { applicability: 'not-applicable'; rationale: string };

export type ReviewModel = {
  kind: CanonicalStateKind;
  eyebrow: string;
  title: string;
  description: string;
  items?: readonly DemoItem[];
  progress?: number | null;
  advanced?: boolean;
  overlay?: 'none' | 'details' | 'confirmation';
};

export type DemoItem = {
  id: string;
  title: string;
  detail: string;
  status: 'ready' | 'active' | 'development' | 'success' | 'warning' | 'error';
};

export type ReviewState = {
  id: StateId;
  kind: CanonicalStateKind;
  label: string;
  model: ReviewModel;
  primaryAction: ReviewElementId | null;
};

export type ReviewSurface = {
  id: SurfaceId;
  group: SurfaceGroup;
  title: string;
  routeHint: string;
  primaryStateId: StateId;
  states: readonly ReviewState[];
  coverage: Readonly<Record<CanonicalStateKind, CoverageDecision>>;
  requirements: readonly RequirementId[];
};

export type ScopeExclusion = { id: string; rationale: string };
export type ReviewViewport = { id: string; width: number; height: number };
export type ReviewCatalog = {
  iteration: 'soty-ui-r01';
  surfaces: readonly ReviewSurface[];
  exclusions: readonly ScopeExclusion[];
  themes: readonly Theme[];
  locales: readonly ReviewLocale[];
  viewports: readonly ReviewViewport[];
  evidence: {
    motionModes: readonly ('no-preference' | 'reduce')[];
    contentModes: readonly ('standard' | 'long')[];
    interactionModes: readonly ('pointer' | 'keyboard')[];
    checks: readonly ('contrast' | 'reflow' | 'focus' | 'overlap')[];
    scenarios: readonly (
      | 'primary-action'
      | 'timed-tool-entry'
      | 'basic'
      | 'advanced'
      | 'nested-return'
      | 'confirmation'
      | 'lifecycle'
    )[];
  };
};

export type ReviewRoute =
  | { kind: 'catalog'; theme: Theme; locale: ReviewLocale; notice?: string }
  | { kind: 'screen'; surfaceId: SurfaceId; stateId: StateId; theme: Theme; locale: ReviewLocale };

export type DemoAction =
  | { type: 'navigate'; route: ReviewRoute }
  | { type: 'select-state'; stateId: StateId }
  | { type: 'set-theme'; theme: Theme }
  | { type: 'set-locale'; locale: ReviewLocale }
  | { type: 'toggle-disclosure' }
  | { type: 'open-overlay'; overlay: 'details' | 'confirmation' }
  | { type: 'close-overlay' }
  | { type: 'advance-demo' };

export type ScreenProps = {
  model: ReviewModel;
  referencePrefix: string;
  dispatch: (action: DemoAction) => void;
  children?: ReactNode;
};

export type VisualMotifPlacement = {
  id: ReviewElementId;
  kind: 'honeycomb' | 'bee' | 'honey';
  role: 'decorative' | 'functional';
  hideBelow: number;
  motion: 'none' | 'ambient';
};

export type ReviewDecision = {
  reference: `${string}/${string}/${string}/${string}`;
  decision: 'change-requested' | 'accepted' | 'blocking';
  note: string;
  verificationIteration?: string;
};

export type ApprovalStatus = 'draft' | 'in-review' | 'changes-requested' | 'approved';
