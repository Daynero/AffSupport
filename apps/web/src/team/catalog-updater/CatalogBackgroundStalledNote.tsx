import { useI18n } from '../../i18n';
import { useOptionalAgent } from '../../AgentContext';

/** Native recovery retries itself; opening a settings switch is never required. */
export function CatalogBackgroundStalledNote(_props: { teamId: string; onRetried?: () => void }) {
  const { t } = useI18n();
  const agent = useOptionalAgent();
  return (
    <span className="catalog-background-stalled" role="status">
      {t(
        agent?.connection === 'connected'
          ? 'catalogBackgroundStalledRetried'
          : 'catalogVideoCreationWaitingAgent'
      )}
    </span>
  );
}
