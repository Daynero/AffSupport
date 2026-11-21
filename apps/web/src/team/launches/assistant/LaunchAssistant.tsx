/**
 * 064: the launch assistant, where launches live — above the list in «Запуски».
 *
 * A person writes what to prepare; the server saves ordinary drafts and answers with cards it
 * built from the stored rows. Every card's buttons are free and never call a model: open a draft,
 * review, «Запустити N» (the batch of 053 with the versions this card showed), undo, answer a
 * question, save an offer default. Only a typed message costs credits, and its price is on the
 * send button before it is pressed.
 */
import { Send, Sparkles, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
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
import { Alert, Badge, Button, Spinner, Textarea } from '../../../components/ui/index.js';
import { ICON_SIZE, ICON_STROKE } from '../../../components/icons.js';
import { kyivTime, setCredits, useCredits } from '../../../credits/store';
import { useI18n, type TranslationKey } from '../../../i18n';
import { teamErrorMessageFor } from '../../errors';
import { observeAssistant } from './analytics';

const REASON_COPY: Readonly<Record<string, TranslationKey>> = {
  INSUFFICIENT_CREDITS: 'aiInsufficientCredits',
  AI_MONTH_EXHAUSTED: 'aiMonthExhausted',
  PRICE_CHANGED: 'aiPriceChanged',
  MODEL_UNAVAILABLE: 'assistantModelUnavailable',
  MODEL_OUTPUT_REJECTED: 'assistantOutputRejected',
  PLAN_TOO_LARGE: 'assistantPlanTooLarge',
  REVIEW_CHANGED: 'assistantReviewChanged',
  EDIT_CONFLICT: 'assistantEditConflict',
  NO_CONTEXT_CARD: 'assistantNoContext',
  USE_BUTTONS: 'assistantUseButtons',
  DEFAULTS_FORBIDDEN: 'assistantDefaultsForbidden',
  OFFER_NOT_FOUND: 'assistantNotFound',
  ACCOUNT_NOT_FOUND: 'assistantNotFound',
  MATERIAL_NOT_FOUND: 'assistantNotFound',
  NOT_FOUND: 'assistantNotFound',
  FIELD_FORM_ONLY: 'assistantFieldFormOnly',
  FIELD_NOT_SUPPORTED: 'assistantFieldFormOnly',
  INVALID_VALUE: 'assistantInvalidValue',
  OP_NOT_ALLOWED: 'assistantInvalidValue',
  NOT_CATALOG: 'assistantNotCatalog',
  LAUNCHED: 'assistantLaunchedRow',
  CHANGED_AFTER: 'assistantChangedAfter',
  FIELD_CHANGED: 'assistantFieldChanged'
};

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

function Row({ row, onOpen }: { row: AssistantRow; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  return (
    <li className="assistant-row">
      <span className="assistant-row-n">{row.n}</span>
      <span className="assistant-row-facts">
        {[
          row.account,
          row.offer,
          row.creatives.join(', '),
          row.launchDate,
          row.campaignCount !== null ? `${row.campaignCount}×` : null,
          row.productCount !== null ? `${row.productCount}` : null,
          row.budget,
          row.url ? t('assistantRowUrl') : null,
          row.r2 ? 'R2' : null
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
      {row.blocked.length > 0 && (
        <Badge color="warning" variant="soft" size="sm">
          {t(
            row.blocked.some(b => b.code === 'LAUNCHED')
              ? 'assistantLaunchedRow'
              : 'assistantBlocked'
          )}
        </Badge>
      )}
      <Button size="xs" variant="ghost" onClick={() => onOpen(row.launchId)}>
        {t('assistantOpen')}
      </Button>
    </li>
  );
}

function reasonText(t: ReturnType<typeof useI18n>['t'], code: string, written?: string): string {
  const copy = REASON_COPY[code];
  if (!copy) return t('assistantUnavailable');
  return t(copy, { written: written ?? '', text: written ?? '' });
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
  }, [messages.length]);

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

  const take = async (
    run: () => Promise<{ message: AssistantMessage | null; credits: unknown }>,
    optimistic?: AssistantMessage
  ) => {
    setBusy(true);
    setError(null);
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
    if (busy || !trimmed || price === null || short > 0 || count > ASSISTANT_MESSAGE_MAX_CHARACTERS)
      return;
    const clientKey = pendingKey.current?.text === trimmed ? pendingKey.current.key : key();
    pendingKey.current = { text: trimmed, key: clientKey };
    const flow = observeAssistant('send', { price, free });
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

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };

  const launch = async (card: AssistantCard) => {
    const rows = ((card.payload.rows as AssistantRow[]) ?? []).filter(
      row => row.blocked.length === 0
    );
    if (!rows.length || busy) return;
    const batchKey =
      typeof card.payload.batchKey === 'string' ? card.payload.batchKey : crypto.randomUUID();
    const flow = observeAssistant('launch', { rows: rows.length });
    setBusy(true);
    setError(null);
    try {
      await assistantApi.reviewLaunched(card.id, batchKey);
      await onLaunch(
        rows.map(row => ({ launchId: row.launchId, version: row.version })),
        batchKey
      );
      setMessages(current =>
        current.map(message => ({
          ...message,
          cards: message.cards.map(c =>
            c.id === card.id ? { ...c, state: 'launched', payload: { ...c.payload, batchKey } } : c
          )
        }))
      );
      flow.finish('success');
    } catch (caught) {
      flow.finish('failure');
      setError(teamErrorMessageFor(caught, t));
      // A changed selection: show the current one.
      void take(() => assistantApi.review(teamId, card.id, key()));
    } finally {
      setBusy(false);
    }
  };

  const renderCard = (card: AssistantCard, message: AssistantMessage) => {
    const payload = card.payload as Record<string, unknown>;
    const rows = (payload.rows as AssistantRow[] | undefined) ?? [];
    const select = () => setFocusedCard(card.id);
    switch (card.kind) {
      case 'result': {
        const unresolved =
          (payload.unresolved as Array<{ field: string; written: string; code: string }>) ?? [];
        const differences =
          (payload.differences as Array<{ field: string; from: string | null; to: string }>) ?? [];
        return (
          <section
            key={card.id}
            className={`assistant-card${contextCard === card.id ? ' is-context' : ''}`}
            onFocus={select}
            onClick={select}
          >
            {rows.length > 0 && (
              <p className="assistant-card-title">
                {t('assistantResultTitle', {
                  count: rows.length,
                  campaigns: Number(payload.campaigns ?? 0)
                })}
                {typeof payload.date === 'string' &&
                  ` · ${t('assistantDate', { date: payload.date })}`}
              </p>
            )}
            {rows.length > 0 && (
              <ol className="assistant-rows">
                {rows.map(row => (
                  <Row key={row.launchId} row={row} onOpen={onOpenLaunch} />
                ))}
              </ol>
            )}
            {differences.length > 0 && (
              <p className="assistant-card-note">
                {t('assistantDifferences')}:{' '}
                {differences.map(d => `${d.field} ${d.from ?? '—'} → ${d.to}`).join('; ')}
              </p>
            )}
            {unresolved.length > 0 && (
              <ul className="assistant-card-note">
                {unresolved.map((item, index) => (
                  <li key={index}>{reasonText(t, item.code, item.written)}</li>
                ))}
              </ul>
            )}
            {rows.length > 0 && (
              <div className="assistant-card-actions">
                <Button
                  size="sm"
                  variant="soft"
                  disabled={busy}
                  onClick={() => void take(() => assistantApi.review(teamId, card.id, key()))}
                >
                  {t('assistantReviewAndLaunch')}
                </Button>
                {message.commandId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    leading={<Undo2 size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
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
      }
      case 'review': {
        const ready = rows.filter(row => row.blocked.length === 0).length;
        return (
          <section
            key={card.id}
            className={`assistant-card${contextCard === card.id ? ' is-context' : ''}`}
            onFocus={select}
            onClick={select}
          >
            {typeof payload.date === 'string' && (
              <p className="assistant-card-title">{t('assistantDate', { date: payload.date })}</p>
            )}
            {rows.length === 0 && (
              <p className="assistant-card-note">{t('assistantReviewEmpty')}</p>
            )}
            {rows.length > 0 && (
              <ol className="assistant-rows">
                {rows.map(row => (
                  <Row key={row.launchId} row={row} onOpen={onOpenLaunch} />
                ))}
              </ol>
            )}
            {payload.truncated === true && (
              <p className="assistant-card-note">{t('assistantReviewTruncated')}</p>
            )}
            {card.state === 'launched' ? (
              <Badge color="success" variant="soft">
                {t('assistantLaunched')}
              </Badge>
            ) : (
              ready > 0 && (
                <div className="assistant-card-actions">
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy}
                    onClick={() => void launch(card)}
                  >
                    {t('assistantLaunch', { count: ready })}
                  </Button>
                </div>
              )
            )}
          </section>
        );
      }
      case 'question': {
        const options = (payload.options as Array<{ id: string; label: string }>) ?? [];
        return (
          <section key={card.id} className="assistant-card">
            <p className="assistant-card-title">{String(payload.about ?? '')}</p>
            <div className="assistant-card-actions">
              {options.map(option => (
                <Button
                  key={option.id}
                  size="sm"
                  variant="soft"
                  disabled={busy || card.state !== 'open'}
                  onClick={() =>
                    void take(() => assistantApi.answer(teamId, card.id, option.id, key()))
                  }
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </section>
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
            <ul className="assistant-card-note">
              {changes.map((change, index) => (
                <li key={index}>{`${change.field}: ${change.from ?? '—'} → ${change.to}`}</li>
              ))}
            </ul>
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
            <p key={card.id} className="assistant-card-note">
              {t('assistantProfileSaved', { offer: payload.profileSaved })}
            </p>
          );
        const kept = (payload.kept as Array<{ code: string }>) ?? [];
        return (
          <p key={card.id} className="assistant-card-note">
            {t('assistantUndone', { count: Number(payload.undone ?? 0) })}
            {kept.length > 0 &&
              ` · ${t('assistantKept', { count: kept.length })}: ${[...new Set(kept.map(k => reasonText(t, k.code)))].join('; ')}`}
          </p>
        );
      }
      case 'refusal': {
        const details = (payload.details as Record<string, unknown> | undefined) ?? {};
        return (
          <Alert key={card.id} color="warning" variant="soft">
            {reasonText(
              t,
              String(payload.code),
              typeof details.text === 'string' ? details.text : undefined
            )}
          </Alert>
        );
      }
      default:
        return null;
    }
  };

  return (
    <section className="launch-assistant" aria-label={t('assistantTitle')}>
      {messages.length > 0 && (
        <ol ref={list} className="assistant-thread" aria-live="polite">
          {messages.map(message => (
            <li key={message.id} className={`assistant-message is-${message.role}`}>
              {message.text && <p className="assistant-message-text">{message.text}</p>}
              {message.cards.map(card => renderCard(card, message))}
            </li>
          ))}
          {busy && (
            <li className="assistant-message is-assistant">
              <Spinner /> <span className="assistant-card-note">{t('assistantThinking')}</span>
            </li>
          )}
        </ol>
      )}
      {messages.length === 0 && (
        <div className="assistant-examples">
          <Sparkles size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span className="assistant-card-note">{t('assistantEmpty')}</span>
          {(['assistantExample1', 'assistantExample2', 'assistantExample3'] as const).map(
            example => (
              <Button key={example} size="xs" variant="soft" onClick={() => setText(t(example))}>
                {t(example)}
              </Button>
            )
          )}
        </div>
      )}
      {error && (
        <Alert color="error" variant="soft">
          {error}
        </Alert>
      )}
      <div className="assistant-composer">
        <Textarea
          ref={input}
          rows={2}
          value={text}
          aria-label={t('assistantTitle')}
          placeholder={t('assistantPlaceholder')}
          invalid={count > ASSISTANT_MESSAGE_MAX_CHARACTERS}
          onChange={event => setText(event.target.value)}
          onKeyDown={onKey}
        />
        <div className="assistant-composer-row">
          <span className="assistant-card-note">{t('assistantCounter', { count })}</span>
          {short > 0 && credits.status && (
            <span className="assistant-card-note">
              {t('assistantShort', {
                missing: short,
                time: kyivTime(credits.status.resetsAt, language)
              })}
            </span>
          )}
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={
              !trimmed || price === null || short > 0 || count > ASSISTANT_MESSAGE_MAX_CHARACTERS
            }
            trailing={<Send size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
            onClick={() => void send()}
          >
            {price ? t('assistantSend', { price }) : t('assistantSendFree')}
          </Button>
        </div>
      </div>
    </section>
  );
}
