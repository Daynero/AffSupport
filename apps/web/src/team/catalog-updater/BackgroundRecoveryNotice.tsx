import type { BackgroundRecoveryStatus } from '../../api/recovery.js';
import { Alert } from '../../components/ui/index.js';
import { useI18n } from '../../i18n.js';
import { teamErrorMessageFor } from '../errors.js';
/** Normal automatic setup is quiet; an authority/update problem must remain visible. */
export function BackgroundRecoveryNotice({
  status,
  errorCode
}: {
  status: BackgroundRecoveryStatus | null;
  errorCode: string | null;
}) {
  const { t } = useI18n();
  const code = errorCode ?? (status?.automaticSetup === 'blocked' ? 'PERMISSION_DENIED' : null);
  if (!code) return null;
  return (
    <Alert color="warning" variant="subtle">
      <span>
        {t('backgroundRecoveryAttention')} {teamErrorMessageFor({ code }, t)}
      </span>
    </Alert>
  );
}
