/**
 * assistant (064): the launch assistant's requests. Pure: every dependency arrives in
 * `AssistantDeps`, so vitest drives it with fake RPCs and a fake model.
 *
 *   send             a message; short replies («запускай», «скасуй», «так») never call a model
 *   answer           a button on a question card — continues the command without a model
 *   confirm_profile  «Зберегти» on an offer-defaults card, then the actions that waited for it
 *   review           the review card for today or for the rows of a card
 *   undo             «Скасувати» on a result card
 *
 * A paid message is debited at exactly the shown price before the model is called and refunded on
 * any known failure. Generation is never started here: «Запустити N» goes through the batch
 * of 053 from the browser, with the versions this card showed.
 */
// @deno-types="../../../packages/shared/dist/team/ai-credits.d.ts"
import {
  AI_PRICE_VERSION,
  assistantMessagePrice,
  ASSISTANT_MESSAGE_MAX_CHARACTERS,
  characterCount
} from '../../../packages/shared/dist/team/ai-credits.js';
// @deno-types="../../../packages/shared/dist/team/assistant.d.ts"
import {
  extractAssistantUrls,
  parseAssistantPlan,
  quickAssistantIntent,
  type AssistantAction,
  type AssistantPlan,
  type AssistantRow
} from '../../../packages/shared/dist/team/assistant.js';
// @deno-types="../../../packages/shared/dist/team/launches/naming.d.ts"
import { isLaunchTimezone } from '../../../packages/shared/dist/team/launches/naming.js';
// @deno-types="../../../packages/shared/dist/team/launches/defaults-merge.d.ts"
import { launchDayInZone } from '../../../packages/shared/dist/team/launches/defaults-merge.js';
import { recordModelUsage, type Rpc } from '../_shared/ai-allowance.ts';
import {
  callUpperUsd,
  CreditRefusal,
  CreditsUnavailable,
  debitCredits,
  refundCredits,
  settleCredits
} from '../_shared/ai-credits.ts';
import type { ClaudeClient } from '../_shared/claude.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import {
  cardRows,
  EngineRefusal,
  executePlan,
  loadNames,
  resolvePlan,
  reviewCard,
  type Card,
  type EngineDeps
} from './engine.ts';
import {
  ASSISTANT_MAX_INPUT_TOKENS,
  ASSISTANT_MAX_OUTPUT_TOKENS,
  ASSISTANT_MODEL,
  interpretMessage
} from './interpret.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CLIENT_KEY = /^[A-Za-z0-9_-]{8,80}$/u;
const FEATURE = 'launch_assistant';

export type AssistantCommand = (
  | {
      action: 'send';
      teamId: string;
      text: string;
      clientKey: string;
      expectedPrice: number;
      priceVersion: string;
      contextCardId: string | null;
      timezone: string;
    }
  | {
      action: 'answer';
      teamId: string;
      cardId: string;
      optionId: string;
      clientKey: string;
      timezone: string;
    }
  | {
      action: 'confirm_profile';
      teamId: string;
      cardId: string;
      clientKey: string;
      timezone: string;
    }
  | { action: 'review'; teamId: string; cardId: string | null; clientKey: string; timezone: string }
  | { action: 'undo'; teamId: string; commandId: string; clientKey: string }
) & {
  /** The dialog the person has open; null takes their most recent one. */
  dialogId: string | null;
};

/** Every command without its dialog, kept as a union. */
type CommandBody = AssistantCommand extends infer C
  ? C extends unknown
    ? Omit<C, 'dialogId'>
    : never
  : never;

function invalid(): never {
  throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
}

function only(body: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(body).some(key => !keys.includes(key))) invalid();
}

export function parseAssistantCommand(body: unknown): AssistantCommand {
  if (!isRecord(body) || typeof body.teamId !== 'string' || !UUID.test(body.teamId)) invalid();
  if (typeof body.clientKey !== 'string' || !CLIENT_KEY.test(body.clientKey)) invalid();
  const timezone =
    typeof body.timezone === 'string' && isLaunchTimezone(body.timezone)
      ? body.timezone
      : 'Europe/Kyiv';
  const teamId = body.teamId.toLowerCase();
  const id = (value: unknown) =>
    typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : invalid();
  const dialogId = body.conversationId == null ? null : id(body.conversationId);
  const parsed = ((): CommandBody => {
    switch (body.action) {
      case 'send': {
        only(body, [
          'conversationId',
          'action',
          'teamId',
          'text',
          'clientKey',
          'expectedPrice',
          'priceVersion',
          'contextCardId',
          'timezone'
        ]);
        if (
          typeof body.text !== 'string' ||
          typeof body.expectedPrice !== 'number' ||
          typeof body.priceVersion !== 'string'
        )
          invalid();
        if (characterCount(body.text) > ASSISTANT_MESSAGE_MAX_CHARACTERS)
          throw new TeamFunctionError('MESSAGE_TOO_LONG', { retryable: false });
        return {
          action: 'send',
          teamId,
          text: body.text,
          clientKey: body.clientKey,
          expectedPrice: body.expectedPrice,
          priceVersion: body.priceVersion,
          contextCardId: body.contextCardId == null ? null : id(body.contextCardId),
          timezone
        };
      }
      case 'answer':
        only(body, [
          'conversationId',
          'action',
          'teamId',
          'cardId',
          'optionId',
          'clientKey',
          'timezone'
        ]);
        if (typeof body.optionId !== 'string' || body.optionId.length > 64) invalid();
        return {
          action: 'answer',
          teamId,
          cardId: id(body.cardId),
          optionId: body.optionId,
          clientKey: body.clientKey,
          timezone
        };
      case 'confirm_profile':
        only(body, ['conversationId', 'action', 'teamId', 'cardId', 'clientKey', 'timezone']);
        return {
          action: 'confirm_profile',
          teamId,
          cardId: id(body.cardId),
          clientKey: body.clientKey,
          timezone
        };
      case 'review':
        only(body, ['conversationId', 'action', 'teamId', 'cardId', 'clientKey', 'timezone']);
        return {
          action: 'review',
          teamId,
          cardId: body.cardId == null ? null : id(body.cardId),
          clientKey: body.clientKey,
          timezone
        };
      case 'undo':
        only(body, ['conversationId', 'action', 'teamId', 'commandId', 'clientKey', 'timezone']);
        return { action: 'undo', teamId, commandId: id(body.commandId), clientKey: body.clientKey };
      default:
        invalid();
    }
  })();
  return { ...parsed, dialogId } as AssistantCommand;
}

export interface AssistantDeps {
  userId: string;
  callerRpc: Rpc;
  serviceRpc: Rpc;
  client: ClaudeClient | null;
  now?: () => Date;
}

export interface AssistantResponse {
  commandId: string;
  replayed: boolean;
  message: unknown;
  credits: unknown;
}

function rpcCode(error: { message?: string; code?: string } | null): string {
  const text = `${error?.message ?? ''} ${error?.code ?? ''}`;
  return text.match(/[A-Z][A-Z0-9_]{3,}/u)?.[0] ?? 'UNAVAILABLE';
}

async function service(
  deps: AssistantDeps,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const { data, error } = await deps.serviceRpc(name, args);
  if (!error) return data;
  const code = rpcCode(error);
  if (code === 'PERMISSION_DENIED')
    throw new TeamFunctionError('ASSISTANT_FORBIDDEN', { retryable: false });
  if (code === 'ASSISTANT_DISABLED')
    throw new TeamFunctionError('ASSISTANT_DISABLED', { retryable: false });
  if (code === 'KEY_REUSED') throw new TeamFunctionError('KEY_REUSED', { retryable: false });
  if (code === 'NOT_FOUND') throw new TeamFunctionError('NOT_FOUND', { retryable: false });
  throw new TeamFunctionError('TEAM_TRANSPORT_UNAVAILABLE', { retryable: true });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

interface Begun {
  commandId: string;
  replayed: boolean;
  reply: unknown;
}

async function begin(
  deps: AssistantDeps,
  teamId: string,
  clientKey: string,
  kind: 'message' | 'answer' | 'confirm' | 'undo',
  request: unknown,
  text: string | null,
  price: number,
  dialogId: string | null = null
): Promise<Begun> {
  const context = await service(deps, 'service_assistant_context_v2', {
    p_user: deps.userId,
    p_team: teamId,
    p_dialog: dialogId
  });
  const dialog =
    isRecord(context) && typeof context.conversationId === 'string' ? context.conversationId : null;
  const data = await service(deps, 'service_assistant_begin_v2', {
    p_user: deps.userId,
    p_team: teamId,
    p_dialog: dialog,
    p_client_key: clientKey,
    p_request_hash: await sha256(JSON.stringify({ kind, request })),
    p_kind: kind,
    p_text: text,
    p_price: price
  });
  if (!isRecord(data) || typeof data.commandId !== 'string')
    throw new TeamFunctionError('TEAM_TRANSPORT_UNAVAILABLE', { retryable: true });
  return { commandId: data.commandId, replayed: data.replayed === true, reply: data.reply ?? null };
}

async function reply(
  deps: AssistantDeps,
  commandId: string,
  text: string,
  cards: Card[]
): Promise<unknown> {
  return service(deps, 'service_assistant_reply', {
    p_command: commandId,
    p_text: text.slice(0, 600),
    p_cards: cards.map(card => ({ kind: card.kind, payload: card.payload }))
  });
}

async function status(
  deps: AssistantDeps,
  commandId: string,
  value: string,
  reason: string | null,
  model: string | null,
  plan: unknown
): Promise<void> {
  await service(deps, 'service_assistant_status', {
    p_command: commandId,
    p_status: value,
    p_reason: reason,
    p_model: model,
    p_plan: plan ?? null
  });
}

async function credits(deps: AssistantDeps): Promise<unknown> {
  const { data } = await deps.callerRpc('ai_credits_status', {});
  return data ?? null;
}

async function shownRows(
  deps: AssistantDeps,
  teamId: string,
  cardId: string | null
): Promise<{ rows: AssistantRow[]; card: Record<string, unknown> | null }> {
  if (!cardId) return { rows: [], card: null };
  const card = await service(deps, 'service_assistant_card', {
    p_user: deps.userId,
    p_team: teamId,
    p_card: cardId
  });
  if (!isRecord(card) || !isRecord(card.payload)) return { rows: [], card: null };
  const rows = Array.isArray(card.payload.rows) ? (card.payload.rows as AssistantRow[]) : [];
  return { rows, card };
}

function engineDeps(
  deps: AssistantDeps,
  teamId: string,
  commandId: string,
  timezone: string,
  extra: Partial<EngineDeps>
): EngineDeps {
  return {
    userId: deps.userId,
    teamId,
    commandId,
    callerRpc: deps.callerRpc,
    serviceRpc: deps.serviceRpc,
    now: deps.now?.() ?? new Date(),
    timezone,
    urls: [],
    choices: {},
    shown: [],
    ...extra
  };
}

function refusal(code: string, details?: Record<string, unknown>): Card {
  return { kind: 'refusal', payload: { code, ...(details ? { details } : {}) } };
}

interface StoredPlan {
  plan: AssistantPlan;
  choices: Record<string, string>;
  timezone: string;
  contextCardId: string | null;
  /** Actions waiting for «Зберегти» on a profile card. */
  deferred?: AssistantAction[];
  /** The command whose links the plan refers to. */
  urlsFrom: string;
}

async function runPlan(
  deps: AssistantDeps,
  teamId: string,
  commandId: string,
  stored: StoredPlan,
  canSaveDefaults: boolean,
  model: string | null
): Promise<{ text: string; cards: Card[]; status: string }> {
  const urls = (await service(deps, 'service_assistant_urls', { p_command: stored.urlsFrom })) as
    string[] | null;
  const shown = await shownRows(deps, teamId, stored.contextCardId);
  const engine = engineDeps(deps, teamId, commandId, stored.timezone, {
    urls: urls ?? [],
    choices: stored.choices,
    shown: shown.rows
  });
  const names = await loadNames(engine);
  const resolved = await resolvePlan(stored.plan, engine, names);
  if (!resolved.ok) {
    const card: Card = {
      kind: 'question',
      payload: {
        source: 'resolve',
        commandId,
        ref: resolved.ref,
        about: resolved.ref.split(':').slice(1).join(':'),
        field: resolved.ref.split(':')[0],
        options: resolved.options.map(option => ({ id: option.id, label: option.name }))
      }
    };
    await status(deps, commandId, 'waiting_answer', null, model, stored);
    return { text: stored.plan.reply, cards: [card], status: 'waiting_answer' };
  }
  const outcome = await executePlan(stored.plan, engine, resolved.resolution, { canSaveDefaults });
  if (outcome.kind === 'rejected') {
    await status(deps, commandId, 'rejected', outcome.code, model, stored);
    return { text: stored.plan.reply, cards: [refusal(outcome.code)], status: 'rejected' };
  }
  if (outcome.kind === 'question') {
    await status(deps, commandId, 'waiting_answer', null, model, stored);
    return { text: stored.plan.reply, cards: [outcome.card], status: 'waiting_answer' };
  }
  const saved: StoredPlan = { ...stored, deferred: outcome.deferred };
  await status(deps, commandId, outcome.status, null, model, saved);
  return { text: stored.plan.reply, cards: outcome.cards, status: outcome.status };
}

async function quick(
  deps: AssistantDeps,
  command: Extract<AssistantCommand, { action: 'send' }>,
  intent: NonNullable<ReturnType<typeof quickAssistantIntent>>,
  commandId: string
): Promise<{ text: string; cards: Card[] }> {
  const shown = await shownRows(deps, command.teamId, command.contextCardId);
  const engine = engineDeps(deps, command.teamId, commandId, command.timezone, {
    shown: shown.rows
  });
  if (intent === 'review_today' || (intent === 'review' && shown.rows.length === 0)) {
    return { text: '', cards: [await reviewCard(engine, 'today')] };
  }
  if (intent === 'review') return { text: '', cards: [await reviewCard(engine, 'shown')] };
  if (intent === 'undo') {
    const target =
      isRecord(shown.card) && typeof shown.card.commandId === 'string'
        ? shown.card.commandId
        : null;
    if (!target) return { text: '', cards: [refusal('NO_CONTEXT_CARD')] };
    return { text: '', cards: [await undoCommand(deps, command.teamId, target, commandId)] };
  }
  return { text: '', cards: [refusal('USE_BUTTONS')] };
}

/** One model call for a message (masked links), with the space's names and the shown card. */
async function interpretFor(
  deps: AssistantDeps,
  input: {
    teamId: string;
    commandId: string;
    opKey: string | null;
    text: string;
    contextCardId: string | null;
    timezone: string;
  }
) {
  const shown = await shownRows(deps, input.teamId, input.contextCardId);
  const names = await loadNames({ callerRpc: deps.callerRpc, teamId: input.teamId });
  const now = deps.now?.() ?? new Date();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    return await interpretMessage(
      deps.client!,
      {
        today: launchDayInZone(now, input.timezone, 0),
        timezone: input.timezone,
        offers: names.offers.map(item => item.name).slice(0, 120),
        buyers: names.buyers.map(item => item.name).slice(0, 60),
        accounts: [...new Set(names.accounts.map(item => item.account || item.name))]
          .slice(0, 120)
          .map(account => {
            const of = names.accounts.filter(item => (item.account || item.name) === account);
            return `${account} (вільних ${of.filter(item => item.free).length} з ${of.length})`;
          }),
        shownRows: shown.rows
          .slice(0, 40)
          .map(
            row =>
              `${row.n}. ${row.account ?? '—'} · ${row.offer ?? '—'} · ${row.creatives.join(', ') || '—'} · ${row.launchDate ?? '—'}`
          ),
        lastOffer: shown.rows[0]?.offer ?? null,
        message: input.text
      },
      {
        signal: controller.signal,
        record: entry =>
          recordModelUsage(deps.serviceRpc, {
            feature: FEATURE,
            userId: deps.userId,
            subjectId: input.commandId,
            entry,
            opKey: input.opKey
          })
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function sendMessage(
  command: Extract<AssistantCommand, { action: 'send' }>,
  deps: AssistantDeps
): Promise<AssistantResponse> {
  const text = command.text.trim();
  const intent = quickAssistantIntent(text);
  const price = intent ? 0 : assistantMessagePrice(text);
  if (price === null) throw new TeamFunctionError('MESSAGE_TOO_LONG', { retryable: false });
  if (command.expectedPrice !== price || command.priceVersion !== AI_PRICE_VERSION) {
    throw new TeamFunctionError('PRICE_CHANGED', {
      retryable: false,
      details: { price, priceVersion: AI_PRICE_VERSION }
    });
  }
  const context = await service(deps, 'service_assistant_context_v2', {
    p_dialog: command.dialogId,
    p_user: deps.userId,
    p_team: command.teamId
  });
  const canSaveDefaults = isRecord(context) && context.canSaveDefaults === true;
  const started = await begin(
    deps,
    command.teamId,
    command.clientKey,
    'message',
    { text, contextCardId: command.contextCardId, timezone: command.timezone, price },
    text,
    price,
    command.dialogId
  );
  if (started.replayed) {
    return {
      commandId: started.commandId,
      replayed: true,
      message: started.reply,
      credits: await credits(deps)
    };
  }
  const commandId = started.commandId;
  if (intent) {
    const answer = await quick(deps, command, intent, commandId);
    await status(deps, commandId, 'done', null, null, null);
    return {
      commandId,
      replayed: false,
      message: await reply(deps, commandId, answer.text, answer.cards),
      credits: await credits(deps)
    };
  }
  const opKey = `${FEATURE}:${commandId}`;
  try {
    await debitCredits(deps.serviceRpc, {
      userId: deps.userId,
      opKey,
      feature: FEATURE,
      amount: price,
      priceVersion: command.priceVersion,
      subjectId: commandId,
      usdUpper: callUpperUsd(
        ASSISTANT_MODEL.model,
        ASSISTANT_MAX_INPUT_TOKENS,
        ASSISTANT_MAX_OUTPUT_TOKENS
      )
    });
  } catch (error) {
    const code =
      error instanceof CreditRefusal
        ? error.code
        : error instanceof CreditsUnavailable
          ? 'TEAM_TRANSPORT_UNAVAILABLE'
          : null;
    if (!code) throw error;
    await status(deps, commandId, 'rejected', code, null, null);
    const details = error instanceof CreditRefusal ? error.details : undefined;
    return {
      commandId,
      replayed: false,
      message: await reply(deps, commandId, '', [refusal(code, details)]),
      credits: await credits(deps)
    };
  }
  let refunded = false;
  const giveBack = async () => {
    if (!refunded) {
      refunded = true;
      await refundCredits(deps.serviceRpc, deps.userId, opKey);
    }
  };
  try {
    if (!deps.client) {
      await giveBack();
      await status(deps, commandId, 'rejected', 'MODEL_UNAVAILABLE', null, null);
      return {
        commandId,
        replayed: false,
        message: await reply(deps, commandId, '', [refusal('MODEL_UNAVAILABLE')]),
        credits: await credits(deps)
      };
    }
    await status(deps, commandId, 'parsing', null, null, null);
    const masked = extractAssistantUrls(text);
    if (masked.urls.length)
      await service(deps, 'service_assistant_put_urls', {
        p_command: commandId,
        p_urls: masked.urls
      });
    const interpreted = await interpretFor(deps, {
      teamId: command.teamId,
      commandId,
      opKey,
      text: masked.text,
      contextCardId: command.contextCardId,
      timezone: command.timezone
    });
    if (!interpreted.ok) {
      await giveBack();
      await status(deps, commandId, 'rejected', interpreted.code, ASSISTANT_MODEL.model, null);
      return {
        commandId,
        replayed: false,
        message: await reply(deps, commandId, '', [refusal(interpreted.code)]),
        credits: await credits(deps)
      };
    }
    const stored: StoredPlan = {
      plan: interpreted.plan,
      choices: {},
      timezone: command.timezone,
      contextCardId: command.contextCardId,
      urlsFrom: commandId
    };
    await status(deps, commandId, 'executing', null, interpreted.model, stored);
    const result = await runPlan(
      deps,
      command.teamId,
      commandId,
      stored,
      canSaveDefaults,
      interpreted.model
    );
    for (const card of result.cards)
      if (card.kind === 'question' && card.payload.source === 'model')
        card.payload = {
          ...card.payload,
          commandId,
          message: masked.text,
          contextCardId: command.contextCardId
        };
    // A plan refused before any write (too large, nothing resolvable) costs nothing.
    if (result.status === 'rejected') await giveBack();
    else await settleCredits(deps.serviceRpc, opKey);
    return {
      commandId,
      replayed: false,
      message: await reply(deps, commandId, result.text, result.cards),
      credits: await credits(deps)
    };
  } catch (error) {
    // Nothing reached the person: give the credits back. A write that did land is kept and keyed.
    await giveBack();
    await status(
      deps,
      commandId,
      'unknown',
      error instanceof EngineRefusal ? error.code : 'UNAVAILABLE',
      null,
      null
    ).catch(() => {});
    throw error;
  }
}

async function loadCard(
  deps: AssistantDeps,
  teamId: string,
  cardId: string,
  kind: string
): Promise<Record<string, unknown>> {
  const card = await service(deps, 'service_assistant_card', {
    p_user: deps.userId,
    p_team: teamId,
    p_card: cardId
  });
  if (!isRecord(card) || card.kind !== kind || !isRecord(card.payload))
    throw new TeamFunctionError('NOT_FOUND', { retryable: false });
  return card;
}

async function storedPlanOf(deps: AssistantDeps, commandId: string): Promise<StoredPlan> {
  const command = await service(deps, 'service_assistant_command', {
    p_user: deps.userId,
    p_command: commandId
  });
  const stored = isRecord(command) && isRecord(command.plan) ? command.plan : null;
  const plan = stored ? parseAssistantPlan(stored.plan) : null;
  if (!stored || !plan) throw new TeamFunctionError('NOT_FOUND', { retryable: false });
  const deferred = Array.isArray(stored.deferred)
    ? (parseAssistantPlan({ reply: '', actions: stored.deferred })?.actions ?? [])
    : [];
  return {
    plan,
    choices: isRecord(stored.choices) ? (stored.choices as Record<string, string>) : {},
    timezone: typeof stored.timezone === 'string' ? stored.timezone : 'Europe/Kyiv',
    contextCardId: typeof stored.contextCardId === 'string' ? stored.contextCardId : null,
    urlsFrom: typeof stored.urlsFrom === 'string' ? stored.urlsFrom : commandId,
    deferred
  };
}

export async function answerQuestion(
  command: Extract<AssistantCommand, { action: 'answer' }>,
  deps: AssistantDeps
): Promise<AssistantResponse> {
  const card = await loadCard(deps, command.teamId, command.cardId, 'question');
  const payload = card.payload as Record<string, unknown>;
  const options = Array.isArray(payload.options)
    ? (payload.options as Array<{ id: string; label: string }>)
    : [];
  const option = options.find(item => item.id === command.optionId);
  if (!option) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  const started = await begin(
    deps,
    command.teamId,
    command.clientKey,
    'answer',
    { cardId: command.cardId, optionId: command.optionId },
    option.label,
    0,
    command.dialogId
  );
  if (started.replayed)
    return {
      commandId: started.commandId,
      replayed: true,
      message: started.reply,
      credits: await credits(deps)
    };
  const moved = await service(deps, 'service_assistant_card_state', {
    p_card: command.cardId,
    p_from: 'open',
    p_to: 'answered',
    p_patch: { answer: option.id }
  });
  if (moved !== true) {
    await status(deps, started.commandId, 'rejected', 'REVIEW_CHANGED', null, null);
    return {
      commandId: started.commandId,
      replayed: false,
      message: await reply(deps, started.commandId, '', [refusal('REVIEW_CHANGED')]),
      credits: await credits(deps)
    };
  }
  if (
    payload.source !== 'resolve' ||
    typeof payload.commandId !== 'string' ||
    typeof payload.ref !== 'string'
  ) {
    // The model's own question: its message with the chosen option is interpreted once more,
    // at Soty's cost, and the plan runs. The person is not charged again.
    if (payload.source !== 'model' || typeof payload.message !== 'string' || !deps.client) {
      await status(deps, started.commandId, 'rejected', 'MODEL_UNAVAILABLE', null, null);
      return {
        commandId: started.commandId,
        replayed: false,
        message: await reply(deps, started.commandId, '', [refusal('MODEL_UNAVAILABLE')]),
        credits: await credits(deps)
      };
    }
    const contextCardId = typeof payload.contextCardId === 'string' ? payload.contextCardId : null;
    const urlsFrom = typeof payload.commandId === 'string' ? payload.commandId : started.commandId;
    const interpreted = await interpretFor(deps, {
      teamId: command.teamId,
      commandId: started.commandId,
      opKey: null,
      text: `${payload.message}\nУточнення: ${option.label}`,
      contextCardId,
      timezone: command.timezone
    });
    if (!interpreted.ok) {
      await status(
        deps,
        started.commandId,
        'rejected',
        interpreted.code,
        ASSISTANT_MODEL.model,
        null
      );
      return {
        commandId: started.commandId,
        replayed: false,
        message: await reply(deps, started.commandId, '', [refusal(interpreted.code)]),
        credits: await credits(deps)
      };
    }
    // A second question would loop: run what is clear and say what is not.
    const plan = {
      ...interpreted.plan,
      actions: interpreted.plan.actions.filter(action => action.type !== 'ask')
    };
    const context = await service(deps, 'service_assistant_context_v2', {
      p_dialog: command.dialogId,
      p_user: deps.userId,
      p_team: command.teamId
    });
    const again = await runPlan(
      deps,
      command.teamId,
      started.commandId,
      { plan, choices: {}, timezone: command.timezone, contextCardId, urlsFrom },
      isRecord(context) && context.canSaveDefaults === true,
      interpreted.model
    );
    return {
      commandId: started.commandId,
      replayed: false,
      message: await reply(deps, started.commandId, again.text, again.cards),
      credits: await credits(deps)
    };
  }
  const stored = await storedPlanOf(deps, payload.commandId);
  stored.choices = { ...stored.choices, [payload.ref]: option.id };
  const context = await service(deps, 'service_assistant_context_v2', {
    p_dialog: command.dialogId,
    p_user: deps.userId,
    p_team: command.teamId
  });
  const canSaveDefaults = isRecord(context) && context.canSaveDefaults === true;
  const result = await runPlan(
    deps,
    command.teamId,
    started.commandId,
    { ...stored, timezone: command.timezone },
    canSaveDefaults,
    null
  );
  return {
    commandId: started.commandId,
    replayed: false,
    message: await reply(deps, started.commandId, result.text, result.cards),
    credits: await credits(deps)
  };
}

export async function confirmProfile(
  command: Extract<AssistantCommand, { action: 'confirm_profile' }>,
  deps: AssistantDeps
): Promise<AssistantResponse> {
  const card = await loadCard(deps, command.teamId, command.cardId, 'profile');
  const payload = card.payload as Record<string, unknown>;
  const started = await begin(
    deps,
    command.teamId,
    command.clientKey,
    'confirm',
    { cardId: command.cardId },
    null,
    0,
    command.dialogId
  );
  if (started.replayed)
    return {
      commandId: started.commandId,
      replayed: true,
      message: started.reply,
      credits: await credits(deps)
    };
  const commandId = started.commandId;
  const { data, error } = await deps.callerRpc('save_launch_offer_defaults_masked', {
    p_team: command.teamId,
    p_offer: payload.offerId,
    p_mask: payload.mask,
    p_before: payload.before,
    p_values: payload.values,
    p_key: `asst-${commandId.replace(/-/gu, '')}-p`
  });
  if (error) {
    const code = rpcCode(error);
    const reason =
      code === 'EDIT_CONFLICT'
        ? 'EDIT_CONFLICT'
        : code === 'PERMISSION_DENIED'
          ? 'DEFAULTS_FORBIDDEN'
          : 'UNAVAILABLE';
    await status(deps, commandId, 'rejected', reason === 'UNAVAILABLE' ? null : reason, null, null);
    return {
      commandId,
      replayed: false,
      message: await reply(deps, commandId, '', [refusal(reason)]),
      credits: await credits(deps)
    };
  }
  await service(deps, 'service_assistant_effect', {
    p_command: commandId,
    p_step: 0,
    p_row_key: 'profile',
    p_kind: 'defaults_saved',
    p_launch: null,
    p_offer: payload.offerId,
    p_version_before: null,
    p_version_after: isRecord(data) && typeof data.version === 'string' ? data.version : null,
    p_fields: (Array.isArray(payload.mask) ? payload.mask : []).map((path: string) => ({
      path,
      before: isRecord(payload.before) ? (payload.before[path] ?? null) : null,
      after: isRecord(payload.values) ? (payload.values[path] ?? null) : null
    }))
  });
  await service(deps, 'service_assistant_card_state', {
    p_card: command.cardId,
    p_from: 'open',
    p_to: 'confirmed',
    p_patch: {}
  });
  const cards: Card[] = [
    { kind: 'status', payload: { profileSaved: payload.offer, changes: payload.changes } }
  ];
  const source = typeof card.commandId === 'string' ? card.commandId : null;
  if (source) {
    const stored = await storedPlanOf(deps, source).catch(() => null);
    if (stored && stored.deferred && stored.deferred.length > 0) {
      const result = await runPlan(
        deps,
        command.teamId,
        commandId,
        {
          ...stored,
          plan: { reply: '', actions: stored.deferred },
          deferred: [],
          timezone: command.timezone
        },
        true,
        null
      );
      cards.push(...result.cards);
    }
  }
  await status(deps, commandId, 'done', null, null, null);
  return {
    commandId,
    replayed: false,
    message: await reply(deps, commandId, '', cards),
    credits: await credits(deps)
  };
}

export async function showReview(
  command: Extract<AssistantCommand, { action: 'review' }>,
  deps: AssistantDeps
): Promise<AssistantResponse> {
  await service(deps, 'service_assistant_context_v2', {
    p_dialog: command.dialogId,
    p_user: deps.userId,
    p_team: command.teamId
  });
  const started = await begin(
    deps,
    command.teamId,
    command.clientKey,
    'message',
    { review: command.cardId },
    null,
    0,
    command.dialogId
  );
  if (started.replayed)
    return {
      commandId: started.commandId,
      replayed: true,
      message: started.reply,
      credits: await credits(deps)
    };
  const shown = await shownRows(deps, command.teamId, command.cardId);
  const engine = engineDeps(deps, command.teamId, started.commandId, command.timezone, {
    shown: shown.rows
  });
  const card = await reviewCard(engine, command.cardId && shown.rows.length ? 'shown' : 'today');
  await status(deps, started.commandId, 'done', null, null, null);
  return {
    commandId: started.commandId,
    replayed: false,
    message: await reply(deps, started.commandId, '', [card]),
    credits: await credits(deps)
  };
}

/** Reverses what a command did and nothing that changed after it. */
export async function undoCommand(
  deps: AssistantDeps,
  teamId: string,
  target: string,
  commandId: string
): Promise<Card> {
  const data = await service(deps, 'service_assistant_effects', {
    p_user: deps.userId,
    p_command: target
  });
  if (!isRecord(data) || !Array.isArray(data.effects))
    throw new TeamFunctionError('NOT_FOUND', { retryable: false });
  const effects = [...(data.effects as Array<Record<string, unknown>>)].reverse();
  let undone = 0;
  const kept: Array<{ launchId: string | null; code: string }> = [];
  const launchIds = effects.flatMap(effect =>
    typeof effect.launchId === 'string' ? [effect.launchId] : []
  );
  const current = launchIds.length
    ? (
        await cardRows(
          { serviceRpc: deps.serviceRpc, userId: deps.userId, teamId },
          launchIds,
          null
        )
      ).rows
    : [];
  for (const effect of effects) {
    if (effect.undone === true) continue;
    const launchId = typeof effect.launchId === 'string' ? effect.launchId : null;
    const row = current.find(item => item.launchId === launchId);
    const key = `asst-${commandId.replace(/-/gu, '')}-x${effect.step}-${String(effect.rowKey).slice(0, 40)}`;
    if (effect.kind === 'draft_created') {
      if (!row) continue;
      if (row.blocked.some(item => item.code === 'LAUNCHED')) {
        kept.push({ launchId, code: 'LAUNCHED' });
        continue;
      }
      if (row.version !== effect.versionAfter) {
        kept.push({ launchId, code: 'CHANGED_AFTER' });
        continue;
      }
      const { error } = await deps.callerRpc('archive_launch', {
        p_team: teamId,
        p_launch: launchId,
        p_expected_version: row.version,
        p_key: key,
        p_suppress: true
      });
      if (error) {
        kept.push({ launchId, code: rpcCode(error) });
        continue;
      }
    } else if (effect.kind === 'draft_updated') {
      if (!row) continue;
      if (row.blocked.some(item => item.code === 'LAUNCHED')) {
        kept.push({ launchId, code: 'LAUNCHED' });
        continue;
      }
      const detail = await deps.callerRpc('get_launch', {
        p_team: teamId,
        p_launch: launchId,
        p_revision: null
      });
      if (
        detail.error ||
        !isRecord(detail.data) ||
        !isRecord(detail.data.draft) ||
        typeof detail.data.version !== 'string'
      ) {
        kept.push({ launchId, code: 'UNAVAILABLE' });
        continue;
      }
      const draft = structuredClone(detail.data.draft) as Record<string, unknown>;
      let reverted = 0;
      for (const field of (Array.isArray(effect.fields) ? effect.fields : []) as Array<{
        path: string;
        before: unknown;
        after: unknown;
      }>) {
        if (JSON.stringify(draft[field.path] ?? null) !== JSON.stringify(field.after ?? null)) {
          kept.push({ launchId, code: 'FIELD_CHANGED' });
          continue;
        }
        if (field.before === null) delete draft[field.path];
        else draft[field.path] = field.before;
        reverted++;
      }
      if (reverted === 0) continue;
      const { error } = await deps.callerRpc('save_launch_draft', {
        p_team: teamId,
        p_launch: launchId,
        p_expected_version: detail.data.version,
        p_request_key: key,
        p_config: draft,
        p_expected_sources: isRecord(detail.data.expectedSourceSnapshot)
          ? detail.data.expectedSourceSnapshot
          : null
      });
      if (error) {
        kept.push({ launchId, code: rpcCode(error) });
        continue;
      }
    } else if (effect.kind === 'defaults_saved') {
      const fields = (Array.isArray(effect.fields) ? effect.fields : []) as Array<{
        path: string;
        before: unknown;
        after: unknown;
      }>;
      const before = Object.fromEntries(fields.map(field => [field.path, field.after]));
      const values = Object.fromEntries(
        fields.filter(field => field.before !== null).map(field => [field.path, field.before])
      );
      const { error } = await deps.callerRpc('save_launch_offer_defaults_masked', {
        p_team: teamId,
        p_offer: effect.offerId,
        p_mask: fields.map(field => field.path),
        p_before: before,
        p_values: values,
        p_key: key
      });
      if (error) {
        kept.push({
          launchId: null,
          code: rpcCode(error) === 'EDIT_CONFLICT' ? 'FIELD_CHANGED' : rpcCode(error)
        });
        continue;
      }
    }
    await service(deps, 'service_assistant_effect_undone', {
      p_command: target,
      p_step: effect.step,
      p_row_key: effect.rowKey
    });
    undone++;
  }
  if (kept.length === 0) await status(deps, target, 'undone', null, null, null);
  return { kind: 'status', payload: { undone, kept } };
}

export async function undo(
  command: Extract<AssistantCommand, { action: 'undo' }>,
  deps: AssistantDeps
): Promise<AssistantResponse> {
  await service(deps, 'service_assistant_context_v2', {
    p_dialog: command.dialogId,
    p_user: deps.userId,
    p_team: command.teamId
  });
  const started = await begin(
    deps,
    command.teamId,
    command.clientKey,
    'undo',
    { commandId: command.commandId },
    null,
    0,
    command.dialogId
  );
  if (started.replayed)
    return {
      commandId: started.commandId,
      replayed: true,
      message: started.reply,
      credits: await credits(deps)
    };
  const card = await undoCommand(deps, command.teamId, command.commandId, started.commandId);
  await status(deps, started.commandId, 'done', null, null, null);
  return {
    commandId: started.commandId,
    replayed: false,
    message: await reply(deps, started.commandId, '', [card]),
    credits: await credits(deps)
  };
}

export async function handleAssistant(
  command: AssistantCommand,
  deps: AssistantDeps
): Promise<AssistantResponse> {
  switch (command.action) {
    case 'send':
      return sendMessage(command, deps);
    case 'answer':
      return answerQuestion(command, deps);
    case 'confirm_profile':
      return confirmProfile(command, deps);
    case 'review':
      return showReview(command, deps);
    case 'undo':
      return undo(command, deps);
  }
}
