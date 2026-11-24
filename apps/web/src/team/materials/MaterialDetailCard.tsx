import { useState, type ReactNode } from 'react';
import type {
  MaterialCategory,
  TeamMaterialRowKind,
  TeamMaterialTagColor
} from '@video-compressor/shared';
import { FadeImage } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { displayedSize } from '../../format';
import { useTeam } from '../TeamContext';
import { KindIcon } from '../explorer/KindIcon';
import { KIND_LABEL } from '../explorer/rowKinds';
import { MaterialRank } from '../ranks/MaterialRank';
import { carriesRank } from '../ranks/creativeRanks';
import type { MaterialCompanions } from './actions';
import { MaterialCatalogFacts } from './MaterialCatalogFacts';
import { MaterialDetail } from './MaterialDetail';
import { MaterialNoteBlock } from './MaterialNote';
import { MaterialTasks } from './MaterialTasks';
import { useMaterialCompanions } from './useMaterialCompanions';

/**
 * What any surface knows about a file it did not get from a folder listing (070, US3): a
 * search result, a task's attachment, a catalog in the updater. Deliberately no provider id,
 * no Drive version and no "thumbnail is ready" flag — a surface that does not have them must
 * not be made to invent them, and the card needs none of them.
 */
export interface DetailMaterial {
  id: string;
  teamId: string;
  name: string;
  kind: TeamMaterialRowKind;
  category: MaterialCategory | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  modifiedAt?: string | null;
  tagColor?: TeamMaterialTagColor | null;
}

/**
 * The one details card (024 US5, 070 T023/T025), wired: the facts, the rank, the catalog facts,
 * the tasks the file is on, its note and what lives beside it — read here, once, for the file in
 * focus. The explorer's own pane draws the same `MaterialDetail` from a folder row; every other
 * door to a file (a search result, a task's attachment, the updater's row) comes through here,
 * so "is this the right file?" is answered the same way however you arrived.
 *
 * The picture is the host's (how it is fetched genuinely differs); without one it is the kind's
 * glyph. The actions are the host's too, handed the companions so a video whose catalog exists
 * offers that catalog rather than a second one.
 */
export function MaterialDetailCard({
  material,
  folderName,
  picture,
  notes,
  tag,
  revision = 0,
  className,
  actions
}: {
  material: DetailMaterial;
  /** Where it lives, as a person would say it. */
  folderName?: string | null;
  /** A picture the host could fetch; the card falls back to the glyph when it fails. */
  picture?: string | null;
  notes?: ReactNode;
  tag?: {
    canTag: boolean;
    onChange: (color: TeamMaterialTagColor | null) => void;
  };
  revision?: number;
  className?: string;
  actions?: (companions: MaterialCompanions | undefined, refresh: () => void) => ReactNode;
}) {
  const { t } = useI18n();
  const { teams, ranksRevision = 0 } = useTeam();
  const space = teams.find(team => team.id === material.teamId);
  const isFolder = material.kind === 'folder';
  const [made, setMade] = useState(0);
  const companions = useMaterialCompanions(
    {
      id: material.id,
      teamId: material.teamId,
      kind: isFolder ? 'folder' : 'file',
      category: material.category
    },
    { revision: revision + made }
  );
  const [brokenPicture, setBrokenPicture] = useState<string | null>(null);
  const shownPicture = picture && picture !== brokenPicture ? picture : null;
  const size =
    isFolder || material.sizeBytes === null || material.sizeBytes === undefined
      ? null
      : displayedSize(material.sizeBytes, material.mimeType ?? null) === null
        ? null
        : material.sizeBytes;

  return (
    <MaterialDetail
      name={material.name}
      className={className}
      facts={{
        kindLabel: t(KIND_LABEL[material.kind]),
        sizeBytes: size,
        modifiedAt: material.modifiedAt ?? null,
        folderName: folderName ?? null
      }}
      companions={companions}
      tag={
        tag
          ? { color: material.tagColor ?? null, canTag: tag.canTag, onChange: tag.onChange }
          : undefined
      }
      rank={
        carriesRank(material) ? (
          <MaterialRank
            key={material.id}
            teamId={material.teamId}
            materialId={material.id}
            isOwner={space?.role === 'owner'}
            ranksRevision={ranksRevision}
          />
        ) : null
      }
      catalogFacts={
        isFolder ? null : (
          <MaterialCatalogFacts
            teamId={material.teamId}
            material={{ id: material.id, name: material.name }}
          />
        )
      }
      inTasks={
        isFolder ? null : (
          <MaterialTasks
            teamId={material.teamId}
            material={{ id: material.id, name: material.name }}
            revision={revision}
          />
        )
      }
      note={
        isFolder ? null : (
          <MaterialNoteBlock
            teamId={material.teamId}
            materialId={material.id}
            canEdit={space?.permissions.manage_metadata === true}
            revision={revision}
          />
        )
      }
      preview={
        shownPicture ? (
          <FadeImage
            src={shownPicture}
            alt=""
            decoding="async"
            onError={() => setBrokenPicture(shownPicture)}
          />
        ) : (
          <span className="team-explorer-tile-icon" aria-hidden="true">
            <KindIcon kind={material.kind} />
          </span>
        )
      }
      notes={notes}
      actions={actions?.(companions, () => setMade(value => value + 1))}
    />
  );
}
