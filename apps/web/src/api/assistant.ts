/**
 * 064: the browser side of the launch assistant and of credits.
 *
 * Reads go through functions that check the caller (assistant_open, ai_credits_status); actions go
 * to the `assistant` edge function. Nothing here decides rights, prices or what a card shows: the
 * server does, and the browser renders what came back.
 */
import {
  AI_PRICE_VERSION,
  parseAiCreditsStatus,
  parseAssistantMessage,
  type AiCreditsStatus,
  type AssistantMessage
} from '@video-compressor/shared';
import { requireSupabaseClient, withFreshSession } from '../lib/supabase.js';
import { invokeTeamFunction, TeamApiError, throwRpc } from './team.js';

const FUNCTION = 'assistant';

export interface AssistantDialog {
  id: string;
  title: string | null;
  lastActiveAt: string;
}

export interface AssistantConversation {
  enabled: boolean;
  canSaveDefaults: boolean;
  /** The dialog that is open; the server picks the most recent when none was asked for. */
  conversationId: string | null;
  title: string | null;
  /** The person's live dialogs in this space, newest first (each lives seven days). */
  dialogs: AssistantDialog[];
  messages: AssistantMessage[];
  credits: AiCreditsStatus | null;
}

export interface AssistantReply {
  commandId: string;
  replayed: boolean;
  message: AssistantMessage | null;
  credits: AiCreditsStatus | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseReply(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.commandId === 'string';
}

function reply(value: Record<string, unknown>): AssistantReply {
  return {
    commandId: value.commandId as string,
    replayed: value.replayed === true,
    message: value.message ? parseAssistantMessage(value.message) : null,
    credits: parseAiCreditsStatus(value.credits)
  };
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Kyiv';
  } catch {
    return 'Europe/Kyiv';
  }
}

async function act(body: Record<string, unknown>, signal?: AbortSignal): Promise<AssistantReply> {
  const value = await invokeTeamFunction(FUNCTION, body, parseReply, signal ? { signal } : {});
  return reply(value);
}

function conversation(data: unknown): AssistantConversation {
  if (!isRecord(data) || typeof data.enabled !== 'boolean')
    throw new TeamApiError('INVALID_RESPONSE', false);
  const messages = Array.isArray(data.messages) ? data.messages.map(parseAssistantMessage) : [];
  if (messages.some(message => message === null)) throw new TeamApiError('INVALID_RESPONSE', false);
  const dialogs = Array.isArray(data.dialogs)
    ? data.dialogs.flatMap(item =>
        isRecord(item) && typeof item.id === 'string' && typeof item.lastActiveAt === 'string'
          ? [
              {
                id: item.id,
                title: typeof item.title === 'string' ? item.title : null,
                lastActiveAt: item.lastActiveAt
              }
            ]
          : []
      )
    : [];
  return {
    enabled: data.enabled,
    canSaveDefaults: data.canSaveDefaults === true,
    conversationId: typeof data.conversationId === 'string' ? data.conversationId : null,
    title: typeof data.title === 'string' ? data.title : null,
    dialogs,
    messages: messages as AssistantMessage[],
    credits: parseAiCreditsStatus(data.credits)
  };
}

export const assistantApi = {
  async open(teamId: string, dialogId: string | null = null): Promise<AssistantConversation> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('assistant_open_dialog', { p_team: teamId, p_dialog: dialogId })
    );
    throwRpc(error);
    return conversation(data);
  },
  async newDialog(teamId: string): Promise<AssistantConversation> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('assistant_new_dialog', { p_team: teamId })
    );
    throwRpc(error);
    return conversation(data);
  },
  send(
    input: {
      teamId: string;
      dialogId: string | null;
      text: string;
      clientKey: string;
      price: number;
      contextCardId: string | null;
      previousCommandIds?: string[];
    },
    signal?: AbortSignal
  ) {
    return act(
      {
        action: 'send',
        teamId: input.teamId,
        conversationId: input.dialogId,
        text: input.text,
        clientKey: input.clientKey,
        expectedPrice: input.price,
        priceVersion: AI_PRICE_VERSION,
        contextCardId: input.contextCardId,
        previousCommandIds: input.previousCommandIds ?? [],
        timezone: browserTimezone()
      },
      signal
    );
  },
  answer(
    teamId: string,
    dialogId: string | null,
    cardId: string,
    optionId: string,
    clientKey: string
  ) {
    return act({
      action: 'answer',
      teamId,
      conversationId: dialogId,
      cardId,
      optionId,
      clientKey,
      timezone: browserTimezone()
    });
  },
  confirmProfile(teamId: string, dialogId: string | null, cardId: string, clientKey: string) {
    return act({
      action: 'confirm_profile',
      teamId,
      conversationId: dialogId,
      cardId,
      clientKey,
      timezone: browserTimezone()
    });
  },
  review(teamId: string, dialogId: string | null, cardId: string | null, clientKey: string) {
    return act({
      action: 'review',
      teamId,
      conversationId: dialogId,
      cardId,
      clientKey,
      timezone: browserTimezone()
    });
  },
  undo(teamId: string, dialogId: string | null, commandId: string, clientKey: string) {
    return act({ action: 'undo', teamId, conversationId: dialogId, commandId, clientKey });
  },
  /** Ties a review card to the batch key the browser submits next; replays for the same key. */
  async reviewLaunched(cardId: string, batchKey: string): Promise<void> {
    const { error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('assistant_review_launched', {
        p_card: cardId,
        p_batch_key: batchKey
      })
    );
    throwRpc(error);
  },
  /** The drafts of an «archive» card were removed: the card shows it as done from now on. */
  /** «Не треба»: an open card the person decided against stays in the dialog, without a button. */
  async cardDismissed(cardId: string): Promise<void> {
    const { error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('assistant_card_dismissed', { p_card: cardId })
    );
    throwRpc(error);
  },
  async cardConfirmed(cardId: string): Promise<void> {
    const { error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('assistant_card_confirmed', { p_card: cardId })
    );
    throwRpc(error);
  },
  async launchMarks(teamId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('assistant_launch_marks', {
        p_team: teamId,
        p_ids: ids.slice(0, 500)
      })
    );
    throwRpc(error);
    return new Set(
      Array.isArray(data)
        ? (data as unknown[]).filter((id): id is string => typeof id === 'string')
        : []
    );
  }
};

export const creditsApi = {
  async status(): Promise<AiCreditsStatus> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('ai_credits_status')
    );
    throwRpc(error);
    const parsed = parseAiCreditsStatus(data);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed;
  }
};
