/**
 * One slot's pool of pictures, as the space's settings show it (030).
 *
 * The pictures of a space are not on anybody's computer: they are files and folders of the
 * connected Drive, chosen with the same pickers the tasks and the catalog use, and the server
 * says what each source is worth right now — how many pictures it gives, which were skipped
 * and why, whether it is still there at all. Nothing here uploads anything anywhere.
 */

import { useState } from 'react';
import { Folder, Image, X } from 'lucide-react';
import type {
  RestitchPoolSummary,
  RestitchSlot,
  RestitchSource,
  RestitchSourceInput
} from '@video-compressor/shared';
import type { TeamMaterialSummary } from '../../api/team';
import { Badge, Button, IconButton } from '../../components/ui/index';
import { ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { useI18n, type TranslationKey } from '../../i18n';
import { FolderPicker, type FolderPickerClient } from '../catalog/FolderPicker';
import {
  TaskAttachmentPicker,
  type TaskAttachmentPickerClient
} from '../tasks/TaskAttachmentPicker';

export type RestitchSourcePoolClient = Pick<TaskAttachmentPickerClient, 'listMaterials'> &
  Partial<Pick<TaskAttachmentPickerClient, 'searchCatalog'>>;

const AVAILABILITY_KEYS: Record<RestitchSource['availability'], TranslationKey | null> = {
  available: null,
  trashed: 'teamRestitchSourceTrashed',
  missing: 'teamRestitchSourceMissing',
  out_of_root: 'teamRestitchSourceOutOfRoot',
  unsupported: 'teamRestitchSourceUnsupported',
  pending: 'teamRestitchSourcePending',
  disconnected: 'teamRestitchSourceDisconnected'
};

/** What the server stores back when a source is kept: its reference, never its bytes. */
function inputOf(source: RestitchSource): RestitchSourceInput {
  if (source.materialId) return { materialId: source.materialId };
  return { driveFileId: source.driveFileId ?? '', kind: 'folder' };
}

export function RestitchSourcePool({
  teamId,
  slot,
  pool,
  editable,
  client,
  onChange
}: {
  teamId: string;
  slot: RestitchSlot;
  pool: RestitchPoolSummary;
  /** False for a member reading the owner's pools, and while a save is running. */
  editable: boolean;
  /** Absent when the space's catalog cannot be browsed from here; the pickers are then hidden. */
  client?: RestitchSourcePoolClient;
  onChange: (slot: RestitchSlot, items: RestitchSourceInput[]) => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const [pickingFolder, setPickingFolder] = useState(false);
  const current = pool.sources.map(inputOf);
  const unavailable = pool.sources.filter(source => source.availability !== 'available').length;
  const skipped = pool.sources.reduce(
    (sum, source) => sum + source.skipped.format + source.skipped.size + source.skipped.animated,
    0
  );
  // Two sources that give the same picture: a file inside a chosen folder, or the same bytes
  // under two names. The pool counts the picture once; the person is told why the sum differs.
  const overlap =
    pool.sources.reduce((sum, source) => sum + source.imageCount, 0) > pool.eligibleCount;

  return (
    <div className={`team-restitch-pool team-restitch-pool-${slot}`} data-state={pool.state}>
      <p className="team-inline-note" role="status">
        {pool.state === 'empty'
          ? pool.sources.length === 0
            ? t('teamRestitchPoolNone')
            : t('teamRestitchPoolEmpty')
          : t('teamRestitchPoolEligible', { count: pool.eligibleCount })}
        {pool.state === 'partial' && ` ${t('teamRestitchPoolPartial', { count: unavailable })}`}
        {skipped > 0 && ` ${t('teamRestitchPoolSkipped', { count: skipped })}`}
        {overlap && ` ${t('teamRestitchPoolOverlap')}`}
        {pool.overLimit && ` ${t('teamRestitchPoolOverLimit')}`}
      </p>
      {pool.sources.length > 0 && (
        <ul className="product-catalog-sources">
          {pool.sources.map(source => {
            const key = source.materialId ?? source.driveFileId ?? source.name;
            const reason = AVAILABILITY_KEYS[source.availability];
            const skippedHere =
              source.skipped.format + source.skipped.size + source.skipped.animated;
            return (
              <li key={key} data-availability={source.availability}>
                {source.kind === 'folder' ? (
                  <Folder size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
                ) : (
                  <Image size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
                )}
                <span className="product-catalog-source-name" title={source.name}>
                  {source.name}
                </span>
                {reason ? (
                  <Badge color="warning" variant="soft">
                    {t(reason)}
                  </Badge>
                ) : (
                  source.kind === 'folder' && (
                    <small>
                      {t('productCatalogImagesInFolder', { count: source.imageCount })}
                      {skippedHere > 0 &&
                        ` · ${t('teamRestitchSourceSkipped', {
                          format: source.skipped.format,
                          size: source.skipped.size,
                          animated: source.skipped.animated
                        })}`}
                    </small>
                  )
                )}
                {editable && (
                  <IconButton
                    size="xs"
                    variant="ghost"
                    label={t('productCatalogImagesRemove', { name: source.name })}
                    onClick={() =>
                      onChange(
                        slot,
                        current.filter((_, index) => pool.sources[index] !== source)
                      )
                    }
                  >
                    <X aria-hidden="true" />
                  </IconButton>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editable && client && (
        <div className="settings-section-actions">
          <TaskAttachmentPicker
            teamId={teamId}
            client={client as TaskAttachmentPickerClient}
            attachedMaterialIds={
              new Set(
                pool.sources
                  .filter(source => source.kind === 'file' && source.materialId)
                  .map(source => source.materialId as string)
              )
            }
            accept={(material: TeamMaterialSummary) => material.category === 'image'}
            title={t('teamRestitchPickTitle')}
            confirmLabel={count => t('productCatalogImagesPickConfirm', { count })}
            trigger={open => (
              <Button type="button" variant="secondary" onClick={open}>
                <Image size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
                {t('teamRestitchAddFiles')}
              </Button>
            )}
            onAdd={picked =>
              onChange(slot, [...current, ...picked.map(item => ({ materialId: item.id }))])
            }
          />
          <Button type="button" variant="secondary" onClick={() => setPickingFolder(true)}>
            <Folder size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('teamRestitchAddFolder')}
          </Button>
        </div>
      )}
      {pickingFolder && client && (
        <FolderPicker
          teamId={teamId}
          client={client as FolderPickerClient}
          title={t('teamRestitchPickFolder')}
          nested
          selectionId="material"
          onClose={() => setPickingFolder(false)}
          onSelect={folder => {
            setPickingFolder(false);
            if (folder.id === 'root') {
              push({ tone: 'error', text: t('productCatalogImagesRootRefused') });
              return;
            }
            onChange(slot, [...current, { materialId: folder.id }]);
          }}
        />
      )}
    </div>
  );
}
