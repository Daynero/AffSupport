import { useState } from 'react';
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
export function ShareButton({ teamId, row }: { teamId: string; row: TeamMaterialRow }) {
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
      className="team-explorer-share"
      aria-label={t('teamShareAction', { name: row.name })}
      title={t('teamShareAction', { name: row.name })}
      disabled={busy}
      onClick={event => {
        event.stopPropagation();
        void share();
      }}
    >
      <ShareIcon />
    </button>
  );
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81a3 3 0 1 0-3-3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9a3 3 0 0 0 0 6c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65a2.92 2.92 0 1 0 2.92-2.92z"
      />
    </svg>
  );
}
