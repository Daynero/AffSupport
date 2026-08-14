import { useEffect, useMemo, useState } from 'react';
import type { LibraryVideoTextVariant, LibraryVideoTextVariants } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';

export interface VideoTextActionsClient {
  listVideoTextVariants(teamId: string, videoId: string): Promise<LibraryVideoTextVariants>;
}

const defaultClient: VideoTextActionsClient = teamApi;

function currentText(variant: LibraryVideoTextVariant | undefined): string | null {
  return variant?.ingestState === 'full' && !variant.truncated && variant.text
    ? variant.text
    : null;
}

export function VideoTextActions({
  teamId,
  videoId,
  client = defaultClient,
  onTranscribe
}: {
  teamId: string;
  videoId: string;
  client?: VideoTextActionsClient;
  onTranscribe: () => void;
}) {
  const { t } = useI18n();
  const [payload, setPayload] = useState<LibraryVideoTextVariants | null>(null);
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void client
      .listVideoTextVariants(teamId, videoId)
      .then(value => {
        if (!active) return;
        setPayload(value);
        const preferred =
          value.variants.find(variant => variant.kind === 'translation') ?? value.variants[0];
        setSelectedMaterialId(preferred?.materialId ?? null);
      })
      .catch(() => {
        if (active) setPayload(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, teamId, videoId]);

  const selected = useMemo(
    () => payload?.variants.find(variant => variant.materialId === selectedMaterialId),
    [payload, selectedMaterialId]
  );
  const text = currentText(selected);
  const readyVariants = payload?.variants.filter(variant => currentText(variant) !== null) ?? [];

  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  if (loading) return <small>{t('creativeLibraryTextLoading')}</small>;
  if (readyVariants.length === 0) {
    return payload?.canProcess !== false ? (
      <Button type="button" variant="ghost" onClick={onTranscribe}>
        {t('creativeLibraryTranscribe')}
      </Button>
    ) : null;
  }

  return (
    <div className="creative-library-text-actions">
      {readyVariants.length > 1 && (
        <select
          aria-label={t('creativeLibraryTextVariant')}
          value={selectedMaterialId ?? ''}
          onChange={event => setSelectedMaterialId(event.target.value)}
        >
          {readyVariants.map(variant => (
            <option key={variant.materialId} value={variant.materialId}>
              {variant.kind === 'original'
                ? t('creativeLibraryTextOriginal')
                : t('creativeLibraryTextTranslation', { language: variant.language })}
            </option>
          ))}
        </select>
      )}
      <Button type="button" variant="ghost" disabled={!text} onClick={() => setViewing(true)}>
        {t('creativeLibraryViewText')}
      </Button>
      <Button type="button" variant="ghost" disabled={!text} onClick={() => void copy()}>
        {copied ? t('creativeLibraryTextCopied') : t('creativeLibraryCopyText')}
      </Button>
      {viewing && text && (
        <Modal
          labelledBy="creative-library-text-title"
          onClose={() => setViewing(false)}
          closeLabel={t('teamCancel')}
          size="lg"
        >
          <div className="creative-library-text-viewer">
            <h2 id="creative-library-text-title">{t('creativeLibraryTranscriptTitle')}</h2>
            <pre>{text}</pre>
            <div className="team-dialog-actions">
              <Button type="button" variant="secondary" onClick={() => void copy()}>
                {copied ? t('creativeLibraryTextCopied') : t('creativeLibraryCopyText')}
              </Button>
              <Button type="button" variant="primary" onClick={() => setViewing(false)}>
                {t('creativeLibraryDone')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
