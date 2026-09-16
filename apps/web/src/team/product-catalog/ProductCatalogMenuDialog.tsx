import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Copy, ExternalLink, MoreHorizontal, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { TeamFileOperationResult } from '@video-compressor/shared';
import type { ProductCatalogSummary } from '../../api/team';
import { teamApi } from '../../api/team';
import { Modal } from '../../components/Modal';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { Button, DropdownMenu, IconButton } from '../../components/ui/index';
import { useToasts } from '../../components/toast';
import { useI18n, type TranslationKey } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';
import {
  CreateProductCatalogDialog,
  type CreateProductCatalogClient
} from './CreateProductCatalogDialog';

export interface VideoProductCatalogClient extends CreateProductCatalogClient {
  listProductCatalogs: (teamId: string, videoId: string) => Promise<ProductCatalogSummary[]>;
  trashMaterial: (input: {
    teamId: string;
    materialId: string;
    idempotencyKey: string;
  }) => Promise<TeamFileOperationResult>;
}

const defaultClient: VideoProductCatalogClient = teamApi;

type View =
  | { kind: 'loading' }
  | { kind: 'list' }
  | { kind: 'create'; replaces: ProductCatalogSummary | null };

/**
 * `https://www.offer.example/path?sub=2` → `offer.example/path?sub=2`. Two variations are usually
 * the same offer with a different sub-id, so the host alone read the same on every row; the rest
 * of the link is what tells them apart, cut with an ellipsis where it runs long.
 */
function shortLink(link: string): string {
  return link.replace(/^https?:\/\/(www\.)?/iu, '');
}

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
  onClose,
  onChanged
}: {
  teamId: string;
  video: { id: string; name: string };
  client?: VideoProductCatalogClient;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { can } = useTeam();
  const titleId = useId();
  const [catalogs, setCatalogs] = useState<ProductCatalogSummary[]>([]);
  const [view, setView] = useState<View>({ kind: 'loading' });

  const load = useCallback(async () => {
    const found = await client.listProductCatalogs(teamId, video.id).catch(() => []);
    setCatalogs(found);
    return found;
  }, [client, teamId, video.id]);

  useEffect(() => {
    let active = true;
    void load().then(found => {
      if (active) setView(found.length > 0 ? { kind: 'list' } : { kind: 'create', replaces: null });
    });
    return () => {
      active = false;
    };
  }, [load]);

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

  if (view.kind === 'loading') return null;

  if (view.kind === 'create') {
    const backToList = catalogs.length > 0;
    return (
      <CreateProductCatalogDialog
        teamId={teamId}
        video={video}
        replaces={view.replaces}
        variation={catalogs.length > 0}
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
  return (
    <Modal labelledBy={titleId} onClose={onClose} closeLabel={t('productCatalogDone')} size="md">
      <div className="team-dialog-form product-catalog-dialog">
        <h2 id={titleId}>{t('productCatalogListTitle')}</h2>
        <p className="product-catalog-dialog-name">{video.name}</p>
        <ul className="product-catalog-list">
          {catalogs.map(catalog => (
            <CatalogRow
              key={catalog.id}
              catalog={catalog}
              mayChange={mayMake}
              onCopyName={() => void copy(catalog.name, 'productCatalogNameCopied')}
              onCopyLink={() => void copy(catalog.sheetUrl, 'productCatalogLinkCopied')}
              onRecreate={() => setView({ kind: 'create', replaces: catalog })}
              onRemove={() => void remove(catalog)}
            />
          ))}
        </ul>
        <p className="field-hint">{t('productCatalogListHint')}</p>
        <div className="team-dialog-actions">
          {mayMake && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setView({ kind: 'create', replaces: null })}
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
    </Modal>
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
