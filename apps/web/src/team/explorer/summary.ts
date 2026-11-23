import type { TeamMaterialRow } from '@video-compressor/shared';
import type { TeamMaterialSummary } from '../../api/team';

/** What a preview needs to know about a row of the explorer. */
export function summaryOf(row: TeamMaterialRow): TeamMaterialSummary {
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
    previewState: row.previewState,
    landingRender: row.landingRender
  };
}
