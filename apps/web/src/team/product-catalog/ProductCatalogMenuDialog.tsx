import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Copy, ExternalLink, MoreHorizontal, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { TeamFileOperationResult } from '@video-compressor/shared';
import type { ProductCatalogSummary, UnfinishedCatalogCreation } from '../../api/team';
import { teamApi } from '../../api/team';
import { Modal } from '../../components/Modal';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { ConfirmDialog, SotyLoader } from '../../components/ui';
import { Button, DropdownMenu, IconButton } from '../../components/ui/index';
import { useToasts } from '../../components/toast';
import { useI18n, type TranslationKey } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { privateCacheActor } from '../private-cache-scope';
import { productCatalogNameFor } from '../materials/tail';
import type { RestitchDurationValue } from '../../components/ui/index';
import { useTeam } from '../TeamContext';
import { useCatalogVideoR2Team } from './useCatalogVideoR2Team';
import type { CatalogVideoR2Client } from '../../api/team-catalog-video-r2';
import {
  CreateProductCatalogDialog,
  pendingCatalogCreationStorageKey,
  rememberPendingCatalogCreation,
  type CreateProductCatalogClient
} from './CreateProductCatalogDialog';

export interface VideoProductCatalogClient extends CreateProductCatalogClient {
  listProductCatalogs: (teamId: string, videoId: string) => Promise<ProductCatalogSummary[]>;
  trashMaterial: (input: {
    teamId: string;
    materialId: string;
    idempotencyKey: string;
  }) => Promise<TeamFileOperationResult>;
  /** 1.4.3: the person's own unfinished creations for the video, from any browser. */
  listUnfinishedProductCatalogCreations?: (
    teamId: string,
    videoId: string
  ) => Promise<UnfinishedCatalogCreation[]>;
}

const defaultClient: VideoProductCatalogClient = teamApi;

type View =
  | { kind: 'loading' }
  | { kind: 'list' }
  /**
   * `fromList`: the form was opened from the list, so closing it goes back there. Decided when it
   * opens — read from the catalogs after a create, the first catalog made the list non-empty, and
   * "Done" on its result opened a second window instead of closing (024).
   */
  | { kind: 'create'; replaces: ProductCatalogSummary | null; fromList: boolean };

/**
 * `https://www.offer.example/path?sub=2` → `offer.example/path?sub=2`. Two variations are usually
 * the same offer with a different sub-id, so the host alone read the same on every row; the rest
 * of the link is what tells them apart, cut with an ellipsis where it runs long.
 */
function shortLink(link: string): string {
  return link.replace(/^https?:\/\/(www\.)?/iu, '');
}

/**
 * Whether this browser started a catalog for the video that has not finished yet (1.4.3). Such a
 * creation is not a catalog the server lists, so without this the list showed only the finished
 * ones and a reopened creation looked lost.
 */
function hasRunningCreation(teamId: string, videoId: string): boolean {
  const actor = privateCacheActor();
  if (!actor) return false;
  try {
    const key = localStorage.getItem(pendingCatalogCreationStorageKey(actor, teamId, videoId));
    return Boolean(key && /^product-catalog:[0-9a-f-]{36}$/iu.test(key));
  } catch {
    return false;
  }
}

/** What an unfinished creation is doing, in the words its row shows. */
function creationStatus(creation: UnfinishedCatalogCreation): TranslationKey {
  if (creation.setState === 'cancel_requested') return 'productCatalogCreationCanceling';
  if (creation.agentSilent) return 'productCatalogCreationAgentSilent';
  if (creation.setState === 'unknown' || creation.unknownCount > 0)
    return 'productCatalogCreationAttention';
  if (
    creation.restitch &&
    creation.requestedCount !== null &&
    creation.registeredCount < creation.requestedCount
  )
    return creation.workingCount > 0
      ? 'productCatalogCreationStitching'
      : 'productCatalogCreationWaitingComputer';
  return 'productCatalogCreationAssembling';
}

/** A creation can be canceled while its videos are still being made. */
function creationCancelable(creation: UnfinishedCatalogCreation): boolean {
  return (
    creation.restitch &&
    creation.setState !== null &&
    !['cancel_requested', 'ready', 'canceled'].includes(creation.setState)
  );
}

function durationOf(creation: UnfinishedCatalogCreation): RestitchDurationValue | undefined {
  const value = creation.duration;
  return value && typeof value.finalDurationMode === 'string'
    ? (value as unknown as RestitchDurationValue)
    : undefined;
}

/**
 * Where the window opens: on the list when there is a catalog or a creation still running,
 * straight on the form when there is nothing to list.
 */
function openView(loaded: {
  found: ProductCatalogSummary[];
  open: UnfinishedCatalogCreation[] | null;
}): View {
  return loaded.found.length > 0 || (loaded.open?.length ?? 0) > 0
    ? { kind: 'list' }
    : { kind: 'create', replaces: null, fromList: false };
}

/** While a creation is unfinished its row re-reads the server this often. */
const UNFINISHED_REFRESH_MS = 15_000;

/**
 * A video's catalogs (022; variations in 024, US15).
 *
 * One video runs on several ad accounts, each with its own link, so it has several catalogs —
 * `IN 40_v1_catalog`, `IN 40_v2_catalog` — named the way the owner names them on Meta. They open
 * as one list where each row copies its name, copies its link and opens the sheet in one press;
 * re-creating and removing are in the row's menu, and a new variation is on the same screen.
 * Removing moves the sheet to the trash, where it can be restored as the same variation, so
 * trying a link costs nothing to take back.
 *
 * A video with no catalog opens straight on the form: there is nothing to list.
 */
export function ProductCatalogMenuDialog({
  teamId,
  video,
  client = defaultClient,
  videoR2Client,
  onClose,
  onChanged
}: {
  teamId: string;
  video: { id: string; name: string; parentFolderId?: string | null };
  client?: VideoProductCatalogClient;
  /** 050: where the R2 option of each catalog is read; the space's own API by default. */
  videoR2Client?: CatalogVideoR2Client;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { can } = useTeam();
  const titleId = useId();
  const [catalogs, setCatalogs] = useState<ProductCatalogSummary[]>([]);
  // null: the server could not say; the list then falls back to this browser's memory.
  const [unfinished, setUnfinished] = useState<UnfinishedCatalogCreation[] | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<UnfinishedCatalogCreation | null>(null);
  const cancelIds = useRef(new Map<string, string>());
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [loadError, setLoadError] = useState(false);
  // 050: a catalog with its video in R2 is deleted for good, so it asks first.
  const videoR2 = useCatalogVideoR2Team(teamId, videoR2Client);
  const [confirmRemove, setConfirmRemove] = useState<ProductCatalogSummary | null>(null);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const found = await Promise.race([
        client.listProductCatalogs(teamId, video.id),
        new Promise<ProductCatalogSummary[]>((_, reject) =>
          window.setTimeout(() => reject(new Error('CATALOG_LIST_TIMEOUT')), 8_000)
        )
      ]);
      setCatalogs(found);
      // A creation still running is shown beside the finished catalogs. Its list is a
      // convenience: when it fails, the catalogs still open.
      let open: UnfinishedCatalogCreation[] | null = null;
      if (client.listUnfinishedProductCatalogCreations && client.createProductCatalogVideo) {
        try {
          open = await client.listUnfinishedProductCatalogCreations(teamId, video.id);
        } catch {
          open = null;
        }
      }
      setUnfinished(open);
      return { found, open };
    } catch {
      setLoadError(true);
      return null;
    }
  }, [client, teamId, video.id]);

  useEffect(() => {
    let active = true;
    void load().then(loaded => {
      if (active && loaded) setView(openView(loaded));
    });
    return () => {
      active = false;
    };
  }, [load]);

  // An unfinished creation moves on its own; its row follows the server while the list is open.
  const watching = view.kind === 'list' && (unfinished?.length ?? 0) > 0;
  useEffect(() => {
    if (!watching) return;
    const timer = window.setInterval(() => void load(), UNFINISHED_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [watching, load]);

  const creationName = (creation: UnfinishedCatalogCreation) =>
    productCatalogNameFor(video.name, creation.variant);

  /** Reopen the creation dialog on a creation the server listed, with the person's inputs. */
  const showProgress = (creation: UnfinishedCatalogCreation) => {
    const actor = privateCacheActor();
    if (actor) {
      try {
        const duration = durationOf(creation);
        rememberPendingCatalogCreation(pendingCatalogCreationStorageKey(actor, teamId, video.id), {
          key: creation.idempotencyKey,
          link: creation.sourceLink ?? '',
          count: creation.productCount === null ? '' : String(creation.productCount),
          restitch: creation.restitch,
          copyVideoToR2: creation.copyVideoToR2,
          variationCount: String(creation.variationCount ?? 1),
          ...(duration ? { duration } : {}),
          name: creationName(creation)
        });
      } catch {
        push({ tone: 'error', text: t('catalogPublicationStorageError') });
        return;
      }
    }
    const replaces = creation.replacesMaterialId
      ? (catalogs.find(catalog => catalog.id === creation.replacesMaterialId) ?? null)
      : null;
    setView({ kind: 'create', replaces, fromList: true });
  };

  const cancelCreation = async (creation: UnfinishedCatalogCreation) => {
    const key = creation.idempotencyKey;
    // The same cancel request on a retry, so a lost answer cannot cancel twice.
    const requestId = cancelIds.current.get(key) ?? crypto.randomUUID();
    cancelIds.current.set(key, requestId);
    setUnfinished(current =>
      current
        ? current.map(item =>
            item.idempotencyKey === key ? { ...item, setState: 'cancel_requested' } : item
          )
        : current
    );
    try {
      await (client.cancelProductCatalogVideo ?? teamApi.cancelProductCatalogVideo)(
        teamId,
        key,
        requestId
      );
      push({
        tone: 'success',
        text: t('productCatalogCreationCanceled', { name: creationName(creation) })
      });
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      void load();
    }
  };

  const copy = async (text: string, done: TranslationKey) => {
    try {
      await navigator.clipboard.writeText(text);
      push({ tone: 'success', text: t(done) });
    } catch {
      push({ tone: 'error', text: t('teamToastLinkCopyFailed') });
    }
  };

  const remove = async (catalog: ProductCatalogSummary) => {
    // Off the list at once; back on it only if the trash refused.
    setCatalogs(current => current.filter(item => item.id !== catalog.id));
    try {
      await client.trashMaterial({
        teamId,
        materialId: catalog.id,
        idempotencyKey: `catalog-remove:${crypto.randomUUID()}`
      });
      push({ tone: 'success', text: t('productCatalogRemoved', { name: catalog.name }) });
      onChanged?.();
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
      void load();
    }
  };

  if (view.kind === 'loading')
    return (
      <Modal labelledBy={titleId} onClose={onClose} closeLabel={t('productCatalogDone')} size="sm">
        <div className="team-dialog-form product-catalog-dialog" role="status" aria-live="polite">
          <h2 id={titleId}>{t('productCatalogListTitle')}</h2>
          {loadError ? (
            <>
              <p className="field-hint">{t('retry')}</p>
              <div className="team-dialog-actions">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void load().then(loaded => {
                      if (loaded) setView(openView(loaded));
                    })
                  }
                >
                  {t('teamOperationRetry')}
                </Button>
                <Button type="button" variant="primary" onClick={onClose}>
                  {t('productCatalogDone')}
                </Button>
              </div>
            </>
          ) : (
            <SotyLoader size={26} />
          )}
        </div>
      </Modal>
    );

  if (view.kind === 'create') {
    const backToList = view.fromList;
    return (
      <CreateProductCatalogDialog
        teamId={teamId}
        video={video}
        replaces={view.replaces}
        variation={view.fromList}
        initialCount={catalogs.at(-1)?.productCount}
        client={client}
        onClose={() => {
          if (!backToList) {
            onClose();
            return;
          }
          void load();
          setView({ kind: 'list' });
        }}
        onCreated={() => {
          onChanged?.();
          void load();
        }}
      />
    );
  }

  const mayMake = can('upload');
  // The server's list when it answered; this browser's memory only when it could not.
  const running =
    unfinished === null &&
    Boolean(client.createProductCatalogVideo) &&
    hasRunningCreation(teamId, video.id);
  return (
    <Modal labelledBy={titleId} onClose={onClose} closeLabel={t('productCatalogDone')} size="md">
      <div className="team-dialog-form product-catalog-dialog">
        <h2 id={titleId}>{t('productCatalogListTitle')}</h2>
        <p className="product-catalog-dialog-name">{video.name}</p>
        <ul className="product-catalog-list">
          {running && (
            <li className="product-catalog-row">
              <div className="product-catalog-row-text" role="status">
                <strong>{t('productCatalogCreationRunning')}</strong>
                <small>{t('productCatalogCreationRunningHint')}</small>
              </div>
              <div className="product-catalog-row-actions">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setView({ kind: 'create', replaces: null, fromList: true })}
                >
                  {t('productCatalogCreationShow')}
                </Button>
              </div>
            </li>
          )}
          {unfinished?.map(creation => (
            <UnfinishedCreationRow
              key={creation.idempotencyKey}
              creation={creation}
              name={creationName(creation)}
              mayCancel={mayMake && creationCancelable(creation)}
              onShow={() => showProgress(creation)}
              onCancel={() => setConfirmCancel(creation)}
            />
          ))}
          {catalogs.map(catalog => (
            <CatalogRow
              key={catalog.id}
              catalog={catalog}
              mayChange={mayMake}
              onCopyName={() => void copy(catalog.name, 'productCatalogNameCopied')}
              onCopyLink={() => void copy(catalog.sheetUrl, 'productCatalogLinkCopied')}
              onRecreate={() => setView({ kind: 'create', replaces: catalog, fromList: true })}
              onRemove={() =>
                videoR2.row(catalog.id).enabled ? setConfirmRemove(catalog) : void remove(catalog)
              }
            />
          ))}
        </ul>
        <p className="field-hint">{t('productCatalogListHint')}</p>
        <div className="team-dialog-actions">
          {mayMake && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setView({ kind: 'create', replaces: null, fromList: true })}
            >
              <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {t('productCatalogNewVariation')}
            </Button>
          )}
          <Button type="button" variant="primary" onClick={onClose}>
            {t('productCatalogDone')}
          </Button>
        </div>
      </div>
      {confirmCancel && (
        <ConfirmDialog
          nested
          title={t('productCatalogCreationCancelTitle')}
          body={t('productCatalogCreationCancelBody', { name: creationName(confirmCancel) })}
          confirmLabel={t('productCatalogCreationCancelConfirm')}
          cancelLabel={t('productCatalogCreationKeep')}
          onCancel={() => setConfirmCancel(null)}
          onConfirm={() => {
            const creation = confirmCancel;
            setConfirmCancel(null);
            void cancelCreation(creation);
          }}
        />
      )}
      {confirmRemove && (
        <ConfirmDialog
          nested
          title={t('catalogVideoR2DeleteTitle')}
          body={t('catalogVideoR2DeleteBody', { name: confirmRemove.name })}
          confirmLabel={t('catalogVideoR2DeleteConfirm')}
          cancelLabel={t('teamCancel')}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            const catalog = confirmRemove;
            setConfirmRemove(null);
            void remove(catalog);
          }}
        />
      )}
    </Modal>
  );
}

/** One of the person's creations for the video that has not finished. */
function UnfinishedCreationRow({
  creation,
  name,
  mayCancel,
  onShow,
  onCancel
}: {
  creation: UnfinishedCatalogCreation;
  name: string;
  mayCancel: boolean;
  onShow: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const progress =
    creation.restitch && creation.requestedCount
      ? t('catalogVideoCreationProgress', {
          ready: creation.registeredCount,
          total: creation.requestedCount
        })
      : null;
  return (
    <li className="product-catalog-row">
      <div className="product-catalog-row-text" role="status">
        <strong title={name}>{name}</strong>
        <small>
          {t(creationStatus(creation))}
          {progress ? ` · ${progress}` : ''}
        </small>
      </div>
      <div className="product-catalog-row-actions">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          aria-label={t('productCatalogCreationShowOf', { name })}
          onClick={onShow}
        >
          {t('productCatalogCreationShow')}
        </Button>
        {mayCancel && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={t('productCatalogCreationCancelOf', { name })}
            onClick={onCancel}
          >
            {t('productCatalogCreationCancel')}
          </Button>
        )}
      </div>
    </li>
  );
}

function CatalogRow({
  catalog,
  mayChange,
  onCopyName,
  onCopyLink,
  onRecreate,
  onRemove
}: {
  catalog: ProductCatalogSummary;
  mayChange: boolean;
  onCopyName: () => void;
  onCopyLink: () => void;
  onRecreate: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <li className="product-catalog-row">
      <div className="product-catalog-row-text">
        <strong title={catalog.name}>{catalog.name}</strong>
        <small>
          {t('productCatalogProducts', { count: catalog.productCount })} ·{' '}
          <span title={catalog.sourceLink}>{shortLink(catalog.sourceLink)}</span>
        </small>
      </div>
      <div className="product-catalog-row-actions">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={t('productCatalogCopyNameOf', { name: catalog.name })}
          onClick={onCopyName}
        >
          <Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {t('productCatalogCopyName')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={t('productCatalogCopyLinkOf', { name: catalog.name })}
          onClick={onCopyLink}
        >
          {t('productCatalogCopyLinkShort')}
        </Button>
        <a
          className="soty-button button-ghost product-catalog-row-open"
          href={catalog.sheetUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('productCatalogOpenOf', { name: catalog.name })}
          title={t('productCatalogOpen')}
        >
          <ExternalLink size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </a>
        {mayChange && (
          <>
            <IconButton
              title=""
              ref={trigger}
              size="sm"
              variant="ghost"
              label={t('productCatalogActionsFor', { name: catalog.name })}
              onClick={() => setMenuOpen(true)}
            >
              <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </IconButton>
            <DropdownMenu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              anchor={trigger}
              label={t('productCatalogActionsFor', { name: catalog.name })}
              items={[
                {
                  id: 'recreate',
                  label: t('productCatalogRecreate'),
                  icon: <RefreshCw size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
                  onSelect: onRecreate
                },
                {
                  id: 'remove',
                  label: t('productCatalogRemove'),
                  destructive: true,
                  icon: <Trash2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
                  onSelect: onRemove
                }
              ]}
            />
          </>
        )}
      </div>
    </li>
  );
}
