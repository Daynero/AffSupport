/**
 * The browser's half of transcript translation (063): start, watch, list and the allowance.
 *
 * `watch` is one long request whose answer is NDJSON — the function follows the row and the page
 * reads lines. There is no client polling: a stream that ends early is opened again only when the
 * page becomes visible and the translation is still running (Constitution VI).
 */
import {
  parseTranscriptTranslation,
  parseTranscriptTranslationList,
  parseTranslationAllowance,
  parseTranslationStreamEvent,
  TRANSCRIPT_TRANSLATION_FEATURE,
  type TranscriptTranslation,
  type TranslationAllowance,
  type TranslationStreamEvent
} from '@video-compressor/shared';
import { AI_PRICE_VERSION } from '@video-compressor/shared';
import { invokeTeamFunction, TeamApiError, throwRpc } from '../api/team';
import { publicConfig } from '../lib/config';
import { requireSupabaseClient, withFreshSession } from '../lib/supabase';

export type TranslationSource =
  | { scope: 'team_video'; teamId: string; videoId: string }
  | {
      scope: 'personal';
      documentKey: string;
      sourceLanguage: string | null;
      segments: string[];
    };

export interface StartedTranslation {
  translationId: string;
  status: 'processing' | 'completed';
  reused: boolean;
  units: number;
  allowance: TranslationAllowance | null;
  /** 064: credits charged for this press (0 when joining one already started) and the balance. */
  price?: number;
  credits?: unknown;
}

function isStarted(value: unknown): value is StartedTranslation {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.translationId === 'string' &&
    (item.status === 'processing' || item.status === 'completed') &&
    typeof item.reused === 'boolean' &&
    typeof item.units === 'number' &&
    (item.allowance === null || parseTranslationAllowance(item.allowance) !== null)
  );
}

export interface TranslationClient {
  /** `price` is the one the button showed; the server refuses a different one (064). */
  start(targetLanguage: string, source: TranslationSource, price: number): Promise<StartedTranslation>;
  watch(
    translationId: string,
    onEvent: (event: TranslationStreamEvent) => void,
    signal: AbortSignal
  ): Promise<void>;
  listForVideo(teamId: string, videoId: string): Promise<TranscriptTranslation[]>;
  listPersonal(documentKey: string, fingerprint: string): Promise<TranscriptTranslation[]>;
  get(translationId: string): Promise<TranscriptTranslation>;
  allowance(): Promise<TranslationAllowance>;
  /** Removes every finished or failed translation of that language for the same text. */
  remove(translationId: string): Promise<void>;
}

const FUNCTION = 'transcript-translate';

async function readLines(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  signal: AbortSignal
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onLine(line);
        newline = buffer.indexOf('\n');
      }
    }
    const rest = (buffer + decoder.decode()).trim();
    if (rest) onLine(rest);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export const translationClient: TranslationClient = {
  start(targetLanguage, source, price) {
    return invokeTeamFunction(
      FUNCTION,
      { action: 'start', targetLanguage, source, expectedPrice: price, priceVersion: AI_PRICE_VERSION },
      isStarted
    );
  },

  async watch(translationId, onEvent, signal) {
    if (!publicConfig.ok) throw new TeamApiError('TEAM_TRANSPORT_UNAVAILABLE', true);
    const supabase = requireSupabaseClient();
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    if (!token) throw new TeamApiError('AUTH_REQUIRED', false);
    let response: Response;
    try {
      response = await fetch(`${publicConfig.value.supabaseUrl}/functions/v1/${FUNCTION}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          apikey: publicConfig.value.supabasePublishableKey,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ action: 'watch', translationId }),
        signal
      });
    } catch (error) {
      if (signal.aborted) return;
      throw error instanceof TeamApiError
        ? error
        : new TeamApiError('TEAM_TRANSPORT_UNAVAILABLE', true);
    }
    if (!response.ok || !response.body) {
      let code: string | null;
      try {
        const body = (await response.json()) as { error?: { code?: unknown } };
        code = typeof body.error?.code === 'string' ? body.error.code : null;
      } catch {
        code = null;
      }
      throw new TeamApiError(
        (code ?? 'TEAM_TRANSPORT_UNAVAILABLE') as ConstructorParameters<typeof TeamApiError>[0],
        response.status >= 500
      );
    }
    await readLines(
      response.body,
      line => {
        try {
          const event = parseTranslationStreamEvent(JSON.parse(line));
          if (event) onEvent(event);
        } catch {
          // A torn line is skipped; the next one carries the full state again.
        }
      },
      signal
    );
  },

  async listForVideo(teamId, videoId) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_video_translations', { p_team: teamId, p_video: videoId })
    );
    throwRpc(error);
    const parsed = parseTranscriptTranslationList(data);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed;
  },

  async listPersonal(documentKey, fingerprint) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_personal_translations', {
        p_document_key: documentKey,
        p_fingerprint: fingerprint
      })
    );
    throwRpc(error);
    const parsed = parseTranscriptTranslationList(data);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed;
  },

  async get(translationId) {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_transcript_translation', { p_id: translationId })
    );
    throwRpc(error);
    const parsed = parseTranscriptTranslation(data);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed;
  },

  async remove(translationId) {
    const { error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('delete_transcript_translation', { p_id: translationId })
    );
    throwRpc(error);
  },

  async allowance() {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('ai_allowance_status', {
        p_feature: TRANSCRIPT_TRANSLATION_FEATURE
      })
    );
    throwRpc(error);
    const parsed = parseTranslationAllowance(data);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed;
  }
};
