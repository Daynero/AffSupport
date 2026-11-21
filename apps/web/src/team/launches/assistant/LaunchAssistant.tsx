/**
 * 064: the launch assistant, where launches live — a quiet bar above the list in «Запуски».
 *
 * One line to write in; the price sits on the send button. Answers come back as short cards in the
 * language of the launch list (account chip, creatives, campaigns, products, budget) built by the
 * server from the stored rows. Every card action is free and never calls a model: open a draft,
 * «Запустити N» (the batch of 053 with the versions the card showed), undo, answer a question,
 * save an offer default. The conversation folds away when it is not needed.
 */
import {
  AlertTriangle,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cloud,
  Link2,
  Play,
  Sparkles,
  Undo2
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  assistantMessagePrice,
  ASSISTANT_MESSAGE_MAX_CHARACTERS,
  characterCount,
  quickAssistantIntent,
  type AssistantCard,
  type AssistantMessage,
  type AssistantRow
} from '@video-compressor/shared';
import { assistantApi } from '../../../api/assistant';
import { Button, IconButton, Spinner, Tooltip } from '../../../components/ui/index.js';
import { ICON_SIZE, ICON_STROKE } from '../../../components/icons.js';
import { kyivTime, setCredits, useCredits } from '../../../credits/store';
import { assistantDraftsKey, useI18n, type TranslationKey } from '../../../i18n';
import { teamErrorMessageFor } from '../../errors';
import { observeAssistant } from './analytics';

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

export interface LaunchAssistantProps {
  teamId: string;
  canEdit: boolean;
  onOpenLaunch: (id: string) => void;
  /** «Запустити N»: the batch of 053 with exactly these rows; resolves when it was submitted. */
  onLaunch: (rows: Array<{ launchId: string; version: string }>, batchKey: string) => Promise<void>;
  /** Drafts were written: the list re-reads. */
  onChanged: () => void;
}

function key(): string {
  return crypto.randomUUID().replace(/-/gu, '');
}

function stem(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/u, '');
}

export function LaunchAssistant({
  teamId,
  canEdit,
  onOpenLaunch,
  onLaunch,
  onChanged
}: LaunchAssistantProps) {
  const { t, language } = useI18n();
  const credits = useCredits(canEdit);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [focused, setFocused] = useState(false);
  const [focusedCard, setFocusedCard] = useState<string | null>(null);
  const pendingKey = useRef<{ text: string; key: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!canEdit) return;
    let live = true;
    assistantApi
      .open(teamId)
      .then(conversation => {
        if (!live) return;
        setEnabled(conversation.enabled);
        setMessages(conversation.messages);
        setCredits(conversation.credits);
      })
      .catch(() => live && setEnabled(false));
    const focus = () => input.current?.focus();
    window.addEventListener('soty:open-assistant', focus);
    return () => {
      live = false;
      window.removeEventListener('soty:open-assistant', focus);
    };
  }, [teamId, canEdit]);

  useEffect(() => {
    const last = list.current?.lastElementChild as HTMLElement | null | undefined;
    if (last && typeof last.scrollIntoView === 'function')
      last.scrollIntoView({ block: 'nearest' });
  }, [messages.length, open]);

  // The field grows with the text, from one line to about six.
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [text, enabled]);

  // The card the person is looking at: the one they pressed, else the newest card with rows.
  const contextCard = useMemo(() => {
    if (focusedCard) return focusedCard;
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
  }, [messages, focusedCard]);

  if (!canEdit || enabled !== true) return null;

  const trimmed = text.trim();
  const free = quickAssistantIntent(trimmed) !== null;
  const price = trimmed ? (free ? 0 : assistantMessagePrice(trimmed)) : null;
  const count = characterCount(text);
  const available = credits.status?.available ?? null;
  const short =
    price !== null && price > 0 && available !== null && available < price ? price - available : 0;
  const tooLong = count > ASSISTANT_MESSAGE_MAX_CHARACTERS;

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
    optimistic?: AssistantMessage
  ) => {
    setBusy(true);
    setError(null);
    setOpen(true);
    if (optimistic) setMessages(current => [...current, optimistic]);
    try {
      const reply = await run();
      setCredits(reply.credits as never);
      if (reply.message) setMessages(current => [...current, reply.message!]);
      onChanged();
      return true;
    } catch (caught) {
      setError(teamErrorMessageFor(caught, t));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (busy || !trimmed || price === null || short > 0 || tooLong) return;
    const clientKey = pendingKey.current?.text === trimmed ? pendingKey.current.key : key();
    pendingKey.current = { text: trimmed, key: clientKey };
    const flow = observeAssistant('send');
    const ok = await take(
      () =>
        assistantApi.send({ teamId, text: trimmed, clientKey, price, contextCardId: contextCard }),
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
      setFocusedCard(null);
    }
  };

  // Enter sends, Shift+Enter breaks the line, as in every chat.
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
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
    setBusy(true);
    setError(null);
    try {
      if (card.kind === 'review') await assistantApi.reviewLaunched(card.id, batchKey);
      await onLaunch(
        rows.map(item => ({ launchId: item.launchId, version: item.version })),
        batchKey
      );
      markCard(card.id, { state: 'launched', payload: { ...card.payload, batchKey } });
      flow.finish('success');
    } catch (caught) {
      flow.finish('failure');
      setError(teamErrorMessageFor(caught, t));
    } finally {
      setBusy(false);
    }
  };

  const answer = (card: AssistantCard, optionId: string) => {
    markCard(card.id, { state: 'answered', payload: { ...card.payload, answer: optionId } });
    void take(() => assistantApi.answer(teamId, card.id, optionId, key()));
  };

  const row = (item: AssistantRow) => {
    const need = missing(item);
    const facts = [
      item.campaignCount !== null
        ? t('assistantCampaignsShort', { count: item.campaignCount })
        : null,
      item.productCount !== null ? t('assistantProductsShort', { count: item.productCount }) : null,
      item.budget ? `${item.budget} $` : null
    ].filter(Boolean);
    return (
      <li key={item.launchId}>
        <button type="button" className="assistant-row" onClick={() => onOpenLaunch(item.launchId)}>
          <span className={`assistant-chip${item.account ? '' : ' is-missing'}`}>
            {item.account ?? t('assistantFieldAccount')}
          </span>
          {item.offer && <span className="assistant-row-offer">{item.offer}</span>}
          {item.creatives.map(name => (
            <span key={name} className="assistant-chip is-creative">
              {stem(name)}
            </span>
          ))}
          <span className="assistant-row-facts">{facts.join(' · ')}</span>
          {item.url && (
            <Tooltip label={t('assistantLinkSet')}>
              <Link2
                className="assistant-row-icon"
                size={16}
                strokeWidth={ICON_STROKE}
                aria-label={t('assistantLinkSet')}
              />
            </Tooltip>
          )}
          {item.r2 && (
            <Tooltip label={t('assistantR2On')}>
              <Cloud
                className="assistant-row-icon"
                size={16}
                strokeWidth={ICON_STROKE}
                aria-label={t('assistantR2On')}
              />
            </Tooltip>
          )}
          {need && (
            <span className="assistant-row-need">
              <AlertTriangle size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {need}
            </span>
          )}
        </button>
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
    return (
      <section
        key={card.id}
        className={`assistant-card${contextCard === card.id ? ' is-context' : ''}`}
        onClick={() => setFocusedCard(card.id)}
      >
        {rows.length > 0 && (
          <p className="assistant-card-title">
            <CheckCircle2 size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {[t(assistantDraftsKey(language, rows.length), { count: rows.length }), date]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
        {rows.length === 0 && card.kind === 'review' && (
          <p className="assistant-note">{t('assistantReviewEmpty')}</p>
        )}
        {rows.length > 0 && <ul className="assistant-rows">{rows.map(row)}</ul>}
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
        {rows.length > 0 && (
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
                  loading={busy}
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
                  void take(() => assistantApi.undo(teamId, message.commandId!, key()))
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
                  disabled={busy || card.state !== 'open'}
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
                <span
                  key={index}
                  className="assistant-chip"
                >{`${change.field}: ${change.from ?? '—'} → ${change.to}`}</span>
              ))}
            </div>
            {card.state === 'open' && (
              <div className="assistant-card-actions">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    void take(() => assistantApi.confirmProfile(teamId, card.id, key()))
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
  return (
    <section className="launch-assistant" aria-label={t('assistantTitle')}>
      {messages.length > 0 && (
        <div className="assistant-head">
          <span className="assistant-head-title">
            <Sparkles size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('assistantTitle')}
          </span>
          <IconButton
            size="sm"
            label={open ? t('assistantCollapse') : t('assistantExpand')}
            onClick={() => setOpen(value => !value)}
          >
            {open ? (
              <ChevronUp size={ICON_SIZE} strokeWidth={ICON_STROKE} />
            ) : (
              <ChevronDown size={ICON_SIZE} strokeWidth={ICON_STROKE} />
            )}
          </IconButton>
        </div>
      )}
      {open && messages.length > 0 && (
        <ol ref={list} className="assistant-thread" aria-live="polite">
          {messages.map(message => (
            <li key={message.id} className={`assistant-message is-${message.role}`}>
              {message.text && <p className="assistant-text">{message.text}</p>}
              {message.cards.map(card => renderCard(card, message))}
            </li>
          ))}
          {busy && (
            <li className="assistant-message is-assistant">
              <p className="assistant-note">
                <Spinner /> {t('assistantThinking')}
              </p>
            </li>
          )}
        </ol>
      )}
      {error && (
        <p className="assistant-note is-warning" role="alert">
          <AlertTriangle size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {error}
        </p>
      )}
      <div
        className={`assistant-bar${focused ? ' is-focused' : ''}${tooLong ? ' is-invalid' : ''}`}
      >
        <Sparkles
          className="assistant-bar-icon"
          size={ICON_SIZE}
          strokeWidth={ICON_STROKE}
          aria-hidden="true"
        />
        <textarea
          ref={input}
          rows={1}
          className="assistant-input"
          value={text}
          aria-label={t('assistantTitle')}
          placeholder={t('assistantPlaceholder')}
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
              {price}
            </span>
          )
        )}
        <IconButton
          size="sm"
          color="primary"
          variant="solid"
          label={sendLabel}
          loading={busy}
          disabled={!trimmed || price === null || short > 0 || tooLong}
          onClick={() => void send()}
        >
          <ArrowUp size={ICON_SIZE} strokeWidth={ICON_STROKE} />
        </IconButton>
      </div>
      {!trimmed && messages.length === 0 && (
        <div className="assistant-examples">
          {(['assistantExample1', 'assistantExample2', 'assistantExample3'] as const).map(
            example => (
              <Button key={example} size="xs" variant="ghost" onClick={() => setText(t(example))}>
                {t(example)}
              </Button>
            )
          )}
        </div>
      )}
    </section>
  );
}
