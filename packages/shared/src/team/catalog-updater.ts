/** Civil time for daily/weekly runs; an elapsed cadence anchor for hour intervals. */
export interface CatalogUpdateSchedule {
  timeZone: string;
  /** ISO weekday: Monday = 1, Sunday = 7. */
  weekday: number;
  time: string;
}

/** The change choices copied to each catalog when it is created (039). */
export interface CatalogUpdateProfile {
  catalogId: string;
  refreshImages: boolean;
  refreshTexts: boolean;
  growProducts: boolean;
  randomLinkVariation: boolean;
  restitch: boolean;
  version: number;
  updatedAt: string;
  /** Missing on legacy servers; null retains the legacy elapsed schedule. */
  schedule?: CatalogUpdateSchedule | null;
  lastErrorAt?: string | null;
  /** Absent on older servers; null means no recorded attempt/success. */
  lastResult?: CatalogUpdateResult | null;
  latestAttemptAt?: string | null;
  lastSuccessfulAt?: string | null;
  restitchStatus?: 'ready' | 'preparing' | 'blocked' | 'waiting';
  restitchBlockedCode?: string | null;
  reconciliationRequired?: boolean;
}

export type CatalogUpdateProfilePatch = Partial<
  Pick<
    CatalogUpdateProfile,
    'refreshImages' | 'refreshTexts' | 'growProducts' | 'randomLinkVariation' | 'restitch'
  >
> & { updateInterval?: '1d' | '1w' | `${number}h` | null; schedule?: CatalogUpdateSchedule | null };

export type CatalogUpdateResult =
  'running' | 'success' | 'partial' | 'failed' | 'cancelled' | 'unknown';

export interface CatalogUpdateAttempt {
  attemptId: string;
  catalogId: string;
  trigger: 'schedule' | 'manual' | 'retry' | 'unknown';
  startedAt: string;
  endedAt: string | null;
  stage: string | null;
  stages?: Array<{
    stage: 'preparing' | 'refreshing' | 'building' | 'uploading' | 'verifying' | 'finalizing';
    at: string;
  }>;
  result: CatalogUpdateResult;
  failureCode: string | null;
  deliveryVerifiedAt: string | null;
  profileVersion?: number | null;
  sourceAttemptId?: string | null;
  profileSnapshot?: Pick<
    CatalogUpdateProfile,
    'refreshImages' | 'refreshTexts' | 'growProducts' | 'randomLinkVariation' | 'restitch'
  > | null;
  actualChanges?: {
    productIds?: boolean;
    linksVaried?: boolean;
    imagesRefreshed?: boolean;
    textsRefreshed?: boolean;
    productsAdded?: boolean;
    videoReplaced?: boolean;
  } | null;
}
