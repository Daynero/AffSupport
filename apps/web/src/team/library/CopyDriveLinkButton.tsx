import { useState } from 'react';
import type { LibraryShareCopyRequest, LibraryShareCopyResult } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { MediaActionIcon } from './mediaActionIcons';

export interface CopyDriveLinkClient {
  shareLibraryMaterial(request: LibraryShareCopyRequest): Promise<LibraryShareCopyResult>;
}

const defaultClient: CopyDriveLinkClient = teamApi;

/**
 * One-click "copy the Google Drive link" affordance, reused across every media
 * surface (catalog rows, library cards). Mirrors the task-attachment tile: it
 * provisions an "anyone with the link" reader permission when needed and copies
 * Drive's canonical webViewLink, so members never leave the workspace to share.
 */
export function CopyDriveLinkButton({
  teamId,
  materialId,
  name,
  client = defaultClient,
  className = ''
}: {
  teamId: string;
  materialId: string;
  name: string;
  client?: CopyDriveLinkClient;
  className?: string;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const result = await client.shareLibraryMaterial({
        teamId,
        materialId,
        allowIfRestricted: true,
        rememberChoice: false,
        idempotencyKey: `library.copy-link.${crypto.randomUUID()}`
      });
      if (result.state !== 'ready') throw new Error('SHARE_NOT_READY');
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      className={`team-media-action is-copy-link ${className}`.trim()}
      loading={busy}
      aria-label={t('creativeLibraryCopyLinkFor', { name })}
      title={failed ? t('teamTaskAttachmentActionFailed') : undefined}
      onClick={() => void copy()}
    >
      <MediaActionIcon kind="copy-link" />
      <span>{copied ? t('creativeLibraryLinkCopied') : t('creativeLibraryCopyLink')}</span>
    </Button>
  );
}
