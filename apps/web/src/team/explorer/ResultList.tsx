import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  materialKindOf,
  type CatalogMatchField,
  type CatalogMaterialItem,
  type CatalogSearchResponse,
  type TeamMaterialRowKind,
  type TeamMaterialTagColor
} from '@video-compressor/shared';
import {
  Button,
  Checkbox,
  ErrorState,
  FadeImage,
  LoadingState,
  Table,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow
} from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import { displayedSize, formatDate } from '../../format';
import { Highlighted } from '../search/highlight';
import { KIND_LABEL } from './rowKinds';
import { KindIcon } from './KindIcon';
import { TagDot } from './TagDot';
import { suppressShiftTextSelection } from './useSelectionGestures';
import type { ResultSelection } from './useResultSelection';

/** Said under a result found by something other than its name (search rework, 2026-10). */
const MATCHED_IN_COPY: Partial<Record<CatalogMatchField, TranslationKey>> = {
  transcript: 'searchMatchedInTranscript',
  note: 'searchMatchedInNote',
  tags: 'searchMatchedInTags',
  meta: 'searchMatchedInMeta'
};

/** Matches the page size `useCatalogSearch` requests. */
const PAGE_SIZE = 50;

/** The explorer's kind for a result — the same rule the folder list's rows are given by. */
export function resultKind(material: CatalogMaterialItem): TeamMaterialRowKind {
  return materialKindOf({
    storedKind: material.kind,
    mimeType: material.mimeType,
    category: material.category
  });
}

/** Marks the results list, so the toolbar field can hand the keyboard to it. */
export const RESULT_LIST_ATTRIBUTE = 'data-explorer-results';

/**
 * The search's results as the folder's own list (070, US3): the same table, the same columns,
 * the same press — one selects, two open, ⌘ and Shift check — and the same arrows and Enter. A
 * result says where it lives under its name, and what matched when it was not the name.
 *
 * It used to be a column of cards, each with its metadata chips and up to four icons, under a
 * second search field: another screen inside the explorer, where nothing could be selected and
 * the details pane went away.
 */
export function ResultList({
  result,
  loading,
  error,
  empty,
  query,
  page,
  onPageChange,
  selection,
  onOpen,
  onRetry,
  pathFor,
  thumbnailFor,
  tagging,
  actionsFor
}: {
  result: CatalogSearchResponse | null;
  loading: boolean;
  error: boolean;
  empty: ReactNode;
  /** The words the results answer, marked in each name and snippet. */
  query: string;
  page: number;
  onPageChange: (page: number) => void;
  selection: ResultSelection;
  /** A second press, or Enter: a file opens, a folder is gone into. */
  onOpen: (material: CatalogMaterialItem) => void;
  onRetry: () => void;
  pathFor: (material: CatalogMaterialItem) => string | null;
  thumbnailFor: (material: CatalogMaterialItem) => string | null;
  tagging?: {
    canTag: true;
    onSetTag: (material: CatalogMaterialItem, color: TeamMaterialTagColor | null) => void;
  };
  /** The row's "…", from the one registry. */
  actionsFor: (material: CatalogMaterialItem) => ReactNode;
}) {
  const { t, language } = useI18n();
  const listRef = useRef<HTMLDivElement | null>(null);
  /* A tag set on a result is held here until the next answer carries it, or the dot would
     snap back to its old colour on the next render. */
  const [justTagged, setJustTagged] = useState<Record<string, TeamMaterialTagColor | null>>({});
  /* A picture that did not come is the kind's glyph, as on a folder row — not an empty square. */
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const items = result?.items ?? [];
  const { focusedId, checked } = selection;

  useEffect(() => {
    if (!focusedId) return;
    const node = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-material-id]') ?? []
    ).find(element => element.dataset.materialId === focusedId);
    // Guarded: jsdom has no scrolling.
    if (typeof node?.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
  }, [focusedId]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('input, textarea, [role="menu"], [role="dialog"]')) return;
    const index = items.findIndex(item => item.id === focusedId);
    const focused = index >= 0 ? items[index] : null;
    switch (event.key) {
      case 'ArrowDown':
        selection.focus(items[Math.min(items.length - 1, index < 0 ? 0 : index + 1)]!.id);
        break;
      case 'ArrowUp':
        selection.focus(items[Math.max(0, index - 1)]!.id);
        break;
      case 'Home':
        selection.focus(items[0]!.id);
        break;
      case 'End':
        selection.focus(items[items.length - 1]!.id);
        break;
      case 'Enter':
        if (!focused) return;
        onOpen(focused);
        break;
      case ' ':
        if (!focused) return;
        selection.toggle(focused);
        break;
      case 'Escape':
        if (checked.size === 0 && !focusedId) return;
        selection.clear();
        selection.focus(null);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  if (error) {
    return (
      <ErrorState
        message={t('teamCatalogLoadFailed')}
        onRetry={onRetry}
        retryLabel={t('tryAgain')}
      />
    );
  }
  if (loading && !result) {
    return <LoadingState label={t('teamCatalogLoadingResults')} shape="row" count={4} />;
  }
  if (items.length === 0) return <>{empty}</>;
  const pageCount = Math.max(1, Math.ceil((result?.total ?? 0) / PAGE_SIZE));

  return (
    <section className="team-explorer-content" aria-labelledby="team-explorer-results-title">
      <h2 id="team-explorer-results-title" className="visually-hidden">
        {t('teamExplorerResultsTitle')}
      </h2>
      <div
        ref={listRef}
        className="team-explorer-content-keys"
        tabIndex={0}
        role="presentation"
        {...{ [RESULT_LIST_ATTRIBUTE]: '' }}
        data-rows={items.length}
        data-selected={focusedId ?? ''}
        aria-busy={loading || undefined}
        onKeyDown={onKeyDown}
        /* Handed the keyboard from the search box (Down, Enter): the first result is where the
           arrows start, and the pane shows it at once. */
        onFocus={event => {
          if (event.target === event.currentTarget && !focusedId && items[0]) {
            selection.focus(items[0].id);
          }
        }}
      >
        <Table
          stickyHeader
          size="sm"
          className="team-explorer-rows team-explorer-results"
          aria-labelledby="team-explorer-results-title"
        >
          <TableHeader>
            <TableHeaderCell className="team-explorer-row-check" />
            <TableHeaderCell className="team-explorer-row-name">
              {t('teamExplorerSortName')}
            </TableHeaderCell>
            <TableHeaderCell className="team-explorer-row-kind">
              {t('teamExplorerPaneKind')}
            </TableHeaderCell>
            <TableHeaderCell className="team-explorer-row-date">
              {t('teamExplorerSortModified')}
            </TableHeaderCell>
            <TableHeaderCell className="team-explorer-row-meta">
              {t('teamExplorerPaneSize')}
            </TableHeaderCell>
            <TableHeaderCell className="team-explorer-row-actions">
              <span className="visually-hidden">{t('teamAccountColumnActions')}</span>
            </TableHeaderCell>
          </TableHeader>
          {items.map(material => {
            const kind = resultKind(material);
            const matchedIn = material.matchedIn ? MATCHED_IN_COPY[material.matchedIn] : undefined;
            const snippet =
              material.snippet &&
              (material.matchedIn === 'transcript' || material.matchedIn === 'note')
                ? material.snippet
                : null;
            const picture = broken.has(material.id) ? null : thumbnailFor(material);
            const isChecked = checked.has(material.id);
            const size =
              material.kind === 'folder' || material.sizeBytes === null
                ? null
                : displayedSize(material.sizeBytes, material.mimeType);
            return (
              <TableRow
                key={material.id}
                className={`team-explorer-row is-${kind}${isChecked ? ' is-checked' : ''}`}
                data-material-id={material.id}
                selected={focusedId === material.id}
                interactive
                onMouseDown={suppressShiftTextSelection}
                onClick={event => selection.press(material, event)}
                onDoubleClick={() => onOpen(material)}
              >
                <TableCell
                  className="team-explorer-row-check"
                  onClick={event => event.stopPropagation()}
                >
                  <Checkbox
                    size="sm"
                    className="team-explorer-result-check"
                    aria-label={t('teamExplorerSelectNamed', { name: material.name })}
                    checked={isChecked}
                    onChange={() => selection.toggle(material)}
                  />
                </TableCell>
                <TableCell className="team-explorer-row-name team-explorer-result-name">
                  <span className="team-explorer-result-glyph" aria-hidden="true">
                    {picture ? (
                      <FadeImage
                        src={picture}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        onError={() => setBroken(current => new Set(current).add(material.id))}
                      />
                    ) : (
                      <KindIcon kind={kind} />
                    )}
                  </span>
                  <span className="team-explorer-result-text">
                    <span className="team-explorer-result-title">
                      <span className="team-explorer-result-label" title={material.name}>
                        <Highlighted text={material.name} query={query} />
                      </span>
                      <TagDot
                        color={
                          material.id in justTagged
                            ? justTagged[material.id]!
                            : (material.tagColor ?? null)
                        }
                        name={material.name}
                        canTag={Boolean(tagging)}
                        onChange={color => {
                          setJustTagged(current => ({ ...current, [material.id]: color }));
                          tagging?.onSetTag(material, color);
                        }}
                      />
                    </span>
                    <span className="team-explorer-result-where">
                      {matchedIn ? (
                        <>
                          <span className="team-explorer-result-matched">{t(matchedIn)}</span>
                          {snippet && <Highlighted text={snippet} query={query} />}
                        </>
                      ) : (
                        pathFor(material)
                      )}
                    </span>
                  </span>
                </TableCell>
                <TableCell className="team-explorer-row-kind">{t(KIND_LABEL[kind])}</TableCell>
                <TableCell className="team-explorer-row-date">
                  {formatDate(material.modifiedAt, language)}
                </TableCell>
                <TableCell className="team-explorer-row-meta">{size ?? ''}</TableCell>
                <TableCell
                  className="team-explorer-row-actions"
                  onClick={event => event.stopPropagation()}
                >
                  {actionsFor(material)}
                </TableCell>
              </TableRow>
            );
          })}
        </Table>
      </div>
      {/* Past the first fifty, the next page — results were once capped there with nothing to
          press (finding F5). */}
      {pageCount > 1 && (
        <nav className="team-catalog-pager" aria-label={t('teamCatalogPagerLabel')}>
          <Button variant="ghost" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
            {t('teamCatalogPagerPrevious')}
          </Button>
          <span aria-live="polite">
            {t('teamCatalogPagerPosition', { page, total: pageCount })}
          </span>
          <Button
            variant="ghost"
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            {t('teamCatalogPagerNext')}
          </Button>
        </nav>
      )}
    </section>
  );
}
