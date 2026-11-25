import { useId, useState } from 'react';
import type { LaunchCreative, LaunchCreativeKind } from '@video-compressor/shared';
import { Badge, Button, Tooltip } from '../../components/ui/index.js';
import {
  launchCreativeCountKey,
  launchEachProductKey,
  launchProductCountKey,
  useI18n
} from '../../i18n.js';
import { teamApi } from '../../api/team.js';
import { useThumbnailSession } from '../explorer/useThumbnailSession.js';
import { MaterialPreview } from '../preview/MaterialPreview.js';
import { LaunchCreativeThumbnail } from './LaunchCreativeList.js';

/** Thumbnails shown before «+K»; the rest open on a press. */
const SHOWN = 8;

/**
 * The creatives of a generated Launch, said once in words and shown as pictures (owner,
 * 2026-11-25: «Зображення: 10 × 10 · 11 × 10 · …» read as a riddle). The line says how many
 * creatives and how the products went to them; each thumbnail carries its name under it and
 * opens the preview, and a product count sits on a thumbnail only when the shares differ.
 */
export function LaunchResultCreatives({
  teamId,
  creatives,
  kind
}: {
  teamId?: string;
  creatives: readonly LaunchCreative[];
  kind: LaunchCreativeKind | null;
}) {
  const { t, language } = useI18n();
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const thumbnailSession = useThumbnailSession({
    teamId: teamId ?? '',
    client: teamApi,
    enabled: Boolean(teamId) && creatives.length > 0
  });
  const total = creatives.reduce((sum, creative) => sum + creative.copies, 0);
  const even = creatives.every(creative => creative.copies === creatives[0]?.copies);
  const summary = [
    t(launchCreativeCountKey(language, creatives.length), { count: creatives.length }),
    even && creatives[0]
      ? t(launchEachProductKey(language, creatives[0].copies), { count: creatives[0].copies })
      : t(launchProductCountKey(language, total), { count: total })
  ].join(' · ');
  const hidden = creatives.length - SHOWN;
  const shown = expanded || hidden <= 1 ? creatives : creatives.slice(0, SHOWN);
  const previewed = creatives.find(creative => creative.materialId === previewId);
  return (
    <section className="launch-result-creatives" aria-label={t('launchesCreatives')}>
      <p className="m-0 text-caption text-ink-muted">{summary}</p>
      <ul id={listId} className="launch-result-creatives-list">
        {shown.map(creative => (
          <li key={creative.materialId} className="launch-result-creative">
            <LaunchCreativeThumbnail
              thumbnailUrl={
                thumbnailSession
                  ? teamApi.thumbnailUrl(thumbnailSession, creative.materialId)
                  : null
              }
              kind={kind}
              disabled={!teamId}
              label={t('launchResultPreviewCreative', { name: creative.alias })}
              onPreview={() => setPreviewId(creative.materialId)}
            />
            {!even && (
              <Badge
                size="xs"
                className="launch-result-creative-count"
                aria-label={t(launchProductCountKey(language, creative.copies), {
                  count: creative.copies
                })}
              >
                {creative.copies}
              </Badge>
            )}
            <Tooltip label={creative.alias} asChild>
              <span tabIndex={0} className="launch-result-creative-name text-caption">
                {creative.alias}
              </span>
            </Tooltip>
          </li>
        ))}
        {hidden > 1 && (
          <li className="launch-result-creatives-more">
            <Button
              variant="ghost"
              size="sm"
              className="launch-result-creatives-toggle"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded(value => !value)}
            >
              {expanded ? t('launchResultCreativesLess') : `+${hidden}`}
            </Button>
          </li>
        )}
      </ul>
      {previewed && teamId && (
        <MaterialPreview
          key={`${teamId}:${previewed.materialId}`}
          teamId={teamId}
          material={{ id: previewed.materialId, name: previewed.alias, category: kind }}
          onClose={() => setPreviewId(null)}
        />
      )}
    </section>
  );
}
