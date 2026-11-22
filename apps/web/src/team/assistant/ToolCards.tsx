/**
 * 064: the cards of the space tools. A `table` card is an answer read from the space — the numbers
 * and names are Soty's, the model only chose what to read. A tool `review` card lists exactly what
 * its button will do; a removal is red and says where things go (the Drive trash).
 */
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, Trash2, Wrench } from 'lucide-react';
import type { AssistantCard } from '@video-compressor/shared';
import { Button } from '../../components/ui/index.js';
import { ICON_STROKE } from '../../components/icons.js';
import { useI18n, type TranslationKey } from '../../i18n';

const TABLE_TITLE: Readonly<Record<string, TranslationKey>> = {
  finance_report: 'assistantToolFinanceReport',
  topup_statement: 'assistantToolTopupStatement',
  find_materials: 'assistantToolFindMaterials',
  list_catalogs: 'assistantToolListCatalogs',
  list_members: 'assistantToolListMembers',
  list_tasks: 'assistantToolListTasks'
};

const COLUMN: Readonly<Record<string, TranslationKey>> = {
  group: 'assistantColGroup',
  spend: 'assistantColSpend',
  topup: 'assistantColTopup',
  count: 'assistantColCount',
  name: 'assistantColName',
  kind: 'assistantColKind',
  offer: 'assistantColOffer',
  tags: 'assistantColTags',
  video: 'assistantColVideo',
  products: 'assistantColProducts',
  updated: 'assistantColUpdated',
  error: 'assistantColError',
  email: 'assistantColEmail',
  role: 'assistantColRole',
  title: 'assistantColTitle',
  status: 'assistantColStatus',
  date: 'assistantColDate',
  assignee: 'assistantColAssignee'
};

const REVIEW_TITLE: Readonly<Record<string, TranslationKey>> = {
  set_finance: 'assistantToolSetFinance',
  tag_ad_accounts: 'assistantToolTagAdAccounts',
  create_folders: 'assistantToolCreateFolders',
  move_materials: 'assistantToolMoveMaterials',
  rename_materials: 'assistantToolRenameMaterials',
  edit_materials: 'assistantToolEditMaterials',
  trash_materials: 'assistantToolTrashMaterials',
  trash_catalogs: 'assistantToolTrashCatalogs',
  update_catalogs: 'assistantToolUpdateCatalogs',
  invite_members: 'assistantToolInviteMembers',
  change_roles: 'assistantToolChangeRoles',
  remove_members: 'assistantToolRemoveMembers',
  create_tasks: 'assistantToolCreateTasks',
  update_tasks: 'assistantToolUpdateTasks'
};

const REVIEW_GO: Readonly<Record<string, TranslationKey>> = {
  set_finance: 'assistantToolGoSave',
  tag_ad_accounts: 'assistantToolGoApply',
  create_folders: 'assistantToolGoCreate',
  move_materials: 'assistantToolGoMove',
  rename_materials: 'assistantToolGoRename',
  edit_materials: 'assistantToolGoApply',
  trash_materials: 'assistantToolGoTrash',
  trash_catalogs: 'assistantToolGoTrash',
  update_catalogs: 'assistantToolGoUpdate',
  invite_members: 'assistantToolGoInvite',
  change_roles: 'assistantToolGoApply',
  remove_members: 'assistantToolGoRemove',
  create_tasks: 'assistantToolGoCreate',
  update_tasks: 'assistantToolGoApply'
};

const MONEY_COLUMNS = new Set(['spend', 'topup']);

const STATUS: Readonly<Record<string, TranslationKey>> = {
  todo: 'assistantTaskTodo',
  in_progress: 'assistantTaskInProgress',
  done: 'assistantTaskDone'
};

function period(payload: Record<string, unknown>): string {
  const from = typeof payload.from === 'string' ? payload.from : null;
  const to = typeof payload.to === 'string' ? payload.to : null;
  if (!from) return '';
  return from === to || !to ? from : `${from} — ${to}`;
}

export function TableCard({ card }: { card: AssistantCard }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const payload = card.payload as Record<string, unknown>;
  const tool = String(payload.tool ?? '');
  const columns = (payload.columns as string[]) ?? [];
  const rows = (payload.rows as Array<Array<string | null>>) ?? [];
  const total = (payload.total as Array<string | null> | null) ?? null;
  const missing = (payload.missing as string[]) ?? [];
  const copyText = typeof payload.copyText === 'string' ? payload.copyText : null;
  const cell = (column: string, value: string | null) => {
    if (value === null || value === '') return '—';
    if (MONEY_COLUMNS.has(column)) return `$${value}`;
    if (column === 'status' && STATUS[value]) return t(STATUS[value]);
    if (column === 'updated' && /^\d{4}-\d{2}-\d{2}T/u.test(value))
      return new Date(value).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    return value;
  };
  const title = TABLE_TITLE[tool];
  const count = typeof payload.count === 'number' ? payload.count : rows.length;
  // A total alone («скільки витрат за вчора») is a sentence, not a one-row table.
  const onlyTotal = rows.length === 0 && total !== null && columns.every(c => MONEY_COLUMNS.has(c));
  return (
    <section className="assistant-card">
      <p className="assistant-card-title">
        <Wrench size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {title ? t(title, { period: period(payload), count }) : tool}
      </p>
      {onlyTotal ? (
        <dl className="assistant-table-totals">
          {columns.map((column, index) => (
            <div key={column}>
              <dt>{t(COLUMN[column] ?? 'assistantColGroup')}</dt>
              <dd className="numeric">{cell(column, total[index] ?? null)}</dd>
            </div>
          ))}
        </dl>
      ) : rows.length === 0 ? (
        <p className="assistant-note">{t('assistantToolEmpty')}</p>
      ) : (
        <div className="assistant-table-wrap">
          <table className="assistant-table">
            <thead>
              <tr>
                {columns.map(column => (
                  <th key={column} className={MONEY_COLUMNS.has(column) ? 'is-numeric' : undefined}>
                    {t(COLUMN[column] ?? 'assistantColGroup')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {columns.map((column, at) => (
                    <td
                      key={column}
                      className={
                        MONEY_COLUMNS.has(column) || column === 'count' ? 'is-numeric' : undefined
                      }
                    >
                      {cell(column, row[at] ?? null)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {total && (
              <tfoot>
                <tr>
                  {columns.map((column, at) => (
                    <td
                      key={column}
                      className={
                        MONEY_COLUMNS.has(column) || column === 'count' ? 'is-numeric' : undefined
                      }
                    >
                      {at === 0 && columns[0] === 'group'
                        ? t('assistantColTotal')
                        : cell(column, total[at - (columns[0] === 'group' ? 1 : 0)] ?? null)}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {missing.length > 0 && (
        <p className="assistant-note is-warning">
          <AlertTriangle size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {t('assistantNotFoundQuoted', { written: missing.join(', ') })}
        </p>
      )}
      {payload.truncated === true && (
        <p className="assistant-note">{t('assistantToolTruncated')}</p>
      )}
      {copyText && (
        <div className="assistant-card-actions">
          <Button
            size="sm"
            variant="soft"
            leading={<Copy size={16} strokeWidth={ICON_STROKE} />}
            onClick={() => void navigator.clipboard.writeText(copyText).then(() => setCopied(true))}
          >
            {copied ? t('assistantToolCopied') : t('assistantToolCopy')}
          </Button>
        </div>
      )}
    </section>
  );
}

export function ToolReviewCard({
  card,
  pending,
  disabled,
  onRun
}: {
  card: AssistantCard;
  pending: boolean;
  disabled: boolean;
  onRun: () => void;
}) {
  const { t } = useI18n();
  const payload = card.payload as Record<string, unknown>;
  const tool = String(payload.tool ?? '');
  const items =
    (payload.items as Array<{
      label: string;
      from?: string | null;
      to?: string | null;
      note?: string | null;
      exists?: boolean;
      unchanged?: boolean;
    }>) ?? [];
  const missing = (payload.missing as string[]) ?? [];
  const danger = payload.danger === true;
  const done = card.state === 'confirmed';
  const active = items.filter(item => !item.exists && !item.unchanged);
  const money = tool === 'set_finance';
  const show = (value: string | null | undefined) =>
    value === null || value === undefined || value === '' ? '—' : money ? `$${value}` : value;
  const destination = payload.destination as { label?: string; create?: string } | undefined;
  const title = REVIEW_TITLE[tool];
  return (
    <section className={danger ? 'assistant-card is-danger' : 'assistant-card'}>
      <p className="assistant-card-title">
        {danger ? (
          <Trash2 size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        ) : (
          <Wrench size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        )}
        {title
          ? t(title, {
              count: active.length,
              date: String(payload.date ?? ''),
              role: String(payload.role ?? ''),
              metric: payload.metric
                ? t(METRIC[String(payload.metric)] ?? 'assistantColTopup')
                : '',
              destination: destination?.label ?? ''
            })
          : tool}
      </p>
      {destination?.create && (
        <p className="assistant-note">
          {t('assistantToolNewFolder', { name: destination.create })}
        </p>
      )}
      <ul className="assistant-rows">
        {items.slice(0, 60).map((item, index) => (
          <li key={index} className="assistant-row">
            <span className="assistant-row-line">
              <span className="assistant-chip">{item.label}</span>
              <span className="assistant-row-facts">
                {item.exists
                  ? t('assistantToolExists')
                  : item.unchanged
                    ? t('assistantToolUnchanged')
                    : item.to !== undefined
                      ? `${show(item.from)} → ${show(item.to)}`
                      : (item.note ?? '')}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {items.length > 60 && (
        <p className="assistant-note">{t('assistantToolMore', { count: items.length - 60 })}</p>
      )}
      {typeof payload.total === 'string' && money && (
        <p className="assistant-note">{t('assistantToolSum', { sum: `$${payload.total}` })}</p>
      )}
      {typeof payload.overwrites === 'number' && payload.overwrites > 0 && !done && (
        <p className="assistant-note is-warning">
          <AlertTriangle size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {t('assistantToolOverwrites', { count: payload.overwrites })}
        </p>
      )}
      {missing.length > 0 && (
        <p className="assistant-note is-warning">
          <AlertTriangle size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {t('assistantNotFoundQuoted', { written: missing.join(', ') })}
        </p>
      )}
      {danger && !done && (
        <p className="assistant-note">{t(DANGER_NOTE[tool] ?? 'assistantToolTrashNote')}</p>
      )}
      {payload.truncated === true && (
        <p className="assistant-note">{t('assistantToolTruncated')}</p>
      )}
      {active.length > 0 && (
        <div className="assistant-card-actions">
          {done ? (
            <span className="assistant-note is-success">
              <CheckCircle2 size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {t('assistantToolDone', {
                count: typeof payload.done === 'number' ? payload.done : active.length
              })}
            </span>
          ) : (
            <Button
              size="sm"
              variant={danger ? 'soft' : 'primary'}
              color={danger ? 'error' : undefined}
              loading={pending}
              disabled={disabled}
              leading={danger ? <Trash2 size={16} strokeWidth={ICON_STROKE} /> : undefined}
              onClick={onRun}
            >
              {t(REVIEW_GO[tool] ?? 'assistantToolGoApply', { count: active.length })}
            </Button>
          )}
        </div>
      )}
      {done && typeof payload.failed === 'number' && payload.failed > 0 && (
        <p className="assistant-note is-warning">
          <AlertTriangle size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {t('assistantToolFailed', { count: payload.failed })}
        </p>
      )}
    </section>
  );
}

const METRIC: Readonly<Record<string, TranslationKey>> = {
  topup: 'assistantColTopup',
  spend: 'assistantColSpend',
  balance: 'assistantColBalance'
};

const DANGER_NOTE: Readonly<Record<string, TranslationKey>> = {
  trash_materials: 'assistantToolTrashNote',
  trash_catalogs: 'assistantToolTrashNote',
  remove_members: 'assistantToolRemoveNote'
};
