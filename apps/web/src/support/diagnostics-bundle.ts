/**
 * 031 T015 — the support evidence bundle (FR-045, FR-054).
 *
 * Assembled in the browser from the agent's bounded journal (`/api/diagnostics`),
 * the page's own view of the link, and the two builds involved. It is shown in
 * full before anything can be copied, and nothing here sends it anywhere.
 *
 * The sanitizer is the privacy fence (FR-028): it walks the finished object and
 * refuses any string that could carry a path, a URL, an address or a credential,
 * and any key whose name says it holds one. Numbers and booleans pass — the
 * journal is made of buckets and counts, and a bundle that lost them would say
 * nothing. The fence runs on the whole bundle, not on the pieces, so a field
 * added later is covered by default rather than by discipline.
 */
import { PRODUCT_VERSION, type DiagnosticRecord } from '@video-compressor/shared';
import type { LinkOrigin } from '../analytics/events';
import type { BrowserFamily } from '../lib/browser';

/** How many journal records the bundle asks for: the contract's "last 200". */
export const DIAGNOSTICS_BUNDLE_RECORDS = 200;

/** The longest string the fence lets through: a code, a version, a bucket — never prose. */
export const DIAGNOSTICS_STRING_MAX_LENGTH = 120;

/** Web build identity, the same value the analytics envelope carries as `web_build_id`. */
export const WEB_BUILD_ID: string = import.meta.env.VITE_WEB_BUILD_ID || PRODUCT_VERSION;

/** What `GET /api/diagnostics` answers. Read defensively: an older agent sends less. */
export interface AgentDiagnosticsResponse {
  environment?: string;
  version?: string;
  buildNumber?: string;
  buildId?: string;
  instanceId?: string;
  apiVersion?: number;
  channel?: string;
  startedAt?: number;
  system?: string;
  architecture?: string;
  log?: DiagnosticRecord[];
  nextSeq?: number;
  logRejected?: number;
}

export interface DiagnosticsBundleLastKnownAgent {
  version: string | null;
  buildId: string | null;
  instanceId: string | null;
  channel: string | null;
}

export interface DiagnosticsBundleWeb {
  build: string;
  browserFamily: BrowserFamily;
  origin: LinkOrigin;
  connection: string;
  reason: string | null;
  lastKnownAgent: DiagnosticsBundleLastKnownAgent | null;
}

export interface DiagnosticsBundleAgent {
  version: string | null;
  buildId: string | null;
  instanceId: string | null;
  platform: string | null;
  environment: string | null;
  capabilities: number;
  log: DiagnosticRecord[];
  logRejected: number;
}

/** One `link_*` event the page emitted, kept as name and time only. */
export interface DiagnosticsBundleLinkEvent {
  event: string;
  at: number;
}

export interface DiagnosticsBundle {
  generatedAt: string;
  web: DiagnosticsBundleWeb;
  agent: DiagnosticsBundleAgent | 'unavailable';
  recentLinkEvents: DiagnosticsBundleLinkEvent[];
}

export interface DiagnosticsBundleInput {
  agent: AgentDiagnosticsResponse | null;
  web: Omit<DiagnosticsBundleWeb, 'build' | 'lastKnownAgent'> & {
    lastKnownAgent: (DiagnosticsBundleLastKnownAgent & { capabilities?: string[] }) | null;
  };
  now?: Date;
}

const DROPPED = Symbol('dropped');

/** Keys whose name says the value is a path, a name, an address or a credential. */
const FORBIDDEN_KEY = /token|secret|cookie|authorization|path|name|url/i;

/** Strings the fence refuses outright, whatever the key. */
const FORBIDDEN_TEXT = /[/\\@]|:\/\/|token|bearer/i;

function stringAllowed(value: string): boolean {
  return value.length <= DIAGNOSTICS_STRING_MAX_LENGTH && !FORBIDDEN_TEXT.test(value);
}

function walk(value: unknown): unknown | typeof DROPPED {
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : DROPPED;
    case 'string':
      return stringAllowed(value) ? value : DROPPED;
    case 'object':
      break;
    default:
      return DROPPED;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const kept = walk(item);
      if (kept !== DROPPED) out.push(kept);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key) || !stringAllowed(key)) continue;
    const kept = walk(item);
    if (kept !== DROPPED) out[key] = kept;
  }
  return out;
}

/**
 * The privacy fence over a finished bundle, or over anything else that is
 * about to be shown as evidence. Strings containing `/`, `\`, `://`, `@`,
 * `token` or `bearer`, or longer than `DIAGNOSTICS_STRING_MAX_LENGTH`, are
 * dropped; so is every key named like `token|secret|cookie|authorization|path|
 * name|url`. The result is plain data, ready for `JSON.stringify`.
 */
export function sanitizeDiagnosticsBundle(value: unknown): unknown {
  const kept = walk(value);
  return kept === DROPPED ? null : kept;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function isRecord(value: unknown): value is DiagnosticRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<DiagnosticRecord>;
  return (
    typeof record.seq === 'number' &&
    typeof record.at === 'number' &&
    typeof record.category === 'string' &&
    typeof record.code === 'string'
  );
}

function agentSection(
  response: AgentDiagnosticsResponse | null,
  lastKnownAgent: DiagnosticsBundleInput['web']['lastKnownAgent']
): DiagnosticsBundleAgent | 'unavailable' {
  if (!response || typeof response !== 'object') return 'unavailable';
  const log = Array.isArray(response.log) ? response.log.filter(isRecord) : [];
  return {
    version: text(response.version),
    buildId: text(response.buildId),
    instanceId: text(response.instanceId),
    platform: text(response.system),
    environment: text(response.environment),
    // `/api/diagnostics` does not list capabilities; the health handshake did,
    // and the context kept them.
    capabilities: lastKnownAgent?.capabilities?.length ?? 0,
    log: log.slice(-DIAGNOSTICS_BUNDLE_RECORDS),
    logRejected: count(response.logRejected)
  };
}

/**
 * Assembles the bundle and runs it through the fence. The returned object is
 * what the screen shows and what the copy button copies — the two are never
 * allowed to differ.
 */
export function buildDiagnosticsBundle(input: DiagnosticsBundleInput): DiagnosticsBundle {
  const { lastKnownAgent, ...web } = input.web;
  const raw: DiagnosticsBundle = {
    generatedAt: (input.now ?? new Date()).toISOString(),
    web: {
      build: WEB_BUILD_ID,
      ...web,
      lastKnownAgent: lastKnownAgent
        ? {
            version: lastKnownAgent.version,
            buildId: lastKnownAgent.buildId,
            instanceId: lastKnownAgent.instanceId,
            channel: lastKnownAgent.channel
          }
        : null
    },
    agent: agentSection(input.agent, lastKnownAgent),
    // The analytics service exposes no read-only view of the events it has
    // queued, and this module may not change it. Until it does, the bundle
    // says so with an empty list rather than guessing from storage.
    recentLinkEvents: []
  };
  // The fence runs over the finished object: every field above, and any field
  // a later change adds, passes through it or does not appear. The shape is
  // preserved because the fence removes entries and never reshapes them.
  return sanitizeDiagnosticsBundle(raw) as DiagnosticsBundle;
}

/** The text the screen shows and the clipboard receives. */
export function formatDiagnosticsBundle(bundle: DiagnosticsBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/** How many journal records the bundle holds; 0 when the agent was unreachable. */
export function diagnosticsBundleRecordCount(bundle: DiagnosticsBundle): number {
  return bundle.agent === 'unavailable' ? 0 : bundle.agent.log.length;
}
