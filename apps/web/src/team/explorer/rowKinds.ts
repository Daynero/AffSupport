import type { TeamMaterialRow, TeamMaterialRowKind } from '@video-compressor/shared';
import type { TeamMaterialSummary } from '../../api/team';
import type { TranslationKey } from '../../i18n';

/** The drag payload: a comma-joined list of material ids (011, FR-026). */
export const DRAG_TYPE = 'application/x-soty-materials';

/** One vocabulary for the nine row kinds, shared by list, grid and pane (011). */
export const KIND_ICON: Record<TeamMaterialRowKind, string> = {
  folder: '📁',
  image: '🖼',
  video: '🎬',
  landing: '🧩',
  archive: '🗜',
  transcript: '📝',
  document: '📄',
  shortcut: '↗',
  other: '▤'
};

export const KIND_LABEL: Record<TeamMaterialRowKind, TranslationKey> = {
  folder: 'teamExplorerKindFolder',
  image: 'teamExplorerKindImage',
  video: 'teamExplorerKindVideo',
  landing: 'teamExplorerKindLanding',
  archive: 'teamExplorerKindArchive',
  transcript: 'teamExplorerKindTranscript',
  document: 'teamExplorerKindDocument',
  shortcut: 'teamExplorerKindShortcut',
  other: 'teamExplorerKindOther'
};

/** Kinds that cannot be opened in Soty say so in one line (FR-011). */
export const KIND_REASON: Partial<Record<TeamMaterialRowKind, TranslationKey>> = {
  document: 'teamExplorerReasonDocument',
  shortcut: 'teamExplorerReasonShortcut'
};

export const PREVIEWABLE_KINDS: ReadonlySet<TeamMaterialRowKind> = new Set([
  'image',
  'video',
  'transcript',
  'archive',
  'landing'
]);

/** The viewer still speaks the catalog's older three-kind shape. */
export function previewSummary(row: TeamMaterialRow): TeamMaterialSummary {
  return {
    id: row.id,
    teamId: row.teamId,
    providerId: row.driveFileId,
    parentFolderId: row.parentFolderId,
    name: row.name,
    kind: row.kind === 'folder' ? 'folder' : row.kind === 'shortcut' ? 'shortcut' : 'file',
    category: row.category,
    mimeType: row.mimeType,
    fileExtension: row.fileExtension,
    sizeBytes: row.sizeBytes,
    modifiedAt: row.modifiedAt,
    previewState: row.previewState
  };
}
