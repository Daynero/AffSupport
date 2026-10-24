import {
  createPublicKey,
  randomUUID,
  verify as verifySignature,
  type KeyObject
} from 'node:crypto';
import { mkdir, open, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentEntitlementStatus,
  EntitlementPublicationRejection
} from '@video-compressor/shared';
import { diagnostics, skewBucket } from '../server/diagnostics-log.js';

/**
 * Offline verification of server-issued entitlement tokens.
 *
 * The hosted web app exchanges a signed-in Supabase session for a short-lived
 * token (supabase/functions/issue-agent-token) and forwards it here. The agent
 * verifies the ECDSA P-256 signature against the public key embedded at
 * packaging time and remembers the newest accepted token, so the product keeps
 * working offline for a grace window after the last successful sign-in instead
 * of demanding a live connection for every session.
 *
 * Enforcement is packaging-driven: without AGENT_ENTITLEMENT_PUBLIC_KEY (dev
 * runs, `npm start`, Soty Dev) the gate reports everything as entitled.
 */

export const ENTITLEMENT_TOKEN_PREFIX = 'wat1';
export const ENTITLEMENT_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface EntitlementTokenPayload {
  v: 1;
  sub: string;
  plan: string;
  iat: number;
  exp: number;
}

export type EntitlementStatus = AgentEntitlementStatus;

interface PersistedEntitlement {
  /** Signed proof is private to this profile; legacy unsigned state is never identity proof. */
  token?: string;
  sub: string;
  plan: string;
  iat: number;
  exp: number;
}

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  return Buffer.from(value, 'base64url');
}

export class EntitlementGate {
  private readonly publicKey: KeyObject | null;
  private readonly stateFile: string;
  private readonly now: () => number;
  private current: PersistedEntitlement | null = null;
  private updates: Promise<void> = Promise.resolve();
  private actorTransitions = new Set<(actorId: string | null) => Promise<void>>();
  // A fresh boot and every ownership change invalidate already-issued publications.
  private publicationRevision = randomUUID();
  /** The last decision written to the journal, so a status read only speaks when it changes. */
  private lastDecision: string | null = null;

  constructor(options: { publicKeyBase64?: string | null; stateFile: string; now?: () => number }) {
    this.stateFile = options.stateFile;
    this.now = options.now ?? Date.now;
    this.publicKey = importPublicKey(options.publicKeyBase64 ?? null);
  }

  get enforced(): boolean {
    return this.publicKey !== null;
  }

  /** The actor is available only from verified signed state inside the entitlement grace. */
  currentActorId(): string | null {
    if (!this.publicKey || !this.current?.token || !this.evaluate().entitled) return null;
    if (this.current.iat * 1000 > this.now() + MAX_CLOCK_SKEW_MS) return null;
    return this.current.sub;
  }

  identityRevision(): string {
    return this.publicationRevision;
  }

  /** Native consumers durably stop old ownership before a new verified actor is published. */
  onBeforeActorChange(prepare: (actorId: string | null) => Promise<void>): () => void {
    this.actorTransitions.add(prepare);
    return () => this.actorTransitions.delete(prepare);
  }

  async load(): Promise<void> {
    this.publicationRevision = randomUUID();
    this.current = null;
    try {
      const raw = JSON.parse(await readCachedEntitlement(this.stateFile)) as PersistedEntitlement;
      if (raw && Object.hasOwn(raw, 'token')) {
        if (!this.publicKey || typeof raw.token !== 'string') return;
        const payload = this.verify(raw.token, true);
        this.current = {
          sub: payload.sub,
          plan: payload.plan,
          iat: payload.iat,
          exp: payload.exp,
          token: raw.token
        };
        return;
      }
      if (
        typeof raw?.sub === 'string' &&
        typeof raw?.plan === 'string' &&
        Number.isFinite(raw?.iat) &&
        Number.isFinite(raw?.exp)
      ) {
        this.current = { sub: raw.sub, plan: raw.plan, iat: raw.iat, exp: raw.exp };
      }
    } catch {
      // Missing or unreadable state simply means no entitlement is recorded.
    }
  }

  /**
   * Verify a token and persist a different account or a later expiry for the same account.
   * Returns the resulting status; throws Error('ENTITLEMENT_TOKEN_INVALID') on
   * malformed, mis-signed, not-yet-valid, or already-expired tokens.
   */
  acceptToken(token: string, revision: string): Promise<EntitlementStatus> {
    const accepted = this.updates.then(() => {
      if (this.publicKey && revision !== this.publicationRevision) {
        const reason: EntitlementPublicationRejection = 'stale_revision';
        diagnostics.record('auth', 'identity_publication_rejected', { reason });
        throw new Error('ENTITLEMENT_TOKEN_INVALID');
      }
      return this.applyToken(token);
    });
    this.updates = accepted.then(
      () => undefined,
      () => undefined
    );
    return accepted;
  }

  /** A paired caller may retire only the actor it observed, never a newer account.
   * Serialize with token publication and persist the logout before clearing memory.
   * The retirement callback keeps its protected server handle until acknowledgement.
   */
  clearActor(expectedActorId: string): Promise<boolean> {
    const cleared = this.updates.then(async () => {
      // Even a nonmatching logout fences an outstanding publication for that actor.
      this.publicationRevision = randomUUID();
      // Compare the verified stored subject even after grace expires: cleanup grants no work.
      if (!this.publicKey || !this.current?.token || this.current.sub !== expectedActorId) {
        return false;
      }
      for (const prepare of this.actorTransitions) await prepare(null);
      await this.persist(null);
      this.current = null;
      this.lastDecision = null;
      this.observe(this.evaluate().reason);
      return true;
    });
    this.updates = cleared.then(
      () => undefined,
      () => undefined
    );
    return cleared;
  }

  private async applyToken(token: string): Promise<EntitlementStatus> {
    if (!this.publicKey) return this.status();
    let payload: EntitlementTokenPayload;
    try {
      payload = this.verify(token);
    } catch (error) {
      // Which check failed is not recorded — a refused token is a refused token — and nothing
      // of the token is. The decision alone tells support that sign-in reached the agent.
      diagnostics.record('entitlement', 'decision', { decision: 'invalid', skew: 'unknown' });
      throw error;
    }
    // A different verified account owns its own entitlement and grace window.
    // Keep the longer expiry only within the same account.
    if (
      !this.current?.token ||
      payload.sub !== this.current.sub ||
      payload.exp > this.current.exp
    ) {
      const next = {
        sub: payload.sub,
        plan: payload.plan,
        iat: payload.iat,
        exp: payload.exp,
        token
      };
      const changesActor = this.currentActorId() !== payload.sub;
      if (changesActor) {
        for (const prepare of this.actorTransitions) await prepare(payload.sub);
      }
      await this.persist(next);
      this.current = next;
      if (changesActor) this.publicationRevision = randomUUID();
    }
    // Every accepted token is journaled, even when the decision is unchanged: the skew bucket
    // — how far the issuer's clock sits from this machine's — is the one fact that explains
    // a later "not yet valid" refusal nobody can otherwise see.
    this.lastDecision = null;
    this.observe(this.evaluate().reason, skewBucket(payload.iat * 1000 - this.now()));
    return this.status();
  }

  status(): EntitlementStatus {
    const status = this.evaluate();
    this.observe(status.reason);
    return status;
  }

  private evaluate(): EntitlementStatus {
    if (!this.publicKey) {
      return { enforced: false, entitled: true, reason: 'not-enforced', graceUntil: null };
    }
    if (!this.current) {
      return { enforced: true, entitled: false, reason: 'missing', graceUntil: null };
    }
    const now = this.now();
    const expiresAt = this.current.exp * 1000;
    const graceUntil = expiresAt + ENTITLEMENT_OFFLINE_GRACE_MS;
    if (now < expiresAt) {
      return {
        enforced: true,
        entitled: true,
        reason: 'active',
        graceUntil: new Date(graceUntil).toISOString()
      };
    }
    if (now < graceUntil) {
      return {
        enforced: true,
        entitled: true,
        reason: 'grace',
        graceUntil: new Date(graceUntil).toISOString()
      };
    }
    return { enforced: true, entitled: false, reason: 'expired', graceUntil: null };
  }

  /**
   * Writes the decision to the journal when it differs from the last one written.
   *
   * `status()` runs on every authenticated request, so recording each call would fill the
   * journal with one fact repeated; recording transitions gives the sequence that matters —
   * active, then grace, then expired — with the time each was first seen.
   */
  private observe(reason: EntitlementStatus['reason'], skew: string = 'unknown'): void {
    const decision = reason === 'not-enforced' ? 'not_enforced' : reason;
    if (decision === this.lastDecision) return;
    this.lastDecision = decision;
    diagnostics.record('entitlement', 'decision', { decision, skew });
  }

  private verify(token: string, cached = false): EntitlementTokenPayload {
    const invalid = () => new Error('ENTITLEMENT_TOKEN_INVALID');
    if (typeof token !== 'string' || token.length > 4096) throw invalid();
    const [prefix, payloadPart, signaturePart, ...rest] = token.split('.');
    if (prefix !== ENTITLEMENT_TOKEN_PREFIX || !payloadPart || !signaturePart || rest.length > 0) {
      throw invalid();
    }
    const payloadBytes = decodeBase64Url(payloadPart);
    const signature = decodeBase64Url(signaturePart);
    if (!payloadBytes || !signature) throw invalid();
    const signed = Buffer.from(`${ENTITLEMENT_TOKEN_PREFIX}.${payloadPart}`, 'utf8');
    const valid = verifySignature(
      'sha256',
      signed,
      { key: this.publicKey!, dsaEncoding: 'ieee-p1363' },
      signature
    );
    if (!valid) throw invalid();

    let payload: EntitlementTokenPayload;
    try {
      payload = JSON.parse(payloadBytes.toString('utf8')) as EntitlementTokenPayload;
    } catch {
      throw invalid();
    }
    if (
      payload?.v !== 1 ||
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0 ||
      typeof payload.plan !== 'string' ||
      !Number.isFinite(payload.iat) ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= payload.iat
    ) {
      throw invalid();
    }
    const now = this.now();
    if (payload.iat * 1000 > now + MAX_CLOCK_SKEW_MS) throw invalid();
    if (!cached && payload.exp * 1000 <= now) throw invalid();
    return payload;
  }

  private async persist(value: PersistedEntitlement | null): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      });
      await rename(temporary, this.stateFile);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/** Read a bounded private cache through one handle, even if the file changes during the read. */
async function readCachedEntitlement(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(16 * 1024 + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > 16 * 1024) throw new Error('ENTITLEMENT_TOKEN_INVALID');
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

function importPublicKey(base64: string | null): KeyObject | null {
  const trimmed = base64?.trim();
  if (!trimmed) return null;
  try {
    return createPublicKey({
      key: Buffer.from(trimmed, 'base64'),
      format: 'der',
      type: 'spki'
    });
  } catch (error) {
    // A corrupt embedded key is a build defect, not a user problem. Tampering
    // is not made easier by failing open here: removing the variable disables
    // enforcement just the same, so we log loudly instead of bricking the app.
    console.error(
      '[wishly-agent] invalid AGENT_ENTITLEMENT_PUBLIC_KEY; entitlement disabled',
      error
    );
    return null;
  }
}
