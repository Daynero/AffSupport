import { teamApi } from '../../api/team';
import type { TeamFileOperationResult } from '@video-compressor/shared';

/**
 * One place that knows what travels with a material (owner, 2026-09-02).
 *
 * A video owns a transcript; a landing owns its rendered preview. Before this,
 * every surface carried the tail itself — and only two of them did. Rename and
 * move (012, T008/T009) took the transcript along from the row menu, while the
 * same move from a drag, a cut-and-paste, a copy and a trash did not: a pasted
 * video arrived without its text, and deleting from the wrong menu left an
 * orphan .txt behind.
 *
 * So every one of those goes through this module instead. Adding an operation
 * means adding it here, which is the point: the next kind of tail (a poster, a
 * translation) is then one change rather than six.
 *
 * The landing's tail is not here because it is not a second file: the copy's
 * render is cloned server-side by `service_clone_material_extras`, inside the
 * same request that made the copy.
 */
export interface TailMaterial {
  id: string;
  name: string;
  category: string | null;
}

export interface TailClient {
  copyMaterial: (input: {
    teamId: string;
    materialId: string;
    destinationFolderId: string | null;
    idempotencyKey: string;
  }) => Promise<TeamFileOperationResult>;
  moveMaterial: (input: {
    teamId: string;
    materialId: string;
    destinationFolderId: string | null;
    conflictMode: 'cancel' | 'keep_both';
    idempotencyKey: string;
  }) => Promise<TeamFileOperationResult>;
  renameMaterial: (input: {
    teamId: string;
    materialId: string;
    newName: string;
    conflictMode: 'cancel' | 'keep_both';
    idempotencyKey: string;
  }) => Promise<TeamFileOperationResult>;
  trashMaterial: (input: {
    teamId: string;
    materialId: string;
    idempotencyKey: string;
  }) => Promise<unknown>;
}

/**
 * Each operation asks only for the call it makes, so a surface that can move
 * but not copy still gets the tail behaviour for what it can do.
 */
export type CopyTailClient = Pick<TailClient, 'copyMaterial'>;
export type MoveTailClient = Pick<TailClient, 'moveMaterial'>;
export type RenameTailClient = Pick<TailClient, 'renameMaterial'>;
export type TrashTailClient = Pick<TailClient, 'trashMaterial'>;

/** What the catalog says belongs to this material right now. */
export interface MaterialTail {
  transcript: { id: string; name: string } | null;
  /** 022 — the video's product catalog sheets: one per variation (024, US15). */
  catalogs: Array<{ id: string; name: string; variant: number }>;
}

const key = () => crypto.randomUUID();

/**
 * The tail as it stands, or an empty one.
 *
 * Never throws: a tail that cannot be read must not stop the operation the
 * person actually asked for. The cost of missing it is one file left behind,
 * which is what happened before this module existed and is still better than a
 * move that refuses to happen.
 */
export async function tailOf(teamId: string, material: TailMaterial): Promise<MaterialTail> {
  if (material.category !== 'video') return { transcript: null, catalogs: [] };
  const [companion, catalogs] = await Promise.all([
    teamApi.getTranscriptCompanion(teamId, material.id).catch(() => null),
    teamApi.listProductCatalogs(teamId, material.id).catch(() => [])
  ]);
  return {
    transcript: companion ? { id: companion.id, name: companion.name } : null,
    catalogs: catalogs.map(catalog => ({
      id: catalog.id,
      name: catalog.name,
      variant: catalog.variant
    }))
  };
}

/**
 * `IN 40.mp4`, variation 2 → `IN 40_v2_catalog`: the naming rule the Edge Function creates
 * catalogs with (022; numbered for variations in 024).
 */
export function productCatalogNameFor(videoName: string, variant: number): string {
  const stem = videoName.replace(/\.[^.]+$/u, '');
  return `${stem.length > 0 ? stem : videoName}_v${variant}_catalog`;
}

/** `<stem>.txt` for a video's name — the one naming rule for a transcript. */
export function transcriptNameFor(videoName: string): string {
  return `${videoName.replace(/\.[^.]+$/u, '')}.txt`;
}

/**
 * Copies a material and gives the copy its own tail.
 *
 * The transcript is copied rather than shared: each video owns exactly one, so
 * re-transcribing a copy replaces the copy's text and leaves the original's
 * alone. Named after the copy — a copy called `clip (2).mp4` gets
 * `clip (2).txt` — so the pair still reads as a pair.
 *
 * The product catalog is deliberately left behind (022): every row of a catalog
 * links to one specific video file, so a copied sheet would describe the
 * original. The copy starts without one and offers to make its own.
 */
export async function copyMaterialWithTail(input: {
  teamId: string;
  material: TailMaterial;
  destinationFolderId: string | null;
  client: CopyTailClient;
}): Promise<TeamFileOperationResult> {
  const { teamId, material, destinationFolderId, client } = input;
  const tail = await tailOf(teamId, material);
  const result = await client.copyMaterial({
    teamId,
    materialId: material.id,
    destinationFolderId,
    idempotencyKey: key()
  });
  if (!tail.transcript || !result.materialId) return result;
  try {
    const copiedTranscript = await client.copyMaterial({
      teamId,
      materialId: tail.transcript.id,
      destinationFolderId,
      idempotencyKey: key()
    });
    if (!copiedTranscript.materialId) return result;
    // Names line up on their own: both files are copied into the same folder
    // under the same conflict rule, so a video that lands as "clip (2).mp4"
    // brings "clip (2).txt" with it. The link is what makes them a pair; the
    // name is how a person reads it.
    await teamApi.linkTranscriptCompanion(teamId, result.materialId, copiedTranscript.materialId);
  } catch {
    // The video is copied either way; a tail that failed is visible as a video
    // with no text, and re-transcribing it is one click.
  }
  return result;
}

/** Moves a material, and its transcript and catalog to the same folder. */
export async function moveMaterialWithTail(input: {
  teamId: string;
  material: TailMaterial;
  destinationFolderId: string | null;
  conflictMode?: 'cancel' | 'keep_both';
  client: MoveTailClient;
}): Promise<TeamFileOperationResult> {
  const { teamId, material, destinationFolderId, client } = input;
  const tail = await tailOf(teamId, material);
  const result = await client.moveMaterial({
    teamId,
    materialId: material.id,
    destinationFolderId,
    conflictMode: input.conflictMode ?? 'cancel',
    idempotencyKey: key()
  });
  for (const companion of [tail.transcript, ...tail.catalogs]) {
    if (!companion) continue;
    await client
      .moveMaterial({
        teamId,
        materialId: companion.id,
        destinationFolderId,
        conflictMode: 'keep_both',
        idempotencyKey: key()
      })
      .catch(() => undefined);
  }
  return result;
}

/** Renames a material, and its transcript and catalog after it. */
export async function renameMaterialWithTail(input: {
  teamId: string;
  material: TailMaterial;
  newName: string;
  conflictMode?: 'cancel' | 'keep_both';
  client: RenameTailClient;
}): Promise<TeamFileOperationResult> {
  const { teamId, material, newName, client } = input;
  const tail = await tailOf(teamId, material);
  const result = await client.renameMaterial({
    teamId,
    materialId: material.id,
    newName,
    conflictMode: input.conflictMode ?? 'cancel',
    idempotencyKey: key()
  });
  const renames = [
    tail.transcript && { id: tail.transcript.id, name: transcriptNameFor(newName) },
    ...tail.catalogs.map(catalog => ({
      id: catalog.id,
      name: productCatalogNameFor(newName, catalog.variant)
    }))
  ];
  for (const companion of renames) {
    if (!companion) continue;
    await client
      .renameMaterial({
        teamId,
        materialId: companion.id,
        newName: companion.name,
        conflictMode: 'keep_both',
        idempotencyKey: key()
      })
      .catch(() => undefined);
  }
  return result;
}

/**
 * Trashes a material and the transcript and catalog that belong to it.
 *
 * No question asked, because there is nothing to weigh: a video owns its
 * transcript, copies get their own, and text without the video it describes is
 * not something anyone keeps on purpose. Both are recoverable from the trash.
 */
export async function trashMaterialWithTail(input: {
  teamId: string;
  material: TailMaterial;
  client: TrashTailClient;
}): Promise<void> {
  const { teamId, material, client } = input;
  const tail = await tailOf(teamId, material);
  await client.trashMaterial({ teamId, materialId: material.id, idempotencyKey: key() });
  for (const companion of [tail.transcript, ...tail.catalogs]) {
    if (!companion) continue;
    await client
      .trashMaterial({ teamId, materialId: companion.id, idempotencyKey: key() })
      .catch(() => undefined);
  }
}
