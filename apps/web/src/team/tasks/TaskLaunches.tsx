import { useCallback, useEffect, useState } from 'react';
import { Plus, Rocket, X } from 'lucide-react';
import type { LaunchSummary } from '@video-compressor/shared';
import { launchApi, teamApi } from '../../api/team';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useOptionalToasts } from '../../components/toast';
import { Button, IconButton, PickerDialog, type PickerItem } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { navigateTo } from '../../lib/navigation';
import { teamErrorMessageFor } from '../errors';
import { LaunchCard } from '../launches/LaunchCard';
import { campaignCountLabel } from '../launches/campaignCountLabel';
import { launchCardLabels, launchCardState } from '../launches/launchPresentation';
import { buildTeamRoute, emptyTeamRouteQuery } from '../routes';

/** What a launch is called in a list: its offer, else its creative, else its account. */
export function launchTitle(value: LaunchSummary): string {
  return (
    value.offer.trim() || value.creativeAlias.trim() || (value.accountName ?? '').trim() || '—'
  );
}

function launchHref(teamId: string, launchId: string): string {
  return buildTeamRoute({
    spaceId: teamId,
    section: 'launches',
    query: { ...emptyTeamRouteQuery(), launchId }
  });
}

/**
 * 076 US2 — the launches that are this task's work, in the task.
 *
 * The same cards as the launch board, small; a press opens the launch. «Add»
 * opens the one picker (075) over the space's launches; «Remove» takes the launch
 * out of the task and leaves it where it is.
 */
export function TaskLaunches({
  teamId,
  taskId,
  canEdit
}: {
  teamId: string;
  taskId: string;
  canEdit: boolean;
}) {
  const { t } = useI18n();
  const toasts = useOptionalToasts();
  const [launches, setLaunches] = useState<LaunchSummary[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    // A failed read shows the empty block: the task itself does not depend on it.
    void Promise.resolve()
      .then(() => teamApi.listTaskLaunchIds(teamId, taskId))
      .then(async ids => {
        if (ids.length === 0) return [];
        const pages = [];
        for (let offset = 0; offset < ids.length; offset += 100)
          pages.push(launchApi.list(teamId, { ids: ids.slice(offset, offset + 100) }, 100));
        const found = (await Promise.all(pages)).flatMap(page => page.items);
        // In the order they were put into the task.
        return ids.flatMap(id => found.filter(launch => launch.id === id));
      })
      .then(value => {
        if (live) setLaunches(value);
      })
      .catch(() => {
        if (live) setLaunches([]);
      });
    return () => {
      live = false;
    };
  }, [round, taskId, teamId]);

  const reload = useCallback(() => setRound(value => value + 1), []);

  const remove = async (launch: LaunchSummary) => {
    try {
      await teamApi.detachTaskLaunch(teamId, taskId, launch.id);
      setLaunches(current => current?.filter(item => item.id !== launch.id) ?? null);
    } catch (cause) {
      toasts?.push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    }
  };

  const count = launches?.length ?? 0;
  return (
    <section className="team-task-launches" aria-labelledby={`team-task-launches-${taskId}`}>
      <div className="team-task-launches-head">
        <h3 id={`team-task-launches-${taskId}`}>
          {t('taskLaunchesTitle')}
          {count > 0 && <span className="team-task-launches-count">{count}</span>}
        </h3>
        {canEdit && (
          <Button
            size="sm"
            variant="ghost"
            leading={<Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            onClick={() => setPicking(true)}
          >
            {count > 0 ? t('taskLaunchesAdd') : t('taskLaunchesAddFirst')}
          </Button>
        )}
      </div>
      {count > 0 && (
        <ul className="team-task-launches-list">
          {launches!.map(launch => (
            <li key={launch.id}>
              <LaunchCard value={launch} onOpen={() => navigateTo(launchHref(teamId, launch.id))} />
              {canEdit && (
                <IconButton
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  className="team-task-launches-remove"
                  label={t('taskLaunchesRemove', { launch: launchTitle(launch) })}
                  onClick={() => void remove(launch)}
                >
                  <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {picking && (
        <TaskLaunchPicker
          teamId={teamId}
          attached={new Set((launches ?? []).map(launch => launch.id))}
          onClose={() => setPicking(false)}
          onAdd={async ids => {
            try {
              await teamApi.attachTaskLaunches({ teamId, taskId, launchIds: ids });
              setPicking(false);
              reload();
            } catch (cause) {
              toasts?.push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
            }
          }}
        />
      )}
    </section>
  );
}

/** The space's launches, newest first, searchable; ticks become the task's. */
export function TaskLaunchPicker({
  teamId,
  attached,
  onAdd,
  onClose
}: {
  teamId: string;
  attached: ReadonlySet<string>;
  onAdd: (launchIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<LaunchSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<Map<string, LaunchSummary>>(new Map());

  useEffect(() => {
    let live = true;
    setFailed(false);
    const timer = window.setTimeout(() => {
      const term = query.normalize('NFC').trim();
      void launchApi
        .list(teamId, { sort: 'created', ...(term ? { search: term } : {}) }, 50)
        .then(page => {
          if (!live) return;
          setFound(page.items);
          setNames(current => {
            const next = new Map(current);
            for (const item of page.items) next.set(item.id, item);
            return next;
          });
        })
        .catch(() => {
          if (live) setFailed(true);
        });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, teamId]);

  // Launches of one offer read the same by name; when they were made and how far they got
  // is what tells them apart (beta, 27.11: seven rows of «Clothing · g1 · img1 · 15 лист.»).
  const when = new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
  const items: PickerItem[] = (found ?? []).map(launch => {
    const isAttached = attached.has(launch.id);
    const made = launch.createdAt ?? launch.launchDate;
    return {
      id: launch.id,
      title: launchTitle(launch),
      icon: <Rocket size={16} strokeWidth={ICON_STROKE} />,
      disabled: isAttached,
      subtitle: isAttached
        ? t('taskLaunchesAlready')
        : [
            t(launchCardLabels[launchCardState(launch)]),
            launch.accountName,
            launch.creativeAlias !== launchTitle(launch) ? launch.creativeAlias : '',
            launch.campaignCount
              ? `${launch.campaignCount} ${campaignCountLabel(language, launch.campaignCount)}`
              : '',
            made && Number.isFinite(Date.parse(made)) ? when.format(new Date(made)) : ''
          ]
            .filter(Boolean)
            .join(' · ')
    };
  });

  return (
    <PickerDialog
      title={t('taskLaunchesPickerTitle')}
      onClose={onClose}
      closeLabel={t('teamCancel')}
      mode="multiple"
      search={{
        value: query,
        onChange: setQuery,
        placeholder: t('taskLaunchesSearch'),
        clearLabel: t('teamSearchClear')
      }}
      items={items}
      loading={found === null && !failed}
      loadingLabel={t('taskLaunchesLoading')}
      error={failed ? t('taskLaunchesLoadFailed') : null}
      empty={{ title: t(query.trim() ? 'taskLaunchesNoMatch' : 'taskLaunchesNone') }}
      selected={selected}
      onPick={item =>
        setSelected(current => {
          const next = new Set(current);
          if (next.has(item.id)) next.delete(item.id);
          else next.add(item.id);
          return next;
        })
      }
      footer={{
        summary: selected.size
          ? [...selected]
              .map(id => names.get(id))
              .filter((launch): launch is LaunchSummary => Boolean(launch))
              .map(launchTitle)
              .slice(0, 3)
              .join(', ') + (selected.size > 3 ? ` +${selected.size - 3}` : '')
          : null,
        cancelLabel: t('teamCancel'),
        confirmLabel: t('taskLaunchesAddSelected', { count: selected.size }),
        confirmDisabled: selected.size === 0,
        busy,
        onConfirm: () => {
          setBusy(true);
          void onAdd([...selected]).finally(() => setBusy(false));
        }
      }}
    />
  );
}
