import { useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryVideoTextVariant, LibraryVideoTextVariants } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button, DropdownMenu } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { MediaActionIcon } from './mediaActionIcons';

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
  onTranscribe,
  onRetranscribe,
  onCopied,
  compact = false
}: {
  teamId: string;
  videoId: string;
  client?: VideoTextActionsClient;
  onTranscribe: () => void;
  /** Re-run the transcription when text already exists (shown beside View/Copy). */
  onRetranscribe?: () => void;
  /** Notified after a successful copy — lets a host raise its own toast. */
  onCopied?: () => void;
  /**
   * Under a heading that already says "transcript", in a narrow pane: the
   * buttons drop the word "text" and fit one line (024, round 8).
   */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [payload, setPayload] = useState<LibraryVideoTextVariants | null>(null);
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [variantsOpen, setVariantsOpen] = useState(false);
  const variantTrigger = useRef<HTMLButtonElement>(null);

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
      onCopied?.();
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  if (loading) return <small>{t('creativeLibraryTextLoading')}</small>;
  if (readyVariants.length === 0) {
    return payload?.canProcess !== false ? (
      <Button
        color="neutral"
        variant="ghost"
        className="team-media-action is-transcribe"
        leading={<MediaActionIcon kind="transcribe" />}
        onClick={onTranscribe}
      >
        {t('creativeLibraryTranscribe')}
      </Button>
    ) : null;
  }

  const variantLabel = (variant: LibraryVideoTextVariant) =>
    variant.kind === 'original'
      ? t('creativeLibraryTextOriginal')
      : t('creativeLibraryTextTranslation', { language: variant.language });

  return (
    <div className="creative-library-text-actions">
      {readyVariants.length > 1 && (
        <>
          {/* One question with one answer, so the menu ticks the current one
              and closes on the choice. */}
          <Button
            ref={variantTrigger}
            color="neutral"
            variant="outline"
            size="sm"
            aria-haspopup="menu"
            aria-expanded={variantsOpen}
            onClick={() => setVariantsOpen(current => !current)}
          >
            {selected ? variantLabel(selected) : t('creativeLibraryTextVariant')}
          </Button>
          <DropdownMenu
            open={variantsOpen}
            onClose={() => setVariantsOpen(false)}
            anchor={variantTrigger}
            label={t('creativeLibraryTextVariant')}
            selection="single"
            items={readyVariants.map(variant => ({
              id: variant.materialId,
              label: variantLabel(variant),
              checked: variant.materialId === selectedMaterialId,
              onSelect: () => setSelectedMaterialId(variant.materialId)
            }))}
          />
        </>
      )}
      <Button
        color="neutral"
        variant="outline"
        size="sm"
        disabled={!text}
        aria-label={compact ? t('creativeLibraryViewText') : undefined}
        onClick={() => setViewing(true)}
      >
        {t(compact ? 'teamTranscriptViewShort' : 'creativeLibraryViewText')}
      </Button>
      {/* Pressed often enough that a flash would become noise: the word changes
          and nothing moves. */}
      <Button
        color="neutral"
        variant={compact ? 'outline' : 'ghost'}
        size="sm"
        disabled={!text}
        aria-label={compact && !copied ? t('creativeLibraryCopyText') : undefined}
        onClick={() => void copy()}
      >
        {copied
          ? t('creativeLibraryTextCopied')
          : t(compact ? 'teamTranscriptCopyShort' : 'creativeLibraryCopyText')}
      </Button>
      {onRetranscribe && (
        <Button
          color="neutral"
          variant={compact ? 'outline' : 'ghost'}
          size="sm"
          aria-label={compact ? t('teamTranscriptRedoLong') : undefined}
          onClick={onRetranscribe}
        >
          {t(compact ? 'teamTranscriptRedoShort' : 'teamTranscriptRedo')}
        </Button>
      )}
      {viewing && text && (
        <Modal
          labelledBy="creative-library-text-title"
          onClose={() => setViewing(false)}
          closeLabel={t('teamCancel')}
          size="xl"
        >
          <div className="creative-library-text-viewer">
            <h2 id="creative-library-text-title">{t('creativeLibraryTranscriptTitle')}</h2>
            <pre>{text}</pre>
            <div className="team-dialog-actions">
              <Button color="neutral" variant="outline" onClick={() => void copy()}>
                {copied ? t('creativeLibraryTextCopied') : t('creativeLibraryCopyText')}
              </Button>
              <Button color="primary" variant="solid" onClick={() => setViewing(false)}>
                {t('creativeLibraryDone')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
