import type { ReactNode } from 'react';
import { ClipboardList, FileText, FolderOpen } from 'lucide-react';
import type { TeamMaterialTagColor } from '@video-compressor/shared';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n, type TranslationKey } from '../../i18n';
import { formatSize } from '../../format';
import { TagDot } from '../explorer/TagDot';
import type { MaterialCompanions } from './actions';

/**
 * One file, one card, wherever you meet it (024, US5).
 *
 * A file looked like a different object on every screen. The explorer's detail
 * pane showed a preview, a name, a kind, a size and a modified date. A search
 * result showed a path and a set of tags and no preview at all. A task
 * attachment showed a thumbnail and six icons. The updater's row showed a
 * folder name and a product count. Four descriptions of the same thing, none
 * of them a superset of any other, so "is this the right file?" was answered
 * differently depending on how you had arrived.
 *
 * This is the description. The preview is supplied by the host, because how a
 * thumbnail is fetched genuinely differs — the explorer holds a session and a
 * set of render pointers, a task holds its own preview client — but everything
 * a reader is being asked to recognise the file *by* is here, in one order.
 */

export interface MaterialDetailFacts {
  /** What the product calls this kind of file. */
  kindLabel: string;
  sizeBytes?: number | null;
  modifiedAt?: string | null;
  /** Where it lives, as a name a person would recognise. */
  folderName?: string | null;
}

export function MaterialDetail({
  name,
  facts,
  preview,
  notes,
  note,
  companions,
  tag,
  actions,
  className
}: {
  name: string;
  facts: MaterialDetailFacts;
  /** The thumbnail, the kind glyph, or whatever the host can render. */
  preview: ReactNode;
  /** Why the preview is not what it should be, in the host's own words. */
  notes?: ReactNode;
  /** The note a person left on the file (024), read and edited in place. */
  note?: ReactNode;
  companions?: MaterialCompanions;
  /** The colour tag, where the reader is allowed to set one. */
  tag?: {
    color: TeamMaterialTagColor | null;
    canTag: boolean;
    onChange: (color: TeamMaterialTagColor | null) => void;
  };
  /** The material's action surface, from the one registry. */
  actions?: ReactNode;
  className?: string;
}) {
  const { t, language } = useI18n();
  const rows: Array<[TranslationKey, ReactNode]> = [];
  rows.push(['teamExplorerPaneKind', facts.kindLabel]);
  if (typeof facts.sizeBytes === 'number') {
    rows.push(['teamExplorerPaneSize', formatSize(facts.sizeBytes)]);
  }
  if (facts.modifiedAt) {
    rows.push([
      'teamExplorerPaneModified',
      // A day and a minute, in the reader's language — not the machine's
      // locale and not the second (024, benchmarked on Drive's details panel).
      new Date(facts.modifiedAt).toLocaleString(language === 'uk' ? 'uk-UA' : 'en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short'
      })
    ]);
  }
  if (facts.folderName) rows.push(['teamExplorerPaneFolder', facts.folderName]);

  const catalog = companions?.productCatalog;
  const transcript = companions?.transcript;

  return (
    <div className={['team-material-detail', className].filter(Boolean).join(' ')}>
      <div className="team-material-detail-visual">{preview}</div>
      <h3 className="team-material-detail-name" title={name}>
        {tag && (
          <TagDot
            color={tag.color}
            name={name}
            canTag={tag.canTag}
            onChange={color => tag.onChange(color)}
          />
        )}
        {name}
      </h3>
      <dl className="team-material-detail-facts">
        {rows.map(([key, value]) => (
          <div key={key}>
            <dt>{t(key)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {note}
      {notes}
      {/*
       * What lives beside it. Said here rather than left to be discovered:
       * a video whose catalog already exists should not be offering to make a
       * second one, and the text somebody paid to have made should not be
       * three screens away from the video it belongs to.
       */}
      {(catalog || transcript) && (
        <ul className="team-material-detail-companions">
          {catalog && (
            <li>
              <ClipboardList size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {(catalog.count ?? 1) > 1
                ? t('materialCompanionCatalogVariations', { count: catalog.count ?? 1 })
                : catalog.productCount === null
                  ? t('materialCompanionCatalog')
                  : t('materialCompanionCatalogCount', { count: catalog.productCount })}
            </li>
          )}
          {transcript && (
            <li>
              <FileText size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {t(transcript.ready ? 'materialCompanionText' : 'materialCompanionTextPending')}
            </li>
          )}
          {companions?.restitchedPreparedFor && (
            <li>
              <FolderOpen size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {t('materialCompanionRestitched')}
            </li>
          )}
        </ul>
      )}
      {actions}
    </div>
  );
}
