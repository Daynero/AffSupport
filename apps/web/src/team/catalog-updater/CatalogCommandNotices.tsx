import type { CatalogRegistryRow } from '../../api/team';
import { Button } from '../../components/ui/index';
import type { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { teamErrorCodeOf, teamErrorMessageFor } from '../errors';
import type { captureCatalogMutationOwner } from './captureCatalogMutationOwner';
import type { useCatalogCommands } from './useCatalogCommands';

/**
 * Lines above the manager's list about requests whose answer is not in yet, and about a list
 * that could not be read fresh (out of the dialog, 070 T056).
 */
export function CatalogCommandNotices({
  titleId,
  commands,
  rowsById,
  mayRun,
  owner,
  push,
  stale,
  lastLoadedAt,
  invalidRowCount,
  when,
  onReload
}: {
  titleId: string;
  commands: ReturnType<typeof useCatalogCommands>;
  rowsById: ReadonlyMap<string, CatalogRegistryRow>;
  mayRun: boolean;
  owner: ReturnType<typeof captureCatalogMutationOwner>;
  push: ReturnType<typeof useToasts>['push'];
  /** The last read failed while an older list is on screen. */
  stale: boolean;
  lastLoadedAt: string | null;
  invalidRowCount: number;
  when: (iso: string) => string;
  onReload: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {Boolean(commands.error) && (
        <p className="team-inline-error" role="alert">
          {teamErrorMessageFor(commands.error, t)}
        </p>
      )}
      {commands.states.map(state => {
        const captionId = `${titleId}-command-${state.intent.commandId}`;
        const names = state.intent.catalogIds
          .slice(0, 3)
          .flatMap(id => {
            const row = rowsById.get(id);
            return row ? [row.name] : [];
          })
          .join(', ');
        const code = teamErrorCodeOf(state.error);
        const recover = async (kind: 'check' | 'cancel') => {
          const outcome = await (kind === 'check'
            ? commands.check(state.intent.commandId)
            : commands.cancel(state.intent.commandId));
          if (owner.current() && outcome?.kind === 'rejected')
            push({ tone: 'error', text: teamErrorMessageFor(outcome.error, t) });
        };
        return (
          <div key={state.intent.commandId} className="team-inline-error" role="status">
            <p id={captionId}>
              {t(state.phase === 'working' ? 'catalogCommandChecking' : 'catalogCommandUnknown', {
                count: state.intent.catalogIds.length
              })}
              {names && (
                <>
                  {' '}
                  {names}
                  {state.intent.catalogIds.length > 3
                    ? ` ${t('catalogCommandMore', { count: state.intent.catalogIds.length - 3 })}`
                    : ''}
                </>
              )}
            </p>
            {state.phase === 'unknown' && code && code !== 'PROCESS_RESULT_UNCERTAIN' && (
              <p className="field-hint">
                {t('catalogCommandLastProblem', { message: teamErrorMessageFor(state.error, t) })}
              </p>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-describedby={captionId}
              disabled={state.phase === 'working'}
              onClick={() => void recover('check')}
            >
              {t('catalogCommandCheck')}
            </Button>
            {mayRun && (
              <Button
                size="sm"
                variant="ghost"
                aria-describedby={captionId}
                disabled={state.phase === 'working'}
                onClick={() => void recover('cancel')}
              >
                {t('catalogCommandCancel')}
              </Button>
            )}
          </div>
        );
      })}
      {commands.refreshing.length > 0 && (
        <div className="team-inline-error" role="status">
          <p>{t('catalogCommandRefresh')}</p>
          <Button size="sm" variant="ghost" onClick={() => void commands.refresh()}>
            {t('catalogCommandCheck')}
          </Button>
        </div>
      )}
      {stale && (
        <div className="team-inline-error" role="alert">
          {t('catalogUpdaterStale', {
            date: lastLoadedAt ? when(lastLoadedAt) : t('catalogUpdaterUnknownTime')
          })}{' '}
          <Button type="button" size="sm" variant="ghost" onClick={onReload}>
            {t('catalogUpdaterRetry')}
          </Button>
        </div>
      )}
      {invalidRowCount > 0 && (
        <div className="team-inline-error" role="alert">
          {t('catalogUpdaterPartialRead', { count: invalidRowCount })}
          <Button type="button" size="sm" variant="ghost" onClick={onReload}>
            {t('catalogUpdaterRetry')}
          </Button>
        </div>
      )}
    </>
  );
}
