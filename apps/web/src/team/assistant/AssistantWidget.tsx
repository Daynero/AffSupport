/**
 * 064: the space's assistant — a button in the bottom-right corner of every section that opens a
 * small window and folds back into the button. Today it prepares launches; later it answers about
 * budgets, finds creatives, translates. Dialogs are kept as in any AI chat: a list, a new one,
 * and each lives seven days after its last message.
 *
 * Cards come from the server, built from stored rows. Their actions are free and never call a
 * model: open a draft, «Запустити N» (the launch section's own batch, with the versions the card
 * showed), undo, answer a question, save an offer default. Only a typed message costs credits,
 * and its price is on the send button.
 */
import {
  AlertTriangle,
  ArrowUp,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  Minus,
  Play,
  Sparkle,
  Sparkles,
  SquarePen,
  Trash2,
  Undo2
} from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react';
import { createPortal } from 'react-dom';
import {
  assistantMessagePrice,
  ASSISTANT_MESSAGE_MAX_CHARACTERS,
  characterCount,
  quickAssistantIntent,
  type AssistantCard,
  type AssistantMessage,
  type AssistantRow
} from '@video-compressor/shared';
import {
  assistantApi,
  type AssistantConversation,
  type AssistantDialog
} from '../../api/assistant';
import { launchApi } from '../../api/launches';
import { TeamApiError } from '../../api/team';
import { CreditsButton } from '../../credits/CreditsButton';
import { Button, DropdownMenu, IconButton, Spinner } from '../../components/ui/index.js';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons.js';
import { kyivTime, setCredits, useCredits } from '../../credits/store';
import { assistantDraftsKey, useI18n, type TranslationKey } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { observeAssistant } from './analytics';
import { launchRows, notifyLaunchesChanged, openLaunch } from './bridge';

const REASON_COPY: Readonly<Record<string, TranslationKey>> = {
  INSUFFICIENT_CREDITS: 'aiInsufficientCredits',
  AI_MONTH_EXHAUSTED: 'aiMonthExhausted',
  PRICE_CHANGED: 'aiPriceChanged',
  MODEL_UNAVAILABLE: 'assistantModelUnavailable',
  MODEL_OUTPUT_REJECTED: 'assistantOutputRejected',
  PLAN_TOO_LARGE: 'assistantPlanTooLarge',
  REVIEW_CHANGED: 'assistantAlreadyAnswered',
  EDIT_CONFLICT: 'assistantEditConflict',
  NO_CONTEXT_CARD: 'assistantNoContext',
  USE_BUTTONS: 'assistantUseButtons',
  DEFAULTS_FORBIDDEN: 'assistantDefaultsForbidden',
  OFFER_NOT_FOUND: 'assistantNotFoundQuoted',
  ACCOUNT_NOT_FOUND: 'assistantNotFoundQuoted',
  MATERIAL_NOT_FOUND: 'assistantNotFoundQuoted',
  NOT_FOUND: 'assistantNotFoundQuoted',
  NO_FREE_ACCOUNTS: 'assistantNoFreeAccounts',
  OFFER_CREATE_FORBIDDEN: 'assistantOfferForbidden',
  FIELD_FORM_ONLY: 'assistantFieldFormOnly',
  FIELD_NOT_SUPPORTED: 'assistantFieldFormOnly',
  INVALID_VALUE: 'assistantInvalidValue',
  OP_NOT_ALLOWED: 'assistantInvalidValue',
  NOT_CATALOG: 'assistantNotCatalog',
  LAUNCHED: 'assistantLaunchedRow',
  CHANGED_AFTER: 'assistantChangedAfter',
  FIELD_CHANGED: 'assistantFieldChanged'
};

/** What a blocked draft still needs, in words of the form. */
const FIELD_COPY: ReadonlyArray<[RegExp, TranslationKey]> = [
  [/^agentRowId$/u, 'assistantFieldAccount'],
  [/^offerId$/u, 'assistantFieldOffer'],
  [/^buyerId$/u, 'assistantFieldBuyer'],
  [/^(materialId|creatives|creativeAlias|creativeKind)$/u, 'assistantFieldCreative'],
  [/^originalUrl$/u, 'assistantFieldUrl'],
  [/^(launchDate|timezone)$/u, 'assistantFieldDate'],
  [/^(minBudget|maxBudget|budgets|budgetMode)$/u, 'assistantFieldBudget'],
  [/^(campaignCount|adsCount)$/u, 'assistantFieldCampaigns'],
  [/^catalog/u, 'assistantFieldCatalog']
];

const PROFILE_FIELD_COPY: Readonly<Record<string, TranslationKey>> = {
  campaignCount: 'assistantFieldCampaignCount',
  adsCount: 'assistantFieldAdsCount',
  minBudget: 'assistantFieldMinBudget',
  maxBudget: 'assistantFieldMaxBudget',
  budgetMode: 'assistantFieldBudgetMode',
  budgets: 'assistantFieldBudgets',
  'catalog.productCount': 'assistantFieldProducts',
  'catalog.copyVideoToR2': 'assistantFieldR2',
  'catalog.restitchEnabled': 'assistantFieldRestitch',
  originalUrl: 'assistantFieldUrl',
  buyerId: 'assistantFieldBuyer',
  launchDate: 'assistantFieldDate',
  'subConfig.sub1': 'assistantFieldSub1',
  'subConfig.sub2': 'assistantFieldSub2',
  'subConfig.sub3': 'assistantFieldSub3'
};

const OPEN_KEY = 'soty.assistant.open';

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOpen(value: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, value ? '1' : '0');
  } catch {
    /* a per-viewer convenience only */
  }
}

function key(): string {
  return crypto.randomUUID().replace(/-/gu, '');
}

function stem(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/u, '');
}

export interface AssistantWidgetProps {
  teamId: string;
  canEdit: boolean;
}

export function AssistantWidget({ teamId, canEdit }: AssistantWidgetProps) {
  const { t, language } = useI18n();
  const credits = useCredits(canEdit);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [dialogId, setDialogId] = useState<string | null>(null);
  const [dialogs, setDialogs] = useState<AssistantDialog[]>([]);
  const [text, setText] = useState('');
  // What is waiting, kept apart so one wait does not light up every button in the dialog: the
  // model reading a message, one card acting (its own buttons only), a dialog being opened.
  const [thinking, setThinking] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const busy = thinking || pending !== null || switching;
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState(readOpen);
  const [menu, setMenu] = useState(false);
  const [focused, setFocused] = useState(false);
  const pendingKey = useRef<{ text: string; key: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const fab = useRef<HTMLButtonElement>(null);

  const apply = (conversation: AssistantConversation) => {
    setDialogId(conversation.conversationId);
    setDialogs(conversation.dialogs);
    setMessages(conversation.messages);
    setCredits(conversation.credits);
    setError(null);
  };

  useEffect(() => {
    if (!canEdit) return;
    let live = true;
    assistantApi
      .open(teamId)
      .then(conversation => {
        if (!live) return;
        setEnabled(conversation.enabled);
        apply(conversation);
      })
      .catch(() => live && setEnabled(false));
    const reveal = () => {
      setPanel(true);
      writeOpen(true);
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener('soty:open-assistant', reveal);
    return () => {
      live = false;
      window.removeEventListener('soty:open-assistant', reveal);
    };
  }, [teamId, canEdit]);

  useEffect(() => {
    const last = list.current?.lastElementChild as HTMLElement | null | undefined;
    if (last && typeof last.scrollIntoView === 'function')
      last.scrollIntoView({ block: 'nearest' });
  }, [messages.length, panel]);

  // The field grows with the text, from one line to about six.
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [text, enabled, panel]);

  // The card «у другому» refers to: the newest card with rows.
  const contextCard = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const card = messages[i]!.cards.find(
        c =>
          (c.kind === 'result' || c.kind === 'review') &&
          Array.isArray(c.payload.rows) &&
          (c.payload.rows as unknown[]).length > 0
      );
      if (card) return card.id;
    }
    return null;
  }, [messages]);

  if (!canEdit || enabled !== true) return null;

  const trimmed = text.trim();
  const free = quickAssistantIntent(trimmed) !== null;
  const price = trimmed ? (free ? 0 : assistantMessagePrice(trimmed)) : null;
  const count = characterCount(text);
  const available = credits.status?.available ?? null;
  const short =
    price !== null && price > 0 && available !== null && available < price ? price - available : 0;
  const tooLong = count > ASSISTANT_MESSAGE_MAX_CHARACTERS;

  // Opening puts the cursor in the field. Folding gives focus back to the corner button only
  // from the keyboard (Escape): after a mouse click its focus ring was a stray frame.
  const toggle = (value: boolean, fromKeyboard = false) => {
    setPanel(value);
    writeOpen(value);
    if (value) requestAnimationFrame(() => input.current?.focus());
    else if (fromKeyboard) requestAnimationFrame(() => fab.current?.focus());
  };

  const switchDialog = async (next: string) => {
    setSwitching(true);
    try {
      apply(
        next === 'new'
          ? await assistantApi.newDialog(teamId)
          : await assistantApi.open(teamId, next)
      );
      requestAnimationFrame(() => input.current?.focus());
    } catch (caught) {
      setError(teamErrorMessageFor(caught, t));
    } finally {
      setSwitching(false);
    }
  };

  const dayLabel = (date: string | null) => {
    if (!date) return null;
    const today = new Date();
    const local = (offset: number) => {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
      return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    };
    if (date === local(0)) return t('assistantToday');
    if (date === local(1)) return t('assistantTomorrow');
    return new Date(`${date}T12:00:00`).toLocaleDateString(language, {
      day: 'numeric',
      month: 'short'
    });
  };

  const reasonText = (code: string, written?: string) => {
    const copy = REASON_COPY[code];
    return copy
      ? t(copy, { written: written ?? '', text: written ?? '' })
      : t('assistantUnavailable');
  };

  const missing = (item: AssistantRow) => {
    if (item.blocked.some(entry => entry.code === 'LAUNCHED')) return t('assistantLaunchedRow');
    const words = new Set<string>();
    for (const entry of item.blocked) {
      const match = FIELD_COPY.find(([pattern]) => pattern.test(entry.field));
      words.add(t(match ? match[1] : 'assistantFieldOther'));
    }
    return words.size ? t('assistantMissing', { fields: [...words].join(', ') }) : null;
  };

  const take = async (
    run: () => Promise<{ message: AssistantMessage | null; credits: unknown }>,
    optimistic?: AssistantMessage,
    cardId?: string
  ) => {
    if (cardId) setPending(cardId);
    else setThinking(true);
    setError(null);
    if (optimistic) setMessages(current => [...current, optimistic]);
    try {
      const reply = await run();
      setCredits(reply.credits as never);
      if (reply.message) setMessages(current => [...current, reply.message!]);
      if (optimistic && dialogId && !dialogs.find(dialog => dialog.id === dialogId)?.title) {
        // The first message names the dialog on the server; show it without another read.
        const title = optimistic.text.slice(0, 80);
        setDialogs(current =>
          current.some(dialog => dialog.id === dialogId)
            ? current.map(dialog => (dialog.id === dialogId ? { ...dialog, title } : dialog))
            : [{ id: dialogId, title, lastActiveAt: new Date().toISOString() }, ...current]
        );
      }
      notifyLaunchesChanged(teamId);
      return true;
    } catch (caught) {
      setError(teamErrorMessageFor(caught, t));
      return false;
    } finally {
      if (cardId) setPending(null);
      else setThinking(false);
    }
  };

  const send = async () => {
    if (busy || !trimmed || price === null || short > 0 || tooLong) return;
    const clientKey = pendingKey.current?.text === trimmed ? pendingKey.current.key : key();
    pendingKey.current = { text: trimmed, key: clientKey };
    const flow = observeAssistant('send');
    const ok = await take(
      () =>
        assistantApi.send({
          teamId,
          dialogId,
          text: trimmed,
          clientKey,
          price,
          contextCardId: contextCard
        }),
      {
        id: -Date.now(),
        role: 'user',
        text: trimmed,
        price,
        commandId: null,
        createdAt: new Date().toISOString(),
        cards: []
      }
    );
    flow.finish(ok ? 'success' : 'failure');
    if (ok) {
      pendingKey.current = null;
      setText('');
    }
  };

  // Enter sends, Shift+Enter breaks the line, as in every chat; Escape folds the window.
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    } else if (event.key === 'Escape' && !text) {
      toggle(false, true);
    }
  };

  const markCard = (cardId: string, patch: Partial<AssistantCard>) =>
    setMessages(current =>
      current.map(message => ({
        ...message,
        cards: message.cards.map(card => (card.id === cardId ? { ...card, ...patch } : card))
      }))
    );

  const launch = async (card: AssistantCard) => {
    const rows = ((card.payload.rows as AssistantRow[]) ?? []).filter(
      item => item.blocked.length === 0
    );
    if (!rows.length || busy) return;
    const batchKey =
      typeof card.payload.batchKey === 'string' ? card.payload.batchKey : crypto.randomUUID();
    const flow = observeAssistant('launch');
    setPending(card.id);
    setError(null);
    try {
      await assistantApi.reviewLaunched(card.id, batchKey);
      await launchRows(
        teamId,
        rows.map(item => ({ launchId: item.launchId, version: item.version })),
        batchKey
      );
      markCard(card.id, { state: 'launched', payload: { ...card.payload, batchKey } });
      flow.finish('success');
    } catch (caught) {
      flow.finish('failure');
      // A card from earlier in the dialog shows drafts as they were; changed or removed since,
      // they are not launched, and the person is told how to get a current card.
      const code = caught instanceof TeamApiError ? caught.code : null;
      setError(
        code === 'REVIEW_CHANGED' || code === 'NOT_FOUND' || code === 'LAUNCH_VERSION_CONFLICT'
          ? t('assistantCardStale')
          : teamErrorMessageFor(caught, t)
      );
    } finally {
      setPending(null);
    }
  };

  // «Видалити N»: the person's own archive of each draft, with the version the card showed.
  const archive = async (card: AssistantCard) => {
    const rows = (card.payload.rows as AssistantRow[]) ?? [];
    if (!rows.length || busy) return;
    setPending(card.id);
    setError(null);
    let failed = 0;
    for (const item of rows) {
      try {
        await launchApi.archive(teamId, item.launchId, item.version, key(), false);
      } catch {
        failed++;
      }
    }
    try {
      if (failed < rows.length) await assistantApi.cardConfirmed(card.id);
    } catch {
      /* the drafts are gone either way; the card only remembers it */
    }
    markCard(card.id, {
      state: failed < rows.length ? 'confirmed' : card.state,
      payload: { ...card.payload, archived: rows.length - failed, failed }
    });
    if (failed) setError(t('assistantArchiveFailed', { count: failed }));
    notifyLaunchesChanged(teamId);
    setPending(null);
  };

  const answer = (card: AssistantCard, optionId: string) => {
    markCard(card.id, { state: 'answered', payload: { ...card.payload, answer: optionId } });
    void take(() => assistantApi.answer(teamId, dialogId, card.id, optionId, key()));
  };

  // «Кампаній: — → 3», not «campaignCount: — → 3»: the words of the form, values without JSON.
  const fieldName = (path: string) => {
    const key = PROFILE_FIELD_COPY[path];
    return key ? t(key) : path;
  };
  const fieldValue = (raw: string | null) => {
    if (raw === null) return '—';
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      /* a plain string */
    }
    if (value === true) return t('assistantValueYes');
    if (value === false) return t('assistantValueNo');
    if (value === null || value === '') return '—';
    if (value === 'auto') return t('assistantBudgetRange');
    if (value === 'single') return t('assistantBudgetSingle');
    if (value === 'manual') return t('assistantBudgetManual');
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  };

  const row = (item: AssistantRow, openable: boolean) => {
    const need = missing(item);
    const facts = [
      item.campaignCount !== null
        ? t('assistantCampaignsShort', { count: item.campaignCount })
        : null,
      item.productCount !== null ? t('assistantProductsShort', { count: item.productCount }) : null,
      item.budget ? `${item.budget} $` : null,
      item.r2 ? t('assistantR2Short') : null
    ].filter(Boolean);
    return (
      <li key={item.launchId} className="assistant-row">
        <span className="assistant-row-line">
          <span className={`assistant-chip${item.account ? '' : ' is-missing'}`}>
            {item.account ?? t('assistantFieldAccount')}
          </span>
          {item.offer && <span className="assistant-row-offer">{item.offer}</span>}
          {item.creatives.map(name => (
            <span key={name} className="assistant-chip is-creative">
              {stem(name)}
            </span>
          ))}
          {openable && (
            <IconButton
              size="xs"
              variant="ghost"
              className="assistant-row-open"
              label={t('assistantOpenLaunch')}
              onClick={() => {
                // The launch opens over the space; the window folds so it does not cover the form.
                openLaunch(teamId, item.launchId);
                toggle(false);
              }}
            >
              <ArrowUpRight size={14} strokeWidth={ICON_STROKE} />
            </IconButton>
          )}
        </span>
        {(facts.length > 0 || need) && (
          <span className="assistant-row-line is-sub">
            {facts.length > 0 && <span className="assistant-row-facts">{facts.join(' · ')}</span>}
            {need && (
              <span className="assistant-row-need">
                <AlertTriangle size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                {need}
              </span>
            )}
          </span>
        )}
      </li>
    );
  };

  const rowsCard = (card: AssistantCard, message: AssistantMessage) => {
    const payload = card.payload as Record<string, unknown>;
    const rows = (payload.rows as AssistantRow[] | undefined) ?? [];
    const unresolved = (payload.unresolved as Array<{ code: string; written: string }>) ?? [];
    const ready = rows.filter(item => item.blocked.length === 0).length;
    const date = dayLabel(
      typeof payload.date === 'string' ? payload.date : (rows[0]?.launchDate ?? null)
    );
    const launched = card.state === 'launched';
    const removing = payload.purpose === 'archive';
    const removed = removing && card.state === 'confirmed';
    const kept = typeof payload.launchedKept === 'number' ? payload.launchedKept : 0;
    const created = Array.isArray(payload.createdOffers) ? (payload.createdOffers as string[]) : [];
    return (
      <section
        key={card.id}
        className={`assistant-card${card.state === 'undone' ? ' is-undone' : ''}`}
      >
        {rows.length > 0 && (
          <p className="assistant-card-title">
            {removing ? (
              <Trash2 size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            ) : (
              <CheckCircle2 size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            )}
            {[
              removing
                ? t('assistantArchiveTitle', { count: rows.length })
                : t(assistantDraftsKey(language, rows.length), { count: rows.length }),
              date
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
        {created.length > 0 && (
          <p className="assistant-note is-success">
            <CheckCircle2 size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('assistantOfferCreated', { name: created.join(', ') })}
          </p>
        )}
        {rows.length === 0 && card.kind === 'review' && (
          <p className="assistant-note">
            {t(removing ? 'assistantArchiveEmpty' : 'assistantReviewEmpty')}
          </p>
        )}
        {kept > 0 && (
          <p className="assistant-note">{t('assistantArchiveKeptLaunched', { count: kept })}</p>
        )}
        {rows.length > 0 && (
          <ul className="assistant-rows">
            {rows.map(item => row(item, !removed && card.state !== 'undone'))}
          </ul>
        )}
        {unresolved.length > 0 && (
          <ul className="assistant-notes">
            {unresolved.map((item, index) => (
              <li key={index} className="assistant-note is-warning">
                <AlertTriangle size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                {reasonText(item.code, item.written)}
              </li>
            ))}
          </ul>
        )}
        {payload.truncated === true && (
          <p className="assistant-note">{t('assistantReviewTruncated')}</p>
        )}
        {rows.length > 0 && removing && (
          <div className="assistant-card-actions">
            {removed ? (
              <span className="assistant-note is-success">
                <CheckCircle2 size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                {t('assistantArchived', {
                  count: typeof payload.archived === 'number' ? payload.archived : rows.length
                })}
              </span>
            ) : (
              <Button
                size="sm"
                color="error"
                variant="soft"
                loading={pending === card.id}
                disabled={busy && pending !== card.id}
                leading={<Trash2 size={16} strokeWidth={ICON_STROKE} />}
                onClick={() => void archive(card)}
              >
                {t('assistantArchive', { count: rows.length })}
              </Button>
            )}
          </div>
        )}
        {rows.length > 0 && !removing && card.state === 'undone' && (
          <p className="assistant-note">
            <Undo2 size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('assistantCardUndone')}
          </p>
        )}
        {rows.length > 0 && !removing && card.state !== 'undone' && (
          <div className="assistant-card-actions">
            {launched ? (
              <span className="assistant-note is-success">
                <CheckCircle2 size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                {t('assistantLaunched')}
              </span>
            ) : (
              ready > 0 && (
                <Button
                  size="sm"
                  variant="primary"
                  loading={pending === card.id}
                  disabled={busy && pending !== card.id}
                  leading={<Play size={16} strokeWidth={ICON_STROKE} />}
                  onClick={() => void launch(card)}
                >
                  {t('assistantLaunch', { count: ready })}
                </Button>
              )
            )}
            {card.kind === 'result' && message.commandId && !launched && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                leading={<Undo2 size={16} strokeWidth={ICON_STROKE} />}
                onClick={() =>
                  void take(
                    () => assistantApi.undo(teamId, dialogId, message.commandId!, key()),
                    undefined,
                    card.id
                  ).then(ok => {
                    if (ok) markCard(card.id, { state: 'undone' });
                  })
                }
              >
                {t('assistantUndo')}
              </Button>
            )}
          </div>
        )}
      </section>
    );
  };

  const renderCard = (card: AssistantCard, message: AssistantMessage) => {
    const payload = card.payload as Record<string, unknown>;
    switch (card.kind) {
      case 'result':
      case 'review':
        return rowsCard(card, message);
      case 'question': {
        const options = (payload.options as Array<{ id: string; label: string }>) ?? [];
        return (
          <div key={card.id} className="assistant-question">
            <p className="assistant-text">{String(payload.about ?? '')}</p>
            <div className="assistant-card-actions">
              {options.map(option => (
                <Button
                  key={option.id}
                  size="xs"
                  variant={
                    card.state === 'answered' && payload.answer === option.id ? 'soft' : 'outline'
                  }
                  disabled={thinking || card.state !== 'open'}
                  onClick={() => answer(card, option.id)}
                >
                  {stem(option.label)}
                </Button>
              ))}
            </div>
          </div>
        );
      }
      case 'profile': {
        const changes =
          (payload.changes as Array<{ field: string; from: string | null; to: string }>) ?? [];
        return (
          <section key={card.id} className="assistant-card">
            <p className="assistant-card-title">
              {t('assistantProfileTitle', { offer: String(payload.offer ?? '') })}
            </p>
            <div className="assistant-card-actions">
              {changes.map((change, index) => (
                <span key={index} className="assistant-chip">
                  {`${fieldName(change.field)}: ${fieldValue(change.from)} → ${fieldValue(change.to)}`}
                </span>
              ))}
            </div>
            {card.state === 'open' && (
              <div className="assistant-card-actions">
                <Button
                  size="sm"
                  variant="primary"
                  loading={pending === card.id}
                  disabled={busy && pending !== card.id}
                  onClick={() =>
                    void take(
                      () => assistantApi.confirmProfile(teamId, dialogId, card.id, key()),
                      undefined,
                      card.id
                    ).then(ok => {
                      if (ok) markCard(card.id, { state: 'confirmed' });
                    })
                  }
                >
                  {t('assistantProfileSave')}
                </Button>
              </div>
            )}
          </section>
        );
      }
      case 'status': {
        if (Array.isArray(payload.offersCreated))
          return (
            <p key={card.id} className="assistant-note is-success">
              <CheckCircle2 size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {t('assistantOfferCreated', { name: (payload.offersCreated as string[]).join(', ') })}
            </p>
          );
        if (typeof payload.profileSaved === 'string')
          return (
            <p key={card.id} className="assistant-note is-success">
              <CheckCircle2 size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {t('assistantProfileSaved', { offer: payload.profileSaved })}
            </p>
          );
        const kept = (payload.kept as Array<{ code: string }>) ?? [];
        return (
          <p key={card.id} className="assistant-note">
            <Undo2 size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('assistantUndone', { count: Number(payload.undone ?? 0) })}
            {kept.length > 0 &&
              ` · ${t('assistantKept', { count: kept.length })}: ${[...new Set(kept.map(k => reasonText(k.code)))].join('; ')}`}
          </p>
        );
      }
      case 'refusal': {
        const details = (payload.details as Record<string, unknown> | undefined) ?? {};
        return (
          <p key={card.id} className="assistant-note is-warning" role="status">
            <AlertTriangle size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {reasonText(
              String(payload.code),
              typeof details.text === 'string' ? details.text : undefined
            )}
          </p>
        );
      }
      default:
        return null;
    }
  };

  const sendLabel = price
    ? t(price === 1 ? 'assistantSendPrice' : 'assistantSendPriceFew', { price })
    : t('assistantSendFree');
  // A dialog is named by its first message; shown as a title, it starts with a capital letter.
  const titled = (title: string | null) =>
    title ? title.charAt(0).toLocaleUpperCase(language) + title.slice(1) : null;
  const currentTitle =
    titled(dialogs.find(dialog => dialog.id === dialogId)?.title ?? null) ?? t('assistantTitle');
  // Today's dialogs differ by the hour, older ones by the day.
  const when = (at: string) => {
    const date = new Date(at);
    return date.toDateString() === new Date().toDateString()
      ? date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString(language, { day: 'numeric', month: 'short' });
  };

  // On the page itself, not inside the section: a section's route transition moves its content,
  // and a fixed corner inside moving content jumped with every click between sections.
  const dock = (content: ReactNode) => createPortal(content, document.body);

  if (!panel) {
    return dock(
      <div className="assistant-dock">
        <Button
          ref={fab}
          size="md"
          variant="primary"
          className="assistant-fab"
          leading={<Sparkles size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
          onClick={() => toggle(true)}
        >
          {t('assistantTitle')}
        </Button>
      </div>
    );
  }

  return dock(
    <div className="assistant-dock">
      <section className="assistant-window" aria-label={t('assistantTitle')}>
        <header className="assistant-head">
          <button
            ref={menuAnchor}
            type="button"
            className="assistant-dialog-switch"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(value => !value)}
          >
            <Sparkles size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span className="assistant-dialog-title">{currentTitle}</span>
            <ChevronDown size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
          <DropdownMenu
            open={menu}
            onClose={() => setMenu(false)}
            anchor={menuAnchor}
            label={t('assistantDialogs')}
            selection="single"
            maxHeight={360}
            items={[
              { heading: t('assistantDialogs') },
              ...dialogs.map(dialog => ({
                id: dialog.id,
                label: titled(dialog.title) ?? t('assistantNewDialog'),
                checked: dialog.id === dialogId,
                trailing: when(dialog.lastActiveAt),
                onSelect: () => void switchDialog(dialog.id)
              }))
            ]}
          />
          <CreditsButton compact offerAssistant={false} />
          <IconButton
            size="sm"
            label={t('assistantNewDialog')}
            disabled={switching || thinking}
            onClick={() => void switchDialog('new')}
          >
            <SquarePen size={ICON_SIZE} strokeWidth={ICON_STROKE} />
          </IconButton>
          <IconButton size="sm" label={t('assistantMinimize')} onClick={() => toggle(false)}>
            <Minus size={ICON_SIZE} strokeWidth={ICON_STROKE} />
          </IconButton>
        </header>
        <ol
          ref={list}
          className={`assistant-thread${switching ? ' is-switching' : ''}`}
          aria-live="polite"
          aria-busy={switching || thinking}
        >
          {messages.length === 0 && (
            <li className="assistant-empty">
              <p className="assistant-text">{t('assistantEmpty')}</p>
              <div className="assistant-examples">
                {(['assistantExample1', 'assistantExample2', 'assistantExample3'] as const).map(
                  example => (
                    <Button
                      key={example}
                      size="xs"
                      variant="outline"
                      onClick={() => setText(t(example))}
                    >
                      {t(example)}
                    </Button>
                  )
                )}
              </div>
            </li>
          )}
          {messages.map(message => (
            <li key={message.id} className={`assistant-message is-${message.role}`}>
              {message.text && <p className="assistant-text">{message.text}</p>}
              {message.cards.map(card => renderCard(card, message))}
            </li>
          ))}
          {thinking && (
            <li className="assistant-message is-assistant">
              <p className="assistant-note">
                <Spinner /> {t('assistantThinking')}
              </p>
            </li>
          )}
        </ol>
        {error && (
          <p className="assistant-note is-warning assistant-error" role="alert">
            <AlertTriangle size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {error}
          </p>
        )}
        <div
          className={`assistant-bar${focused ? ' is-focused' : ''}${tooLong ? ' is-invalid' : ''}`}
        >
          <textarea
            ref={input}
            rows={1}
            className="assistant-input"
            value={text}
            aria-label={t('assistantTitle')}
            placeholder={t('assistantPlaceholderShort')}
            aria-invalid={tooLong || undefined}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={event => setText(event.target.value)}
            onKeyDown={onKey}
          />
          {count > ASSISTANT_MESSAGE_MAX_CHARACTERS - 500 && (
            <span className="assistant-note">{t('assistantCounter', { count })}</span>
          )}
          {short > 0 && credits.status ? (
            <span className="assistant-note is-warning">
              {t('assistantShort', {
                missing: short,
                time: kyivTime(credits.status.resetsAt, language)
              })}
            </span>
          ) : (
            price !== null &&
            price > 0 && (
              <span className="assistant-price" aria-hidden="true">
                <Sparkle size={12} strokeWidth={ICON_STROKE} />
                {price}
              </span>
            )
          )}
          <IconButton
            size="sm"
            color="primary"
            variant="solid"
            label={sendLabel}
            loading={thinking}
            disabled={busy || !trimmed || price === null || short > 0 || tooLong}
            onClick={() => void send()}
          >
            <ArrowUp size={ICON_SIZE} strokeWidth={ICON_STROKE} />
          </IconButton>
        </div>
        <p className="assistant-retention">{t('assistantRetention')}</p>
      </section>
    </div>
  );
}
