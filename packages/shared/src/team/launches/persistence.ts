import { isRecord } from '../contract.js';
import {
  LAUNCH_GENERATION_STATES,
  LAUNCH_STEP_STATES,
  type LaunchGenerationStep,
  type LaunchDraft,
  type LaunchDetail,
  type LaunchRevision,
  type LaunchGeneration,
  type LaunchPreview,
  type LaunchSummary
} from '../launches.js';
import { parseLaunchConfig, parseLaunchSources, parseLaunchSubConfig } from './validation.js';
import { parseLaunchOverrides } from './revisions.js';
import { LAUNCH_ANALYTICS_STAGES, safeLaunchAnalyticsCode } from './lifecycle.js';
export function isLaunchVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,18}$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
export function parseLaunchDraft(value: unknown): LaunchDraft | null {
  if (!isRecord(value)) return null;
  const result: LaunchDraft = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'schemaVersion' && v === 1) result.schemaVersion = 1;
    else if (k === 'agentRowId' && typeof v === 'string') result.agentRowId = v;
    else if (k === 'offerId' && typeof v === 'string') result.offerId = v;
    else if (k === 'buyerId' && typeof v === 'string') result.buyerId = v;
    else if (k === 'materialId' && typeof v === 'string') result.materialId = v;
    else if (k === 'creativeAlias' && typeof v === 'string') result.creativeAlias = v;
    else if (k === 'originalUrl' && typeof v === 'string') result.originalUrl = v;
    else if (k === 'launchDate' && typeof v === 'string') result.launchDate = v;
    else if (k === 'timezone' && typeof v === 'string') result.timezone = v;
    else if (k === 'campaignCount' && typeof v === 'number' && Number.isFinite(v))
      result.campaignCount = v;
    else if (k === 'minBudget' && typeof v === 'number' && Number.isFinite(v)) result.minBudget = v;
    else if (k === 'maxBudget' && typeof v === 'number' && Number.isFinite(v)) result.maxBudget = v;
    else if (k === 'adsCount' && typeof v === 'number' && Number.isFinite(v)) result.adsCount = v;
    else if (k === 'age' && typeof v === 'number' && Number.isFinite(v)) result.age = v;
    else if (k === 'gender' && (v === 'M' || v === 'W' || v === 'ALL')) result.gender = v;
    else if (k === 'method' && (v === 'other' || v === 'catalog')) result.method = v;
    else if (k === 'advantagePlus' && typeof v === 'boolean') result.advantagePlus = v;
    else if (k === 'budgetMode' && (v === 'auto' || v === 'manual')) result.budgetMode = v;
    else if (
      k === 'budgets' &&
      (v === null ||
        (Array.isArray(v) &&
          v.every((n: unknown): n is number => typeof n === 'number' && Number.isFinite(n))))
    )
      result.budgets = v;
    else if (k === 'subConfig') {
      const parsed = parseLaunchSubConfig(v);
      if (!parsed) return null;
      result.subConfig = parsed;
    } else if (
      k === 'catalog' &&
      isRecord(v) &&
      typeof v.productCount === 'number' &&
      typeof v.restitchEnabled === 'boolean' &&
      (v.finalDurationMode === 'random-30-40' ||
        v.finalDurationMode === 'random-40-50' ||
        v.finalDurationMode === 'random-50-60' ||
        v.finalDurationMode === 'random-centered' ||
        v.finalDurationMode === 'custom') &&
      (v.customFinalDurationSeconds === null || typeof v.customFinalDurationSeconds === 'number') &&
      (v.finalDurationRangeSeconds === undefined ||
        (Array.isArray(v.finalDurationRangeSeconds) &&
          v.finalDurationRangeSeconds.length === 2 &&
          v.finalDurationRangeSeconds.every(
            n =>
              typeof n === 'number' && Number.isInteger(n) && n >= 60 && n <= 3600 && n % 60 === 0
          ) &&
          v.finalDurationRangeSeconds[0] <= v.finalDurationRangeSeconds[1]))
    )
      result.catalog = {
        productCount: v.productCount,
        restitchEnabled: v.restitchEnabled,
        finalDurationMode: v.finalDurationMode,
        customFinalDurationSeconds: v.customFinalDurationSeconds,
        ...(Array.isArray(v.finalDurationRangeSeconds)
          ? {
              finalDurationRangeSeconds: [
                v.finalDurationRangeSeconds[0],
                v.finalDurationRangeSeconds[1]
              ] as const
            }
          : {})
      };
    else return null;
  }
  return result;
}
export function parseLaunchPreview(value: unknown): LaunchPreview | null {
  if (
    !isRecord(value) ||
    typeof value.advertisingUrl !== 'string' ||
    !isRecord(value.subValues) ||
    !Array.isArray(value.campaigns)
  )
    return null;
  const { sub1, sub2, sub3 } = value.subValues;
  if (
    (sub1 !== null && typeof sub1 !== 'string') ||
    (sub2 !== null && typeof sub2 !== 'string') ||
    (sub3 !== null && typeof sub3 !== 'string')
  )
    return null;
  const campaigns = [];
  for (const c of value.campaigns) {
    if (
      !isRecord(c) ||
      typeof c.ordinal !== 'number' ||
      typeof c.budget !== 'number' ||
      typeof c.adStart !== 'number' ||
      typeof c.adEnd !== 'number' ||
      typeof c.name !== 'string' ||
      ![c.ordinal, c.budget, c.adStart, c.adEnd].every(n => Number.isSafeInteger(n) && n > 0)
    )
      return null;
    campaigns.push({
      ordinal: c.ordinal,
      budget: c.budget,
      adStart: c.adStart,
      adEnd: c.adEnd,
      name: c.name
    });
  }
  return { advertisingUrl: value.advertisingUrl, subValues: { sub1, sub2, sub3 }, campaigns };
}
export function parseLaunchRevision(value: unknown): LaunchRevision | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.revisionNo !== 'number' ||
    (value.kind !== 'generated' && value.kind !== 'manual') ||
    (value.generationId !== undefined &&
      value.generationId !== null &&
      typeof value.generationId !== 'string') ||
    (value.baselineRevisionId !== null && typeof value.baselineRevisionId !== 'string') ||
    typeof value.createdAt !== 'string'
  )
    return null;
  const config = parseLaunchConfig(value.config);
  const sources = parseLaunchSources(value.sources);
  const baseline = parseLaunchPreview(value.baseline);
  if (!config.ok || !sources || !baseline) return null;
  const overrides = parseLaunchOverrides(value.overrides, config.value.campaignCount);
  if (!overrides.ok) return null;
  let catalog: LaunchRevision['catalog'] = null;
  if (value.catalog !== null) {
    const c = value.catalog;
    if (
      !isRecord(c) ||
      typeof c.id !== 'string' ||
      typeof c.materialId !== 'string' ||
      typeof c.variant !== 'number' ||
      typeof c.name !== 'string' ||
      typeof c.url !== 'string' ||
      (c.restitchMaterialId !== null && typeof c.restitchMaterialId !== 'string')
    )
      return null;
    catalog = {
      id: c.id,
      materialId: c.materialId,
      variant: c.variant,
      name: c.name,
      url: c.url,
      restitchMaterialId: c.restitchMaterialId
    };
  }
  return {
    id: value.id,
    revisionNo: value.revisionNo,
    kind: value.kind,
    generationId: typeof value.generationId === 'string' ? value.generationId : null,
    config: config.value,
    sources,
    baselineRevisionId: value.baselineRevisionId,
    baseline,
    overrides: overrides.value,
    catalog,
    createdAt: value.createdAt
  };
}
export function parseLaunchGenerationStep(value: unknown): LaunchGenerationStep | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.stage !== 'string' ||
    typeof value.attemptNo !== 'number' ||
    !Number.isSafeInteger(value.attemptNo) ||
    value.attemptNo < 1 ||
    (value.errorCode !== null && typeof value.errorCode !== 'string')
  )
    return null;
  const state = LAUNCH_STEP_STATES.find(state => state === value.state);
  if (!state) return null;
  return {
    id: value.id,
    stage: LAUNCH_ANALYTICS_STAGES.find(stage => stage === value.stage) ?? 'unknown',
    state,
    attemptNo: value.attemptNo,
    errorCode: value.errorCode === null ? null : safeLaunchAnalyticsCode(value.errorCode)
  };
}
export function parseLaunchGeneration(value: unknown): LaunchGeneration | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.state !== 'string' ||
    typeof value.stage !== 'string' ||
    !isLaunchVersion(value.stateVersion) ||
    (value.restitchOperationId !== undefined &&
      value.restitchOperationId !== null &&
      typeof value.restitchOperationId !== 'string') ||
    (value.errorCode !== null && typeof value.errorCode !== 'string') ||
    !Array.isArray(value.childOperationIds) ||
    !value.childOperationIds.every((id: unknown): id is string => typeof id === 'string')
  )
    return null;
  const state = LAUNCH_GENERATION_STATES.find(s => s === value.state);
  if (!state) return null;
  let steps: LaunchGenerationStep[] | undefined;
  if (value.steps !== undefined) {
    if (!Array.isArray(value.steps) || value.steps.length > 50) return null;
    const parsed = value.steps.map(parseLaunchGenerationStep);
    if (parsed.some(step => step === null)) return null;
    steps = parsed.filter((step): step is LaunchGenerationStep => step !== null);
  }
  if (value.stepsTruncated !== undefined && typeof value.stepsTruncated !== 'boolean') return null;
  let progress: LaunchGeneration['progress'] = null;
  if (value.progress !== null) {
    const p = value.progress;
    if (
      !isRecord(p) ||
      typeof p.completed !== 'number' ||
      typeof p.total !== 'number' ||
      typeof p.unit !== 'string' ||
      typeof p.source !== 'string' ||
      !Number.isFinite(p.completed) ||
      !Number.isFinite(p.total) ||
      p.completed < 0 ||
      p.total <= 0 ||
      p.completed > p.total
    )
      return null;
    progress = { completed: p.completed, total: p.total, unit: p.unit, source: p.source };
  }
  return {
    id: value.id,
    ...(typeof value.requestKey === 'string' ? { requestKey: value.requestKey } : {}),
    ...(typeof value.inputVersion === 'string' ? { inputVersion: value.inputVersion } : {}),
    ...(value.restitchOperationId === null || typeof value.restitchOperationId === 'string'
      ? { restitchOperationId: value.restitchOperationId }
      : {}),
    state,
    stage: LAUNCH_ANALYTICS_STAGES.find(stage => stage === value.stage) ?? 'unknown',
    ...(steps === undefined ? {} : { steps }),
    ...(typeof value.stepsTruncated === 'boolean' ? { stepsTruncated: value.stepsTruncated } : {}),
    stateVersion: value.stateVersion,
    errorCode: value.errorCode === null ? null : safeLaunchAnalyticsCode(value.errorCode),
    childOperationIds: value.childOperationIds,
    progress
  };
}
export function parseLaunchDetail(value: unknown): LaunchDetail | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isLaunchVersion(value.version) ||
    !/^\d+$/u.test(value.version) ||
    (value.assigneeId !== null && typeof value.assigneeId !== 'string') ||
    (value.workStatus !== 'todo' &&
      value.workStatus !== 'in_progress' &&
      value.workStatus !== 'done')
  )
    return null;
  const draft = parseLaunchDraft(value.draft);
  const sources =
    value.expectedSourceSnapshot === null ? null : parseLaunchSources(value.expectedSourceSnapshot);
  const active = value.activeRevision === null ? null : parseLaunchRevision(value.activeRevision);
  const generation = value.generation === null ? null : parseLaunchGeneration(value.generation);
  if (
    !draft ||
    (value.expectedSourceSnapshot !== null && !sources) ||
    (value.activeRevision !== null && !active) ||
    (value.generation !== null && !generation)
  )
    return null;
  return {
    id: value.id,
    version: value.version,
    draft,
    expectedSourceSnapshot: sources,
    assigneeId: value.assigneeId,
    workStatus: value.workStatus,
    activeRevision: active,
    generation
  };
}
export function parseLaunchSummary(value: unknown): LaunchSummary | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isLaunchVersion(value.version) ||
    (value.launchDate !== null && typeof value.launchDate !== 'string') ||
    typeof value.offer !== 'string' ||
    typeof value.social !== 'string' ||
    typeof value.creativeAlias !== 'string' ||
    (value.method !== 'catalog' && value.method !== 'other') ||
    (value.workStatus !== 'todo' &&
      value.workStatus !== 'in_progress' &&
      value.workStatus !== 'done') ||
    (value.assigneeId !== null && typeof value.assigneeId !== 'string') ||
    (value.hasResult !== undefined && typeof value.hasResult !== 'boolean') ||
    !Array.isArray(value.budgets) ||
    !value.budgets.every(
      (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n)
    )
  )
    return null;
  const generationState =
    value.generationState === null
      ? null
      : LAUNCH_GENERATION_STATES.find(s => s === value.generationState);
  if (generationState === undefined) return null;
  return {
    id: value.id,
    version: value.version,
    ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}),
    launchDate: value.launchDate,
    offer: value.offer,
    social: value.social,
    creativeAlias: value.creativeAlias,
    method: value.method,
    workStatus: value.workStatus,
    assigneeId: value.assigneeId,
    budgets: value.budgets,
    ...(typeof value.hasResult === 'boolean' ? { hasResult: value.hasResult } : {}),
    ...(typeof value.agentSuffix === 'string' ? { agentSuffix: value.agentSuffix } : {}),
    ...(typeof value.agentId === 'string' ? { agentId: value.agentId } : {}),
    ...(typeof value.accountName === 'string' ? { accountName: value.accountName } : {}),
    ...(typeof value.agentFree === 'boolean' ? { agentFree: value.agentFree } : {}),
    ...(typeof value.assigneeLabel === 'string' || value.assigneeLabel === null
      ? { assigneeLabel: value.assigneeLabel }
      : {}),
    ...(value.gender === 'M' ||
    value.gender === 'W' ||
    value.gender === 'ALL' ||
    value.gender === null
      ? { gender: value.gender }
      : {}),
    ...((typeof value.age === 'number' && Number.isSafeInteger(value.age) && value.age > 0) ||
    value.age === null
      ? { age: value.age }
      : {}),
    ...(typeof value.campaignCount === 'number' && Number.isSafeInteger(value.campaignCount)
      ? { campaignCount: value.campaignCount }
      : {}),
    ...(typeof value.advantagePlus === 'boolean' ? { advantagePlus: value.advantagePlus } : {}),
    generationState
  };
}
