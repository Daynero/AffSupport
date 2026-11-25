import { useEffect, useRef, useId, useState } from 'react';
import { Check, ChevronRight, ArrowLeft, UserRound } from 'lucide-react';
import {
  countTeamAccounts,
  filterTeamAccounts,
  getTeamAgentAvailability,
  teamAgentRunsSummary,
  type TeamAccountSummary,
  type TeamAccountOccupancyFilter
} from '@video-compressor/shared';
import { AccountPickerLabel } from '../accounts/AccountPickerLabel';
import { analytics } from '../../analytics/service';
import { Modal } from '../../components/Modal';
import { Button, EmptyState, Input, SegmentedControl } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';

/** Account-first browsing shares the task picker's visual and occupancy vocabulary. */
export function LaunchAccountBrowser({
  accounts,
  value,
  onChange,
  onClose
}: {
  accounts: TeamAccountSummary[];
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const attempt = useRef<{ id: string; done: boolean } | null>(null);
  const signal = (
    event: 'operation_started' | 'operation_completed' | 'operation_cancelled',
    id: string
  ) => {
    try {
      analytics.track(event, { flow_step: 'launch_account_picker', flow_id: id, attempt_id: id });
    } catch {
      /* Missing delivery remains unknown; selection must still work. */
    }
  };
  useEffect(() => {
    const current = { id: crypto.randomUUID(), done: false };
    attempt.current = current;
    signal('operation_started', current.id);
    return () => {
      if (!current.done) signal('operation_cancelled', current.id);
    };
  }, []);

  const [socialId, setSocialId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [occupancy, setOccupancy] = useState<TeamAccountOccupancyFilter>('all');
  const active = accounts
    .filter(account => !account.archivedAt)
    .map(account => ({
      ...account,
      agents: account.agents.filter(agent => !agent.archivedAt)
    }));
  const social = active.find(account => account.id === socialId);
  const counts = countTeamAccounts(social ? [social] : active);
  const shown = filterTeamAccounts(active, { search, occupancy }).filter(
    account => occupancy === 'all' || account.agents.length > 0
  );
  const rows = socialId ? shown.filter(account => account.id === socialId) : shown;
  const hasResults =
    socialId || search.trim() ? rows.some(account => account.agents.length > 0) : rows.length > 0;
  const totals = { all: counts.agents, free: counts.free, busy: counts.busy };
  const filters: readonly TeamAccountOccupancyFilter[] = ['all', 'free', 'busy'];
  return (
    <Modal
      layout="search"
      nested
      labelledBy={titleId}
      onClose={onClose}
      closeLabel={t('teamCancel')}
      size="md"
    >
      <div className="team-task-picker-dialog team-task-account-picker launch-account-browser">
        <div className="team-task-account-picker-heading">
          <h2 id={titleId}>{t('launchesAccount')}</h2>
        </div>
        <Input
          aria-label={t('launchesAccountSearch')}
          placeholder={t('launchesAccountSearch')}
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        {/* One of three, so the inventory's segmented control (070, T080). */}
        <SegmentedControl<TeamAccountOccupancyFilter>
          className="team-task-account-picker-occupancy"
          size="xs"
          label={t('teamAccountsFilterLabel')}
          value={occupancy}
          onChange={setOccupancy}
          options={filters.map(filter => ({
            value: filter,
            label: `${t(
              filter === 'all'
                ? 'teamAccountsFilterAll'
                : filter === 'free'
                  ? 'teamAccountsFilterFree'
                  : 'teamAccountsFilterBusy'
            )} · ${totals[filter]}`
          }))}
        />
        {social && (
          <nav className="team-task-account-picker-crumb" aria-label={t('teamAccountsTitle')}>
            <Button
              size="sm"
              variant="ghost"
              className="team-task-account-picker-back"
              leading={<ArrowLeft size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
              onClick={() => setSocialId(null)}
            >
              {t('teamAccountsTitle')}
            </Button>
            <strong aria-current="page">{social.name}</strong>
          </nav>
        )}
        <div className="modal-search-results">
          {!hasResults ? (
            <EmptyState size="sm" title={t('launchesAccountNoResults')} />
          ) : (
            <ul className="team-task-picker-results team-task-picker-folder-results">
              {rows.map(account => {
                const total = countTeamAccounts([active.find(item => item.id === account.id)!]);
                // Search exposes matching RK directly; browsing starts at the social level.
                return !socialId && !search.trim() ? (
                  <li key={account.id}>
                    <Button
                      variant="ghost"
                      block
                      className="team-task-picker-row"
                      onClick={() => setSocialId(account.id)}
                    >
                      <span className="team-task-picker-item-type" aria-hidden="true">
                        <UserRound size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                      </span>
                      <span className="team-task-picker-item-copy">
                        <strong>{account.name}</strong>
                        <small>
                          {total.agents === 0 ? (
                            t('teamAccountAgentsNone')
                          ) : (
                            <>
                              <span className="text-success-text">
                                {t('teamAccountsFilterFree')} · {total.free}
                              </span>
                              {' · '}
                              <span className="text-warning-text">
                                {t('teamAccountsFilterBusy')} · {total.busy}
                              </span>
                            </>
                          )}
                        </small>
                      </span>
                      <ChevronRight size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    </Button>
                  </li>
                ) : (
                  account.agents.map(agent => {
                    const availability = getTeamAgentAvailability(agent);
                    const free = availability === 'free';
                    return (
                      <li key={agent.id}>
                        <Button
                          variant="ghost"
                          block
                          aria-pressed={agent.id === value}
                          className={`team-task-picker-row ${agent.id === value ? 'is-selected' : ''} ${free ? 'is-free' : ''}`}
                          onClick={() => {
                            onChange(agent.id);
                            if (attempt.current) {
                              attempt.current.done = true;
                              signal('operation_completed', attempt.current.id);
                            }
                            onClose();
                          }}
                        >
                          <span className="team-task-picker-item-copy">
                            <AccountPickerLabel
                              name={`${account.name} · ${agent.agentId.slice(-3)}`}
                              labels={agent.labels}
                            />
                            <small className="font-mono">ID {agent.agentId}</small>
                            <small className={free ? 'text-success-text' : 'text-warning-text'}>
                              {t(free ? 'teamAgentFree' : 'teamAgentBusy')}
                            </small>
                            {(agent.availability?.assignmentCount ?? 0) > 0 && (
                              <small>
                                {t('launchesAssignmentCount', {
                                  count: agent.availability!.assignmentCount
                                })}
                              </small>
                            )}
                            {!free && (
                              <small className="whitespace-normal break-words">
                                {teamAgentRunsSummary(agent)}
                              </small>
                            )}
                          </span>
                          {agent.id === value && (
                            <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                          )}
                        </Button>
                      </li>
                    );
                  })
                );
              })}
            </ul>
          )}
        </div>
        <div className="team-dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            {t('teamCancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
