import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentEntitlementStatus } from '@video-compressor/shared';

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
 * runs, `npm start`, Wishly Dev) the gate reports everything as entitled.
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

  constructor(options: { publicKeyBase64?: string | null; stateFile: string; now?: () => number }) {
    this.stateFile = options.stateFile;
    this.now = options.now ?? Date.now;
    this.publicKey = importPublicKey(options.publicKeyBase64 ?? null);
  }

  get enforced(): boolean {
    return this.publicKey !== null;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.stateFile, 'utf8')) as PersistedEntitlement;
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
   * Verify a token and, when valid and newer than the recorded one, persist it.
   * Returns the resulting status; throws Error('ENTITLEMENT_TOKEN_INVALID') on
   * malformed, mis-signed, not-yet-valid, or already-expired tokens.
   */
  async acceptToken(token: string): Promise<EntitlementStatus> {
    if (!this.publicKey) return this.status();
    const payload = this.verify(token);
    if (!this.current || payload.exp > this.current.exp) {
      this.current = {
        sub: payload.sub,
        plan: payload.plan,
        iat: payload.iat,
        exp: payload.exp
      };
      await this.persist();
    }
    return this.status();
  }

  status(): EntitlementStatus {
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

  private verify(token: string): EntitlementTokenPayload {
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
    if (payload.exp * 1000 <= now) throw invalid();
    return payload;
  }

  private async persist(): Promise<void> {
    if (!this.current) return;
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.tmp`;
    await writeFile(temporary, JSON.stringify(this.current), 'utf8');
    await rename(temporary, this.stateFile);
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
