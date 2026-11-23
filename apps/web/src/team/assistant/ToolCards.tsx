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
  list_tasks: 'assistantToolListTasks',
  list_ad_accounts: 'assistantToolListAdAccounts',
  list_launches: 'assistantToolListLaunches',
  list_trash: 'assistantToolListTrash',
  creative_ranks: 'assistantToolCreativeRanks'
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
  assignee: 'assistantColAssignee',
  adAccount: 'assistantColAdAccount',
  adId: 'assistantColAdId',
  state: 'assistantColState',
  account: 'assistantColAccount',
  creative: 'assistantColCreative',
  rank: 'assistantColRank',
  launches: 'assistantColLaunches',
  lastLaunch: 'assistantColLastLaunch'
};

const LEAGUE: Readonly<Record<string, TranslationKey>> = {
  wax: 'creativeRankLeagueWax',
  bronze: 'creativeRankLeagueBronze',
  silver: 'creativeRankLeagueSilver',
  gold: 'creativeRankLeagueGold',
  diamond: 'creativeRankLeagueDiamond'
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
  update_tasks: 'assistantToolUpdateTasks',
  delete_tasks: 'assistantToolDeleteTasks',
  restore_materials: 'assistantToolRestoreMaterials',
  copy_materials: 'assistantToolCopyMaterials',
  rename_accounts: 'assistantToolRenameAccounts',
  add_ad_accounts: 'assistantToolAddAdAccounts',
  change_ad_account_ids: 'assistantToolChangeAdIds',
  archive_accounts: 'assistantToolArchiveAccounts',
  restore_accounts: 'assistantToolRestoreAccounts',
  catalog_interval: 'assistantToolCatalogInterval',
  edit_offers: 'assistantToolEditOffers'
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
  update_tasks: 'assistantToolGoApply',
  delete_tasks: 'assistantToolGoDelete',
  restore_materials: 'assistantToolGoRestore',
  copy_materials: 'assistantToolGoCopy',
  rename_accounts: 'assistantToolGoRename',
  add_ad_accounts: 'assistantToolGoAdd',
  change_ad_account_ids: 'assistantToolGoApply',
  archive_accounts: 'assistantToolGoArchive',
  restore_accounts: 'assistantToolGoRestore',
  catalog_interval: 'assistantToolGoApply',
  edit_offers: 'assistantToolGoApply'
};

const MONEY_COLUMNS = new Set(['spend', 'topup']);

/** Rows a tool card lists before «Показати всі». */
const SHOWN = 8;

/** File kinds in the words of the explorer. */
const KIND: Readonly<Record<string, TranslationKey>> = {
  folder: 'teamExplorerKindFolder',
  image: 'teamExplorerKindImage',
  video: 'teamExplorerKindVideo',
  landing: 'teamExplorerKindLanding',
  archive: 'teamExplorerKindArchive',
  transcript: 'teamExplorerKindTranscript',
  document: 'teamExplorerKindDocument',
  shortcut: 'teamExplorerKindShortcut',
  file: 'teamExplorerKindOther',
  other: 'teamExplorerKindOther'
};

const LAUNCH_STATE: Readonly<Record<string, TranslationKey>> = {
  draft: 'assistantLaunchDraft',
  launched: 'assistantLaunchLaunched',
  generating: 'assistantGeneratingRow',
  failed: 'assistantLaunchFailed',
  canceled: 'assistantLaunchCanceled'
};

/** Roles in the words of the People tab. */
const ROLE: Readonly<Record<string, TranslationKey>> = {
  owner: 'teamRoleOwner',
  admin: 'teamRoleAdmin',
  editor: 'teamRoleEditor',
  viewer: 'teamRoleViewer'
};

const STATUS: Readonly<Record<string, TranslationKey>> = {
  todo: 'assistantTaskTodo',
  in_progress: 'assistantTaskInProgress',
  done: 'assistantTaskDone'
};

/** «16 лист. — 22 лист. · #2»: the period and what the answer was narrowed to. */
function period(payload: Record<string, unknown>, language: string): string {
  const from = typeof payload.from === 'string' ? payload.from : null;
  const to = typeof payload.to === 'string' ? payload.to : null;
  const scope = Array.isArray(payload.scope)
    ? (payload.scope as string[]).map(item => item.replace(/^tag:/u, '')).join(', ')
    : '';
  if (!from) return scope;
  const day = (value: string) =>
    new Date(`${value}T12:00:00Z`).toLocaleDateString(language, {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC'
    });
  const range = from === to || !to ? day(from) : `${day(from)} — ${day(to)}`;
  return scope ? `${range} · ${scope}` : range;
}

const UNTAGGED = '{untagged}';

export function TableCard({ card }: { card: AssistantCard }) {
  const { t, language } = useI18n();
  const usd = new Intl.NumberFormat(language, { style: 'currency', currency: 'USD' });
  const [copied, setCopied] = useState(false);
  const payload = card.payload as Record<string, unknown>;
  const tool = String(payload.tool ?? '');
  const allColumns = (payload.columns as string[]) ?? [];
  const allRows = (payload.rows as Array<Array<string | null>>) ?? [];
  // A column with nothing in any row («Офер: —» on every file) only takes room.
  const kept = allColumns
    .map((column, index) => ({ column, index }))
    .filter(
      ({ column, index }) =>
        index === 0 ||
        MONEY_COLUMNS.has(column) ||
        column === 'count' ||
        allRows.some(row => row[index] !== null && row[index] !== '')
    );
  const columns = kept.map(entry => entry.column);
  const rows = allRows.map(row => kept.map(entry => row[entry.index] ?? null));
  const total = (payload.total as Array<string | null> | null) ?? null;
  const missing = (payload.missing as string[]) ?? [];
  const copyText =
    typeof payload.copyText === 'string'
      ? payload.copyText.replaceAll(UNTAGGED, t('teamAgentLabelsUntagged'))
      : null;
  const cell = (column: string, value: string | null) => {
    if (value === null || value === '') return '—';
    if (value === UNTAGGED) return t('teamAgentLabelsUntagged');
    if (MONEY_COLUMNS.has(column)) return usd.format(Number(value));
    if (column === 'status' && STATUS[value]) return t(STATUS[value]);
    if (column === 'role' && ROLE[value]) return t(ROLE[value]);
    if (column === 'kind' && KIND[value]) return t(KIND[value]);
    // «вільний», «зайнятий: 3», «запущено» — the words of Accounts and Launches.
    if (column === 'state' && value === 'free') return t('assistantStateFree');
    if (column === 'state' && value === 'archived') return t('assistantStateArchived');
    if (column === 'state' && value.startsWith('busy:'))
      return t('assistantStateBusy', { count: Number(value.slice(5)) });
    if (column === 'state' && value.startsWith('launch:') && LAUNCH_STATE[value.slice(7)])
      return t(LAUNCH_STATE[value.slice(7)]!);
    // A day row of «по днях»: «пн, 16 лист.».
    if (column === 'group' && payload.by === 'day' && /^\d{4}-\d{2}-\d{2}$/u.test(value))
      return new Date(`${value}T12:00:00Z`).toLocaleDateString(language, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC'
      });
    if (column === 'rank' && LEAGUE[value]) return t(LEAGUE[value]);
    if (column === 'lastLaunch' && /^\d{4}-\d{2}-\d{2}T/u.test(value))
      return new Date(value).toLocaleDateString(language, { day: 'numeric', month: 'short' });
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
        {title ? t(title, { period: period(payload, language), count }) : tool}
      </p>
      {onlyTotal && total.every(value => value === null) ? (
        <p className="assistant-note">{t('assistantToolNothingEntered')}</p>
      ) : onlyTotal ? (
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
                        MONEY_COLUMNS.has(column) || column === 'count' || column === 'launches'
                          ? 'is-numeric'
                          : undefined
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
                        MONEY_COLUMNS.has(column) || column === 'count' || column === 'launches'
                          ? 'is-numeric'
                          : undefined
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
  onRun,
  onDismiss
}: {
  card: AssistantCard;
  pending: boolean;
  disabled: boolean;
  onRun: () => void;
  /** «Не треба»: the card stays, its button goes — a test or a change of mind is not left armed. */
  onDismiss?: () => void;
}) {
  const { t, language } = useI18n();
  // A long list (77 catalogs) shows its first rows; the button stays in sight.
  const [expanded, setExpanded] = useState(false);
  const usd = new Intl.NumberFormat(language, { style: 'currency', currency: 'USD' });
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
      changes?: Array<{ field: string; from: string | null; to: string | null }>;
    }>) ?? [];
  const word = (field: string, value: string | null) =>
    value === null || value === ''
      ? '—'
      : field === 'status' && STATUS[value]
        ? t(STATUS[value])
        : value;
  const missing = (payload.missing as string[]) ?? [];
  const danger = payload.danger === true;
  const done = card.state === 'confirmed';
  const dismissed = card.state === 'stale' || card.state === 'undone';
  const active = items.filter(item => !item.exists && !item.unchanged);
  const money = tool === 'set_finance';
  const show = (value: string | null | undefined) =>
    value === null || value === undefined || value === ''
      ? '—'
      : money
        ? usd.format(Number(value))
        : value;
  const parent = payload.parent as { label?: string; create?: string } | null | undefined;
  const created = (payload.created as string[]) ?? [];
  const folders = (payload.folders as string[]) ?? [];
  const destination = payload.destination as { label?: string; create?: string } | undefined;
  const title = REVIEW_TITLE[tool];
  return (
    <section
      className={danger && !dismissed && !done ? 'assistant-card is-danger' : 'assistant-card'}
    >
      <p className="assistant-card-title">
        {danger ? (
          <Trash2 size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        ) : (
          <Wrench size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        )}
        {title
          ? t(title, {
              count: active.length,
              date:
                typeof payload.date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(payload.date)
                  ? new Date(`${payload.date}T12:00:00Z`).toLocaleDateString(language, {
                      day: 'numeric',
                      month: 'short',
                      timeZone: 'UTC'
                    })
                  : String(payload.date ?? ''),
              role: ROLE[String(payload.role)] ? t(ROLE[String(payload.role)]!) : '',
              metric: payload.metric
                ? t(METRIC[String(payload.metric)] ?? 'assistantColTopup')
                : '',
              destination: destination?.label ?? ''
            })
          : tool}
      </p>
      {tool === 'create_folders' && parent?.create && (
        <p className="assistant-note">{t('assistantToolNewFolder', { name: parent.create })}</p>
      )}
      {tool === 'create_folders' && (
        <p className="assistant-note">
          {parent?.label
            ? t('assistantToolInFolder', { name: parent.label })
            : t('assistantToolInRoot')}
        </p>
      )}
      {created.length > 0 && !done && !dismissed && (
        <p className="assistant-note">{t('assistantToolNewTags', { names: created.join(', ') })}</p>
      )}
      {destination?.create && (
        <p className="assistant-note">
          {t('assistantToolNewFolder', { name: destination.create })}
        </p>
      )}
      <ul className="assistant-rows">
        {items.slice(0, expanded ? 500 : SHOWN).map((item, index) => (
          <li key={index} className="assistant-row">
            <span className="assistant-row-line">
              {item.from !== item.label && <span className="assistant-chip">{item.label}</span>}
              <span className="assistant-row-facts">
                {item.changes
                  ? item.changes
                      .map(
                        change =>
                          `${t(COLUMN[change.field] ?? 'assistantColGroup')}: ${word(change.field, change.from)} → ${word(change.field, change.to)}`
                      )
                      .join(' · ')
                  : item.exists
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
      {items.length > SHOWN && (
        <Button size="xs" variant="ghost" onClick={() => setExpanded(value => !value)}>
          {expanded
            ? t('assistantToolCollapse')
            : t('assistantToolShowAll', { count: items.length })}
        </Button>
      )}
      {typeof payload.total === 'string' && money && (
        <p className="assistant-note">
          {t('assistantToolSum', { sum: usd.format(Number(payload.total)) })}
        </p>
      )}
      {typeof payload.overwrites === 'number' && payload.overwrites > 0 && !done && !dismissed && (
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
      {folders.length > 0 && (
        <p className="assistant-note is-warning">
          <AlertTriangle size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {t('assistantFolderMoveUnsupported', { written: folders.join(', ') })}
        </p>
      )}
      {typeof payload.folderCount === 'number' &&
        payload.folderCount > 0 &&
        !done &&
        !dismissed && (
          <p className="assistant-note is-warning">
            <AlertTriangle size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('assistantToolTrashFolders', { count: payload.folderCount })}
          </p>
        )}
      {danger && !done && !dismissed && (
        <p className="assistant-note">{t(DANGER_NOTE[tool] ?? 'assistantToolTrashNote')}</p>
      )}
      {payload.truncated === true && (
        <p className="assistant-note">{t('assistantToolTruncated')}</p>
      )}
      {dismissed && <p className="assistant-note">{t('assistantToolDismissed')}</p>}
      {active.length > 0 && !dismissed && (
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
          {!done && onDismiss && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={onDismiss}>
              {t('assistantToolDismiss')}
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
  remove_members: 'assistantToolRemoveNote',
  delete_tasks: 'assistantToolDeleteTasksNote'
};
