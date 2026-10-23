import { Check } from 'lucide-react';
import { TEAM_ACCOUNT_NAME_COLORS, type TeamAccountSummary } from '@video-compressor/shared';
import { SelectMenu } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';

/** Keep the workspace order and actual row identity, even when account suffixes collide. */
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
  const options = accounts
    .filter(account => !account.archivedAt)
    .flatMap(account =>
      account.agents
        .filter(agent => !agent.archivedAt)
        .map(agent => ({
          value: agent.id,
          label: `${account.name} · ${agent.agentId.slice(-3)}`,
          description: `ID ${agent.agentId}`,
          searchText: `${account.name} ${agent.agentId}`,
          social: account.name,
          nameColor: TEAM_ACCOUNT_NAME_COLORS[agent.nameColor ?? 0],
          suffix: agent.agentId.slice(-3)
        }))
    );
  const rowsById = new Map(options.map(option => [option.value, option]));
  const selected = options.find(option => option.value === value);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <SelectMenu
        id={id}
        label={t('launchesAccount')}
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled}
        showSearchIcon
        placeholder={t('launchesAccountSearch')}
        emptyLabel={t('launchesAccountEmpty')}
        noResultsLabel={t('launchesAccountNoResults')}
        errorLabel={t('launchesInvalid')}
        renderOption={(option, isSelected) => {
          const row = rowsById.get(option.value)!;
          return (
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="whitespace-normal break-words">{row.social}</span>
                <span className="break-all font-mono text-caption text-muted">
                  {row.description}
                </span>
              </div>
              <span
                data-name-color-value={row.nameColor}
                className="launch-account-suffix shrink-0 rounded-sm bg-neutral-soft px-2 py-1 font-mono text-caption"
              >
                {row.suffix}
              </span>
              {isSelected && (
                <Check
                  size={ICON_SIZE}
                  strokeWidth={ICON_STROKE}
                  aria-hidden="true"
                  className="shrink-0"
                />
              )}
            </div>
          );
        }}
      />
      {selected && (
        <span className="break-all font-mono text-caption text-muted">{selected.description}</span>
      )}
      {value && !selected && (
        <span role="status" className="text-caption text-warning-text">
          {t('launchesAccountUnavailable')}
        </span>
      )}
    </div>
  );
}
