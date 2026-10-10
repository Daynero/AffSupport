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

/**
 * Gives a video its own copy of a transcript, named after it and linked to it.
 *
 * The one primitive behind two journeys (012): a compressed or re-encoded result carries the
 * source's text (T010), and a video whose audio was already transcribed elsewhere in the space
 * reuses that text instead of running whisper again (FR-T2). Either way the copy is the video's
 * own — re-transcribing it later replaces this copy and leaves the original alone.
 *
 * Returns the linked copy's id, or null when the video did not end up with one. Never throws:
 * the video exists either way, and a video without text is one press from getting it.
 */
export async function carryTranscript(input: {
  teamId: string;
  transcriptId: string;
  video: { id: string; name: string };
  destinationFolderId: string | null;
  client: CopyTailClient & RenameTailClient;
}): Promise<string | null> {
  const { teamId, transcriptId, video, destinationFolderId, client } = input;
  try {
    const copied = await client.copyMaterial({
      teamId,
      materialId: transcriptId,
      destinationFolderId,
      idempotencyKey: key()
    });
    const copyId = copied.materialId;
    if (!copyId) return null;
    // The copy lands under the source transcript's name ("clip.txt", or "clip (2).txt" beside
    // it); the video it now belongs to is called something else ("clip_1.mp4").
    await client
      .renameMaterial({
        teamId,
        materialId: copyId,
        newName: transcriptNameFor(video.name),
        conflictMode: 'keep_both',
        idempotencyKey: key()
      })
      .catch(() => undefined);
    return (await teamApi.linkTranscriptCompanion(teamId, video.id, copyId)) ? copyId : null;
  } catch {
    return null;
  }
}

/**
 * A file made *from* a video — a compression, an embed — takes the source's transcript along
 * (012, T010). An overwrite is not one: the result is the same material, and its companion
 * never left.
 */
export async function carryTranscriptToDerivative(input: {
  teamId: string;
  source: TailMaterial;
  derivative: { id: string; name: string };
  destinationFolderId: string | null;
  client: CopyTailClient & RenameTailClient;
}): Promise<string | null> {
  const { teamId, source, derivative, destinationFolderId, client } = input;
  if (derivative.id === source.id) return null;
  const tail = await tailOf(teamId, source);
  if (!tail.transcript) return null;
  return carryTranscript({
    teamId,
    transcriptId: tail.transcript.id,
    video: derivative,
    destinationFolderId,
    client
  });
}

/** The tools whose result is a new video made from the source, so it takes the text along. */
const DERIVING_TOOLS = new Set(['compressor', 'imageEmbedding']);

/**
 * What every surface that runs a tool does once the run has written its result (012, T010):
 * a compression or an embed into a new file gives that file the source's transcript. The
 * same rule for the queue, the process dialog and a search result, so no path forgets it.
 */
export async function carryTranscriptAfterProcess(input: {
  teamId: string;
  toolId: string;
  source: TailMaterial;
  result: { materialId: string | null; name: string };
  versionOf?: string | null;
  destinationFolderId: string | null;
  client: CopyTailClient & RenameTailClient;
}): Promise<string | null> {
  const { teamId, toolId, source, result, versionOf, destinationFolderId, client } = input;
  if (!DERIVING_TOOLS.has(toolId) || versionOf || !result.materialId) return null;
  return carryTranscriptToDerivative({
    teamId,
    source,
    derivative: { id: result.materialId, name: result.name },
    destinationFolderId,
    client
  });
}

/** The client a surface without its own copy/rename seam uses. */
export const defaultTailClient: CopyTailClient & RenameTailClient = {
  copyMaterial: input => teamApi.copyMaterial(input),
  renameMaterial: input => teamApi.renameMaterial(input)
};

/**
 * Compute-time dedup (012, FR-T2): when another video in the space already has text for the
 * same bytes or the same decoded audio, this video gets its own copy of it instead of a whisper
 * run. Returns the new transcript's id, or null when there was nothing to reuse (or reusing it
 * failed) and the caller should transcribe as usual.
 *
 * Re-transcribe (T007) never calls this: a person who asks for a fresh transcript gets one.
 */
export async function reuseTranscriptFor(input: {
  teamId: string;
  video: { id: string; name: string };
  destinationFolderId: string | null;
  client: CopyTailClient & RenameTailClient;
}): Promise<string | null> {
  const { teamId, video, destinationFolderId, client } = input;
  const reusable = await teamApi.findReusableTranscript(teamId, video.id).catch(() => null);
  if (!reusable) return null;
  return carryTranscript({
    teamId,
    transcriptId: reusable.id,
    video,
    destinationFolderId,
    client
  });
}

/** Moves companions first, then their video. The source keeps showing one complete
 * video until the move finishes, instead of exposing orphan catalog folders. */
export async function moveMaterialWithTail(input: {
  teamId: string;
  material: TailMaterial;
  destinationFolderId: string | null;
  conflictMode?: 'cancel' | 'keep_both';
  client: MoveTailClient;
}): Promise<TeamFileOperationResult> {
  const { teamId, material, destinationFolderId, client } = input;
  const tail = await tailOf(teamId, material);
  await Promise.all(
    [tail.transcript, ...tail.catalogs]
      .filter(companion => companion !== null)
      .map(companion =>
        client
          .moveMaterial({
            teamId,
            materialId: companion.id,
            destinationFolderId,
            conflictMode: 'keep_both',
            idempotencyKey: key()
          })
          .catch(() => undefined)
      )
  );
  return client.moveMaterial({
    teamId,
    materialId: material.id,
    destinationFolderId,
    conflictMode: input.conflictMode ?? 'cancel',
    idempotencyKey: key()
  });
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
