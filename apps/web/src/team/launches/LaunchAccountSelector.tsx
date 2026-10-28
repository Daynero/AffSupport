import { useState } from 'react';
import { ChevronRight, UserRound } from 'lucide-react';
import { getTeamAgentAvailability, type TeamAccountSummary } from '@video-compressor/shared';
import { LaunchAccountBrowser } from './LaunchAccountBrowser';
import { Button } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';

/** A single trigger selects existing workspace rows through the account browser. */
export function LaunchAccountSelector({
  id,
  value,
  accounts,
  disabled,
  onChange
}: {
  id: string;
  value: string;
  accounts: TeamAccountSummary[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const [browsing, setBrowsing] = useState(false);
  const selected = accounts
    .filter(account => !account.archivedAt)
    .flatMap(account =>
      account.agents
        .filter(agent => !agent.archivedAt)
        .map(agent => ({ ...agent, label: `${account.name} · ${agent.agentId.slice(-3)}` }))
    )
    .find(agent => agent.id === value);
  const availability = selected ? getTeamAgentAvailability(selected) : 'unknown';
  const free = availability === 'free';
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Button
        id={id}
        type="button"
        variant="secondary"
        block
        className="launch-account-trigger"
        aria-label={
          selected ? `${t('launchesAccountBrowse')}: ${selected.label}` : t('launchesAccountBrowse')
        }
        aria-describedby={selected ? `${id}-details` : value ? `${id}-unavailable` : undefined}
        aria-haspopup="dialog"
        aria-expanded={browsing && !disabled}
        leading={<UserRound size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        trailing={<ChevronRight size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        disabled={disabled}
        onClick={() => setBrowsing(true)}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1 text-left">
          <span className="whitespace-normal break-words">
            {selected?.label ?? t('launchesAccountBrowse')}
          </span>
          {selected && (
            <span id={`${id}-details`} className="flex flex-wrap gap-x-3 text-caption">
              <span className="break-all font-mono text-muted">ID {selected.agentId}</span>
              <span className={free ? 'text-success-text' : 'text-warning-text'}>
                {t(
                  availability === 'unknown'
                    ? 'teamAgentAvailabilityUnknown'
                    : free
                      ? 'teamAgentFree'
                      : 'teamAgentBusy'
                )}
              </span>
              {(selected.availability?.assignmentCount ?? 0) > 0 && (
                <span className="text-muted">
                  {t('launchesAssignmentCount', { count: selected.availability!.assignmentCount })}
                </span>
              )}
            </span>
          )}
        </span>
      </Button>
      {browsing && !disabled && (
        <LaunchAccountBrowser
          accounts={accounts}
          value={value}
          onChange={onChange}
          onClose={() => setBrowsing(false)}
        />
      )}
      {value && !selected && (
        <span id={`${id}-unavailable`} role="status" className="text-caption text-warning-text">
          {t('launchesAccountUnavailable')}
        </span>
      )}
    </div>
  );
}
