import { useEffect, useMemo, useRef, useState } from 'react';
import { recordOriginalResultDelivery } from './original-result-analytics';
import {
  splitTranscriptLines,
  type LibraryVideoTextVariant,
  type LibraryVideoTextVariants
} from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Alert, Button, Chip } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { translationClient, type TranslationClient } from '../../translation/api';
import { allowanceFigures, formatMinutes } from '../../translation/format';
import { TranslateLauncher } from '../../translation/TranslateLauncher';
import { TranslationProgress } from '../../translation/TranslationProgress';
import {
  CopyVariantButton,
  TextVariantReader,
  TextVariantTabs,
  variantName
} from '../../translation/TextVariantViews';
import { useTextVariants, type TextVariant } from '../../translation/useTextVariants';
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

/**
 * The text of one space video, where the video is (012, 024, 063): view, copy, translate and
 * redo, and every translation of it beside the original.
 */
export function VideoTextActions({
  teamId,
  videoId,
  videoName,
  client = defaultClient,
  translations = translationClient,
  onTranscribe,
  onRetranscribe,
  onCopied,
  compact = false
}: {
  teamId: string;
  videoId: string;
  /** Shown as the viewer's title, so a person knows which video's text is open. */
  videoName?: string;
  client?: VideoTextActionsClient;
  translations?: TranslationClient;
  onTranscribe: () => void;
  /** Re-run the transcription when text already exists (shown beside View/Copy). */
  onRetranscribe?: () => void;
  /** Notified after a successful copy, with the name of the text copied. */
  onCopied?: (variant: string) => void;
  /**
   * Under a heading that already says "transcript", in a narrow pane: the
   * buttons drop the word "text" and fit one line (024, round 8).
   */
  compact?: boolean;
}) {
  const { t, language } = useI18n();
  const [payload, setPayload] = useState<LibraryVideoTextVariants | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const visibleAttempts = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    setLoading(true);
    void client
      .listVideoTextVariants(teamId, videoId)
      .then(value => {
        if (!active) return;
        setPayload({
          ...value,
          variants: value.variants.filter(variant => variant.kind === 'original')
        });
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

  const selected = payload?.variants.find(variant => currentText(variant) !== null);
  const text = currentText(selected);
  const segments = useMemo(() => (text ? splitTranscriptLines(text) : null), [text]);
  const source = useMemo(
    () =>
      segments && segments.length > 0
        ? {
            scope: 'team_video' as const,
            teamId,
            videoId,
            language: selected?.language ?? null,
            segments,
            rawText: text ?? undefined
          }
        : null,
    [segments, selected?.language, teamId, text, videoId]
  );
  const state = useTextVariants(source, translations);
  const shownVariant: TextVariant =
    (viewing && viewing !== 'original'
      ? state.translations.find(item => item.key === viewing)
      : undefined) ?? state.original;

  useEffect(() => {
    if (
      viewing !== 'original' ||
      !text ||
      !selected?.attemptId ||
      visibleAttempts.current.has(selected.attemptId)
    )
      return;
    visibleAttempts.current.add(selected.attemptId);
    recordOriginalResultDelivery(selected, 'visible');
  }, [viewing, text, selected]);

  const copied = (variant: TextVariant, name: string) => {
    if (variant.kind === 'original' && selected) recordOriginalResultDelivery(selected, 'copied');
    onCopied?.(name);
  };

  if (loading) return <small>{t('creativeLibraryTextLoading')}</small>;
  if (!text) {
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

  const ready = state.translations.filter(item => item.status === 'ready');
  const strips = state.translations.filter(
    item => item.status === 'processing' || item.status === 'failed'
  );
  const shownChips = ready.slice(0, 3);
  const stale = shownVariant.kind === 'translation' && shownVariant.stale;
  const refresh = allowanceFigures(
    state.units,
    state.allowance?.usedUnits ?? 0,
    state.allowance?.limitUnits ?? 0
  );

  return (
    <div className="video-text-actions">
      <div className="creative-library-text-actions">
        <Button
          color="neutral"
          variant="outline"
          size="sm"
          aria-label={compact ? t('creativeLibraryViewText') : undefined}
          onClick={() => setViewing('original')}
        >
          {t(compact ? 'teamTranscriptViewShort' : 'creativeLibraryViewText')}
        </Button>
        <CopyVariantButton
          state={state}
          scope="team_video"
          variant={compact ? 'outline' : 'ghost'}
          label={t(compact ? 'teamTranscriptCopyShort' : 'creativeLibraryCopyText')}
          ariaLabel={t('creativeLibraryCopyText')}
          onCopied={copied}
        />
        <TranslateLauncher
          state={state}
          trigger={compact ? 'compact' : 'button'}
          onOpenTranslation={target => setViewing(`translation:${target}`)}
        />
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
      </div>
      {shownChips.length > 0 && (
        <div className="video-text-chips" aria-label={t('textTranslationVariants')} role="group">
          {shownChips.map(item => (
            <Chip key={item.key} size="sm" variant="soft" onSelect={() => setViewing(item.key)}>
              {variantName(item, language, t('textTranslationOriginal'))}
            </Chip>
          ))}
          {ready.length > shownChips.length && (
            <Chip
              size="sm"
              variant="soft"
              onSelect={() => setViewing(ready[shownChips.length]!.key)}
            >
              {t('textTranslationMore', { count: ready.length - shownChips.length })}
            </Chip>
          )}
        </div>
      )}
      {strips.length > 0 && (
        <div className="video-text-translating">
          {strips.map(item => (
            <TranslationProgress
              key={item.translationId}
              variant={item}
              compact
              onRetry={item.status === 'failed' ? () => void state.start(item.language) : undefined}
            />
          ))}
        </div>
      )}
      {viewing && (
        <Modal
          labelledBy="creative-library-text-title"
          onClose={() => setViewing(null)}
          closeLabel={t('teamCancel')}
          size="xl"
        >
          <div className="creative-library-text-viewer video-text-viewer">
            <div className="video-text-viewer-head">
              <h2 id="creative-library-text-title" title={videoName}>
                {videoName ?? t('creativeLibraryTranscriptTitle')}
              </h2>
              <TextVariantTabs
                state={state}
                value={shownVariant.key}
                onChange={setViewing}
                scope="team_video"
              />
            </div>
            <div>
              {shownVariant.kind === 'translation' && shownVariant.status !== 'ready' && (
                <TranslationProgress
                  variant={shownVariant}
                  onRetry={
                    shownVariant.status === 'failed'
                      ? () => void state.start(shownVariant.language)
                      : undefined
                  }
                />
              )}
              {stale && (
                <Alert
                  color="warning"
                  variant="soft"
                  live="none"
                  action={
                    refresh.fits ? (
                      <Button
                        size="sm"
                        color="neutral"
                        variant="outline"
                        onClick={() => void state.start(shownVariant.language)}
                      >
                        {t('textTranslationRefresh', {
                          need: formatMinutes(refresh.need, language)
                        })}
                      </Button>
                    ) : undefined
                  }
                >
                  {t('textTranslationStale')}
                </Alert>
              )}
            </div>
            <div className="video-text-viewer-body">
              <TextVariantReader variant={shownVariant} />
            </div>
            <div className="video-text-viewer-actions">
              <CopyVariantButton
                state={state}
                only={shownVariant}
                scope="team_video"
                size="md"
                label={t('creativeLibraryCopyText')}
                onCopied={copied}
              />
              <Button color="primary" variant="solid" onClick={() => setViewing(null)}>
                {t('creativeLibraryDone')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
