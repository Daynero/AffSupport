import { useState } from 'react';
import type {
  LibraryShareCopyRequest,
  LibraryShareCopyResult,
  TeamDownloadGrantResult
} from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { teamErrorMessage } from '../errors';
import { MediaActionIcon } from './mediaActionIcons';

export interface LibraryShareClient {
  getLibrarySharePreference(teamId: string): Promise<{
    allowLinkOnCopy: boolean;
    remembered: boolean;
  }>;
  shareLibraryMaterial(request: LibraryShareCopyRequest): Promise<LibraryShareCopyResult>;
  requestDownload(
    teamId: string,
    materialId: string,
    consumer: 'browser'
  ): Promise<TeamDownloadGrantResult>;
}

const defaultClient: LibraryShareClient = teamApi;

export function LibraryShareActions({
  teamId,
  materialId,
  client = defaultClient
}: {
  teamId: string;
  materialId: string;
  client?: LibraryShareClient;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const [busy, setBusy] = useState<'copy' | 'open' | 'download' | 'approve' | null>(null);
  const [confirmation, setConfirmation] = useState<Extract<
    LibraryShareCopyResult,
    { state: 'confirmation_required' }
  > | null>(null);
  const [remember, setRemember] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = (allowIfRestricted: boolean, rememberChoice = false) =>
    client.shareLibraryMaterial({
      teamId,
      materialId,
      allowIfRestricted,
      rememberChoice,
      idempotencyKey: `library.share.${crypto.randomUUID()}`
    });

  const copyReady = async (result: Extract<LibraryShareCopyResult, { state: 'ready' }>) => {
    try {
      await navigator.clipboard.writeText(result.url);
    } catch {
      // The share itself succeeded — only the clipboard refused. Reporting this
      // as a Drive failure sent people to check the wrong thing (finding S3).
      throw new Error('CLIPBOARD_UNAVAILABLE');
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  const report = (cause: unknown) => {
    const code = cause instanceof Error ? cause.message : 'DRIVE_UNAVAILABLE';
    const text =
      code === 'CLIPBOARD_UNAVAILABLE' ? t('teamToastLinkCopyFailed') : teamErrorMessage(code, t);
    setError(text);
    push({ tone: 'error', text });
  };

  const copy = async () => {
    setBusy('copy');
    setError(null);
    try {
      const preference = await client.getLibrarySharePreference(teamId);
      const result = await request(preference.remembered && preference.allowLinkOnCopy);
      if (result.state === 'confirmation_required') setConfirmation(result);
      else await copyReady(result);
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    setBusy('approve');
    setError(null);
    try {
      const result = await request(true, remember);
      if (result.state !== 'ready') throw new Error('INVALID_RESPONSE');
      await copyReady(result);
      setConfirmation(null);
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(null);
    }
  };

  const open = async () => {
    setBusy('open');
    setError(null);
    try {
      const result = await request(false);
      window.open(result.url, '_blank', 'noopener,noreferrer');
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    setBusy('download');
    setError(null);
    try {
      const result = await client.requestDownload(teamId, materialId, 'browser');
      if (result.kind !== 'browser') throw new Error('INVALID_RESPONSE');
      window.location.assign(result.rangeUrl);
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="creative-library-share-actions">
      <Button
        type="button"
        variant="ghost"
        className="team-media-action is-copy-link"
        loading={busy === 'copy'}
        onClick={() => void copy()}
      >
        <MediaActionIcon kind="copy-link" />
        <span>{copied ? t('creativeLibraryLinkCopied') : t('creativeLibraryCopyLink')}</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="team-media-action is-open"
        loading={busy === 'open'}
        onClick={() => void open()}
      >
        <MediaActionIcon kind="open" />
        <span>{t('creativeLibraryOpenDrive')}</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="team-media-action is-download"
        loading={busy === 'download'}
        onClick={() => void download()}
      >
        <MediaActionIcon kind="download" />
        <span>{t('creativeLibraryDownload')}</span>
      </Button>
      {error && <small className="team-inline-error">{error}</small>}
      {confirmation && (
        <Modal
          labelledBy="creative-library-share-title"
          onClose={() => setConfirmation(null)}
          closeLabel={t('teamCancel')}
          size="md"
        >
          <div className="team-dialog-form">
            <h2 id="creative-library-share-title">{t('creativeLibraryShareTitle')}</h2>
            <p>{t('creativeLibrarySharePrompt')}</p>
            {!confirmation.canShare && (
              <p className="team-inline-error">{t('creativeLibraryShareUnavailable')}</p>
            )}
            <label className="creative-library-share-remember">
              <input
                type="checkbox"
                checked={remember}
                disabled={!confirmation.canShare}
                onChange={event => setRemember(event.target.checked)}
              />
              <span>{t('creativeLibraryShareRemember')}</span>
            </label>
            <div className="team-dialog-actions">
              <Button type="button" variant="ghost" onClick={() => setConfirmation(null)}>
                {t('teamCancel')}
              </Button>
              <Button
                type="button"
                variant="primary"
                loading={busy === 'approve'}
                disabled={!confirmation.canShare}
                onClick={() => void approve()}
              >
                {t('creativeLibraryShareApprove')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
