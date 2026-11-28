import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type {
  SpaceMutationAction,
  SpaceStorageCategory,
  SpaceStorageItem,
  SpaceStorageItemSort,
  SpaceStorageItemsPage
} from '@video-compressor/shared';
import { spaceStorageApi } from '../../api/space-storage';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useOptionalToasts } from '../../components/toast';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  SearchField,
  SegmentedControl
} from '../../components/ui/index';
import { teamErrorMessageFor } from '../errors';
import { STORAGE_CATEGORY_LABEL, useStorageWords } from './useSpaceStorage';

/** What the list reads and changes; the tests hand in a fake. */
export interface StorageItemsClient {
  storageItems: (typeof spaceStorageApi)['storageItems'];
  mutate(input: {
    teamId: string;
    action: Extract<SpaceMutationAction, 'trash'>;
    materialIds: string[];
  }): Promise<unknown>;
  emptyTrash(teamId: string, materialIds?: readonly string[]): Promise<unknown>;
}

/** Where a thing of the list lives, for the screen that opens it. */
export interface StorageItemTarget {
  kind: SpaceStorageItem['kind'];
  id: string;
  parentFolderId: string | null;
  trashed: boolean;
}

/** The first look: the ten biggest (US9.2). */
export const STORAGE_TOP = 10;
const PAGE = 50;
const SEARCH_SETTLE_MS = 250;

/**
 * 057 T057: one category's things (US9.2, US9.3). It opens on the ten biggest; «Весь список»
 * adds the search and the order by size, date or author, a page at a time. A file opens where it
 * is and goes to the trash from here (from the trash: for good); a catalog opens on its three
 * numbers — what it takes, what is shared and stays, what deleting it frees. Re-read whenever the
 * space's usage moves (`revision`), so a delete in another window shows here too.
 *
 * 057 T124: everything a person can free is freed from here (US9.2, US10). A catalog is deleted
 * the way the catalog manager deletes it in an R2 space — to the trash, its videos at once — with
 * the numbers of what that frees and what stays shared; a catalog in the trash goes for good; the
 * trash itself is emptied with one confirmation. `onChanged` redraws the scale at once, without
 * waiting for the `usage` signal. A task's attachment and the shared picture library only open.
 */
export function StorageItemsList({
  teamId,
  category,
  revision,
  client = spaceStorageApi,
  onOpen,
  canDelete = false,
  categoryBytes,
  onChanged
}: {
  teamId: string;
  category: SpaceStorageCategory;
  revision: number;
  client?: StorageItemsClient;
  onOpen?: (item: StorageItemTarget) => void;
  canDelete?: boolean;
  /** What the category holds on the scale, for «Очистити кошик». */
  categoryBytes?: bigint;
  /** After a delete: the scale reads its numbers again. */
  onChanged?: () => void;
}) {
  const words = useStorageWords();
  const { t, language } = words;
  const toasts = useOptionalToasts();
  const titleId = useId();
  const [full, setFull] = useState(false);
  const [sort, setSort] = useState<SpaceStorageItemSort>('size');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<SpaceStorageItemsPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [asked, setAsked] = useState(0);
  const [confirming, setConfirming] = useState<SpaceStorageItem | 'trash' | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), SEARCH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const seq = ++latest.current;
    setFailed(false);
    void client
      .storageItems({
        teamId,
        category,
        sort: full ? sort : 'size',
        ...(full && query ? { search: query } : {}),
        limit: full ? PAGE : STORAGE_TOP
      })
      .then(
        value => {
          if (seq === latest.current) setPage(value);
        },
        () => {
          if (seq === latest.current) setFailed(true);
        }
      );
  }, [asked, category, client, full, query, revision, sort, teamId]);

  const more = async () => {
    if (!page?.nextCursor) return;
    const seq = latest.current;
    setLoadingMore(true);
    try {
      const next = await client.storageItems({
        teamId,
        category,
        sort,
        ...(query ? { search: query } : {}),
        cursor: page.nextCursor,
        limit: PAGE
      });
      if (seq === latest.current)
        setPage(current =>
          current ? { ...next, items: [...current.items, ...next.items] } : next
        );
    } catch (cause) {
      toasts?.push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setLoadingMore(false);
    }
  };

  const remove = async (item: SpaceStorageItem) => {
    if (!item.id) return;
    setBusy(true);
    try {
      if (item.trashed) await client.emptyTrash(teamId, [item.id]);
      else await client.mutate({ teamId, action: 'trash', materialIds: [item.id] });
      toasts?.push({ tone: 'success', text: t('spaceStorageDeleted', { name: item.name ?? '' }) });
      setConfirming(null);
      setAsked(value => value + 1);
      onChanged?.();
    } catch (cause) {
      toasts?.push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setBusy(false);
    }
  };

  const emptyTrash = async () => {
    setBusy(true);
    try {
      await client.emptyTrash(teamId);
      toasts?.push({ tone: 'success', text: t('spaceStorageTrashEmptied') });
      setConfirming(null);
      setAsked(value => value + 1);
      onChanged?.();
    } catch (cause) {
      toasts?.push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setBusy(false);
    }
  };

  const date = (at: string | null) =>
    at ? new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(new Date(at)) : null;
  const deletable = (item: SpaceStorageItem) =>
    canDelete &&
    item.id !== null &&
    (item.kind === 'catalog' || (item.kind === 'file' && category !== 'attachments'));
  const deleteLabel = (item: SpaceStorageItem) =>
    item.trashed
      ? t('spaceStorageDeleteForever')
      : item.kind === 'catalog'
        ? t('spaceStorageDeleteCatalog')
        : t('spaceStorageDelete');
  const confirmText = (item: SpaceStorageItem) => {
    const name = item.name ?? '';
    const size = words.bytes(item.freedBytes);
    const shared = words.bytes(item.sharedBytes);
    if (item.kind === 'catalog')
      return item.trashed
        ? {
            title: t('spaceStorageDeleteForeverTitle', { name }),
            body: t('spaceStorageDeleteCatalogForeverBody', { size, shared })
          }
        : {
            title: t('spaceStorageDeleteCatalogTitle', { name }),
            body: t('spaceStorageDeleteCatalogBody', { size, shared })
          };
    return item.trashed
      ? {
          title: t('spaceStorageDeleteForeverTitle', { name }),
          body: t('spaceStorageDeleteForeverBody', { size })
        }
      : {
          title: t('spaceStorageDeleteTitle', { name }),
          body: t('spaceStorageDeleteBody', { size })
        };
  };
  const canEmptyTrash = canDelete && category === 'trash' && !!page && page.total > 0;

  return (
    <section className="space-storage-list" aria-labelledby={titleId}>
      <div className="space-storage-list-heading">
        <h3 id={titleId}>
          {full
            ? t(STORAGE_CATEGORY_LABEL[category])
            : t('spaceStorageTop', { category: t(STORAGE_CATEGORY_LABEL[category]) })}
        </h3>
        {canEmptyTrash && (
          <Button size="xs" variant="outline" color="error" onClick={() => setConfirming('trash')}>
            {t('spaceStorageEmptyTrash')}
          </Button>
        )}
        {full && (
          <div className="space-storage-list-tools">
            <SearchField
              size="sm"
              value={search}
              onChange={setSearch}
              placeholder={t('spaceStorageSearch')}
              aria-label={t('spaceStorageSearch')}
              clearLabel={t('spaceStorageSearchClear')}
            />
            <SegmentedControl<SpaceStorageItemSort>
              size="sm"
              label={t('spaceStorageSortLabel')}
              value={sort}
              onChange={setSort}
              options={[
                { value: 'size', label: t('spaceStorageSortSize') },
                { value: 'date', label: t('spaceStorageSortDate') },
                { value: 'author', label: t('spaceStorageSortAuthor') }
              ]}
            />
          </div>
        )}
      </div>

      {failed && !page ? (
        <ErrorState
          message={t('spaceStorageLoadFailed')}
          onRetry={() => setAsked(value => value + 1)}
          retryLabel={t('tryAgain')}
        />
      ) : !page ? (
        <LoadingState shape="row" count={3} label={t(STORAGE_CATEGORY_LABEL[category])} />
      ) : page.items.length === 0 ? (
        <EmptyState
          title={query ? t('spaceStorageNoMatch') : t('spaceStorageEmpty')}
          titleAs="strong"
        />
      ) : (
        <ul className="space-storage-rows" data-testid="space-storage-rows">
          {page.items.map(item => {
            const key = item.id ?? `library:${category}`;
            const name = item.kind === 'library' ? t('spaceStorageLibrary') : (item.name ?? '—');
            const meta = [
              item.kind === 'library' ? t('spaceStorageLibraryNote') : (item.authorName ?? null),
              date(item.at),
              item.kind === 'file' && item.sharedBytes > 0n ? t('spaceStorageShared') : null
            ].filter(Boolean);
            const expanded = open === key;
            return (
              <li key={key} className="space-storage-row" data-kind={item.kind}>
                <div className="space-storage-row-title">
                  {item.kind === 'catalog' ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      color="neutral"
                      aria-expanded={expanded}
                      leading={
                        expanded ? (
                          <ChevronDown size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                        ) : (
                          <ChevronRight size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                        )
                      }
                      onClick={() => setOpen(expanded ? null : key)}
                    >
                      {name}
                    </Button>
                  ) : (
                    <strong title={name}>{name}</strong>
                  )}
                  {meta.length > 0 && <span>{meta.join(' · ')}</span>}
                  {item.kind === 'catalog' && expanded && (
                    <dl className="space-storage-breakdown" data-testid="catalog-storage-breakdown">
                      <div>
                        <dt>{t('spaceStorageCatalogTotal')}</dt>
                        <dd>{words.bytes(item.bytes)}</dd>
                      </div>
                      <div>
                        <dt>{t('spaceStorageCatalogShared')}</dt>
                        <dd>{words.bytes(item.sharedBytes)}</dd>
                      </div>
                      <div>
                        <dt>{t('spaceStorageCatalogFreed')}</dt>
                        <dd>{words.bytes(item.freedBytes)}</dd>
                      </div>
                    </dl>
                  )}
                </div>
                <div className="space-storage-row-size">
                  <strong>{words.bytes(item.bytes)}</strong>
                  {item.kind !== 'file' && item.freedBytes < item.bytes && (
                    <span>{t('spaceStorageFrees', { size: words.bytes(item.freedBytes) })}</span>
                  )}
                </div>
                <div className="space-storage-row-actions">
                  {onOpen && item.id && (
                    <Button
                      size="xs"
                      variant="outline"
                      color="neutral"
                      onClick={() =>
                        onOpen({
                          kind: item.kind,
                          id: item.id!,
                          parentFolderId: item.parentFolderId,
                          trashed: item.trashed
                        })
                      }
                    >
                      {t('spaceStorageOpen')}
                    </Button>
                  )}
                  {deletable(item) && (
                    <Button
                      size="xs"
                      variant="ghost"
                      color="error"
                      onClick={() => setConfirming(item)}
                    >
                      {deleteLabel(item)}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {page && !full && page.total > page.items.length && (
        <Button size="sm" variant="ghost" color="neutral" onClick={() => setFull(true)}>
          {t('spaceStorageAll', { count: page.total })}
        </Button>
      )}
      {page && full && page.nextCursor && (
        <Button
          size="sm"
          variant="outline"
          color="neutral"
          loading={loadingMore}
          onClick={() => void more()}
        >
          {t('spaceStorageMore')}
        </Button>
      )}

      {confirming === 'trash' ? (
        <ConfirmDialog
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void emptyTrash()}
          title={t('spaceStorageEmptyTrashTitle')}
          body={t('spaceStorageEmptyTrashBody', { size: words.bytes(categoryBytes ?? 0n) })}
          confirmLabel={t('spaceStorageEmptyTrash')}
          cancelLabel={t('cancel')}
        />
      ) : confirming ? (
        <ConfirmDialog
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void remove(confirming)}
          {...confirmText(confirming)}
          confirmLabel={deleteLabel(confirming)}
          cancelLabel={t('cancel')}
        />
      ) : null}
    </section>
  );
}
