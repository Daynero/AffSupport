import { useState } from 'react';
import { Share2 } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import type { TeamMaterialRow } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';

/**
 * Share by link (011): one press gives everyone with the link read-only
 * access and copies it, with a green confirmation. The same control on files
 * and folders, level with the row's menu.
 */
export function ShareButton({
  teamId,
  row,
  className = 'team-explorer-share'
}: {
  teamId: string;
  row: TeamMaterialRow;
  /** The tile shows it as its own control; the detail card shows it among its icons. */
  className?: string;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const [busy, setBusy] = useState(false);

  const share = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await teamApi.shareLibraryMaterial({
        teamId,
        materialId: row.id,
        allowIfRestricted: true,
        rememberChoice: true,
        idempotencyKey: crypto.randomUUID()
      });
      if (result.state !== 'ready') {
        push({ tone: 'error', text: t('teamShareFailed') });
        return;
      }
      try {
        await navigator.clipboard.writeText(result.url);
        push({ tone: 'success', text: t('teamShareCopied') });
      } catch {
        // A browser that refuses the clipboard still made the link; show it.
        push({ tone: 'success', text: `${t('teamShareReady')} ${result.url}` });
      }
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={className}
      aria-label={t('teamShareAction', { name: row.name })}
      data-tip={t('teamShareAction', { name: row.name })}
      title={t('teamShareAction', { name: row.name })}
      disabled={busy}
      onClick={event => {
        event.stopPropagation();
        void share();
      }}
    >
      <Share2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
    </button>
  );
}
