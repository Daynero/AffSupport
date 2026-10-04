import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, UserRound } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../../components/icons';
import { useI18n } from '../../../i18n';
import { countAgentsByLabel, teamAccountHue } from '../AccountGroup';
import { agentCountKey } from '../plural';
import type { TeamAccountAgentSummary } from '@video-compressor/shared';

/** Same account shell, heading and rail as the operational account list. */
export function FinanceAccountGroup({
  id,
  name,
  count,
  agents,
  children
}: {
  id: string;
  name: string;
  count: number;
  agents: readonly TeamAccountAgentSummary[];
  children: ReactNode;
}) {
  const { t, language } = useI18n();
  const nameId = useId();
  const [open, setOpen] = useState(true);
  return (
    <section
      className={`team-account${open ? '' : ' is-collapsed'}`}
      aria-labelledby={nameId}
      data-account-id={id}
      style={{ '--team-account-hue': teamAccountHue(id) } as CSSProperties}
    >
      <div className="team-account-head" onClick={() => setOpen(value => !value)}>
        <div className="team-account-title">
          <button
            type="button"
            className="team-account-toggle"
            aria-expanded={open}
            aria-label={t(open ? 'teamAccountCollapse' : 'teamAccountExpand', { name })}
            onClick={event => {
              event.stopPropagation();
              setOpen(value => !value);
            }}
          >
            <ChevronDown size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
          <span className="team-account-mark" aria-hidden="true">
            <UserRound size={ICON_SIZE} strokeWidth={ICON_STROKE} />
          </span>
          <h3 className="team-account-name" id={nameId} title={name}>
            {name}
          </h3>
          <span className="team-account-meta">
            <span>{t(agentCountKey(language, count), { count })}</span>
            {countAgentsByLabel(agents).map(({ label, count }) => (
              <span
                key={label.id}
                className="team-task-label-chip is-count"
                data-color={label.color}
                title={t('teamAccountAgentsByTag', { tag: label.name, count })}
              >
                <span className="team-task-label-chip-dot" aria-hidden="true" />
                <span className="team-task-label-chip-name">{label.name}</span>
                <b>{count}</b>
              </span>
            ))}
          </span>
        </div>
      </div>
      {/* Keep drafts mounted when folding, as in the operational view. */}
      <div className={open ? 'team-account-agents' : 'hidden'}>{children}</div>
    </section>
  );
}
