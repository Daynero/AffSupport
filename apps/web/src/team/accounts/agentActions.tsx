import {
  Archive,
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  Copy,
  History,
  Pencil,
  SquarePen,
  Trash2
} from 'lucide-react';
import type { TeamAgentRun } from '@video-compressor/shared';
import type { MenuEntry } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import type { TranslationKey } from '../../i18n';

/**
 * What can be done to an agent from its row's "…" — said once (070, T042).
 *
 * The row used to carry its own answer in three places: a copy button beside the id, a pencil
 * and a bin on every run line, and a hand-assembled menu for the rest. The at-rest table of 024
 * (US14) asks for one primary action on the row and everything else here, so this is the list,
 * in the order a reader scans it: what anyone may do (copy, history), the runs, the agent, and
 * the deletion last. An action that never applies to this reader is absent, not dimmed — a
 * viewer's menu is the copy and the history, nothing more (T049).
 */
export const AGENT_ACTION_IDS = [
  'copyId',
  'history',
  'editRun',
  'deleteRun',
  'edit',
  'move',
  'orderUp',
  'orderDown',
  'archive',
  'delete'
] as const;
export type AgentActionId = (typeof AGENT_ACTION_IDS)[number];

export interface AgentActionContext {
  /** `v31-434` — what every item's accessible name says it acts on. */
  tag: string;
  agentId: string;
  runs: readonly TeamAgentRun[];
  /** A write is in flight on the row; the items that would race it wait. */
  waiting: boolean;
  /** A run of this row is open in its editor. */
  editingRun: boolean;
  onCopyId: () => void;
  onHistory?: () => void;
  /** The history's full name — the account and the id, as the money drawer is titled. */
  historyLabel?: string;
  /** Each present only for a reader who may change the agent. */
  onEditRun?: (run: TeamAgentRun) => void;
  onDeleteRun?: (run: TeamAgentRun) => void;
  onEdit?: () => void;
  onMove?: () => void;
  onOrderUp?: () => void;
  onOrderDown?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
}

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

const icon = (Glyph: typeof Copy) => <Glyph size={ICON_SIZE} strokeWidth={ICON_STROKE} />;

/** The row menu's entries, from the registry above, for this reader and this agent. */
export function agentMenuEntries(context: AgentActionContext, t: Translate): MenuEntry[] {
  const { tag } = context;
  const named = (key: TranslationKey) => `${t(key)} ${tag}`;
  const read: MenuEntry[] = [
    {
      id: 'copyId',
      label: t('teamAgentCopyIdShort'),
      ariaLabel: `${named('teamAgentCopyId')}: ${context.agentId}`,
      icon: icon(Copy),
      // The id itself, in the item: the chip shows only its tail, and a full id read off a
      // tooltip could be neither selected nor checked against the one in the ad cabinet.
      trailing: <code className="team-agent-menu-id">{context.agentId}</code>,
      onSelect: context.onCopyId
    },
    ...(context.onHistory
      ? [
          {
            id: 'history',
            label: t('financeHistory'),
            ariaLabel: context.historyLabel ?? `${t('financeHistory')} · ${tag}`,
            icon: icon(History),
            onSelect: context.onHistory
          }
        ]
      : [])
  ];
  const runs: MenuEntry[] =
    context.onEditRun || context.onDeleteRun
      ? context.runs.flatMap(run => [
          { heading: run.note } satisfies MenuEntry,
          ...(context.onEditRun
            ? [
                {
                  id: `editRun:${run.id}`,
                  label: t('teamAgentRunEdit'),
                  ariaLabel: `${t('teamAgentRunEdit')}: ${run.note}`,
                  icon: icon(Pencil),
                  disabled: context.waiting,
                  onSelect: () => context.onEditRun!(run)
                }
              ]
            : []),
          ...(context.onDeleteRun
            ? [
                {
                  id: `deleteRun:${run.id}`,
                  label: t('teamAgentRunDelete'),
                  ariaLabel: `${t('teamAgentRunDelete')}: ${run.note}`,
                  icon: icon(Trash2),
                  destructive: true,
                  disabled: context.waiting || context.editingRun,
                  onSelect: () => context.onDeleteRun!(run)
                }
              ]
            : [])
        ])
      : [];
  const agent: MenuEntry[] = [
    ...(context.onEdit
      ? [
          {
            id: 'edit',
            label: t('teamAgentEdit'),
            ariaLabel: named('teamAgentEdit'),
            icon: icon(SquarePen),
            onSelect: context.onEdit
          }
        ]
      : []),
    ...(context.onMove
      ? [
          {
            id: 'move',
            label: t('financeMove'),
            ariaLabel: named('teamAgentMove'),
            icon: icon(ArrowRightLeft),
            onSelect: context.onMove
          }
        ]
      : []),
    ...(context.onOrderUp
      ? [
          {
            id: 'orderUp',
            label: t('accountsMoveUp'),
            icon: icon(ArrowUp),
            onSelect: context.onOrderUp
          }
        ]
      : []),
    ...(context.onOrderDown
      ? [
          {
            id: 'orderDown',
            label: t('accountsMoveDown'),
            icon: icon(ArrowDown),
            onSelect: context.onOrderDown
          }
        ]
      : []),
    ...(context.onArchive
      ? [
          {
            id: 'archive',
            label: t('accountsArchive'),
            ariaLabel: t('accountsArchiveAction', { name: tag }),
            icon: icon(Archive),
            onSelect: context.onArchive
          }
        ]
      : [])
  ];
  const remove: MenuEntry[] = context.onDelete
    ? [
        {
          id: 'delete',
          label: t('teamAgentDelete'),
          ariaLabel: named('teamAgentDelete'),
          icon: icon(Trash2),
          destructive: true,
          onSelect: context.onDelete
        }
      ]
    : [];
  /* Groups are parted by a line — except before a run, whose heading draws its own. */
  return [read, runs, agent, remove]
    .filter(group => group.length > 0)
    .flatMap((group, index) =>
      index === 0 || (group[0] !== 'separator' && 'heading' in (group[0] as object))
        ? group
        : ['separator' as const, ...group]
    );
}
