import {
  isMetadataBearingFileName,
  stripMediaMetadata,
  type TeamDownloadGrantResult
} from '@video-compressor/shared';
import { fetchForDownload, saveBytesAsDownload } from './browser-download';

/**
 * One door for "download this file" (073).
 *
 * A download is clean unless the person chose otherwise: no camera, phone, place, date, editor
 * or author in the file that lands on their disk. The browser cleans what it fetches itself
 * (every grant it gets is ≤ 32 MiB, so the bytes fit in memory); Soty cleans what goes through
 * the app. "Download with metadata", kept one level down in the same menu, is the original
 * byte-for-byte, the way the space holds it.
 *
 * The three places that used to repeat the browser-or-agent dance — the row and pane menu, the
 * explorer card and a task's attachment — now all come through here, so the rule cannot be
 * forgotten in one of them.
 */

export type DownloadMetadata = 'clean' | 'original';
export type DownloadDelivery = 'browser_handoff' | 'agent_saved';

export interface DownloadMaterialInput {
  teamId: string;
  materialId: string;
  fileName: string;
  metadata: DownloadMetadata;
  requestDownload(
    teamId: string,
    materialId: string,
    consumer: 'browser' | 'agent'
  ): Promise<TeamDownloadGrantResult>;
  downloadWithAgent(input: {
    transferUrl: string;
    transferGrant: Extract<TeamDownloadGrantResult, { kind: 'agent' }>['grant'];
    fileName: string;
    metadata: DownloadMetadata;
  }): Promise<unknown>;
  /**
   * A surface that already owns the local app's download (its dialogs and progress) takes the
   * agent path over itself instead of this module asking for an agent grant.
   */
  takeOverAgentPath?: () => Promise<void>;
}

/** Raised when the browser cannot clean a file itself and Soty has to. */
const NEEDS_AGENT = 'AGENT_REQUIRED';

function codeOf(error: unknown): string | null {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : error.message;
  }
  return null;
}

export async function downloadMaterial(input: DownloadMaterialInput): Promise<DownloadDelivery> {
  const viaAgent = async (): Promise<DownloadDelivery> => {
    if (input.takeOverAgentPath) {
      await input.takeOverAgentPath();
      return 'agent_saved';
    }
    const grant = await input.requestDownload(input.teamId, input.materialId, 'agent');
    if (grant.kind !== 'agent') throw new Error('INVALID_RESPONSE');
    await input.downloadWithAgent({
      transferUrl: grant.transferUrl,
      transferGrant: grant.grant,
      fileName: grant.fileName ?? input.fileName,
      metadata: input.metadata
    });
    return 'agent_saved';
  };
  let grant: TeamDownloadGrantResult;
  try {
    grant = await input.requestDownload(input.teamId, input.materialId, 'browser');
  } catch (caught) {
    // A file only the local app may fetch (larger than the browser path takes).
    if (codeOf(caught) !== NEEDS_AGENT) throw caught;
    return viaAgent();
  }
  if (grant.kind === 'agent') {
    if (input.takeOverAgentPath) return viaAgent();
    await input.downloadWithAgent({
      transferUrl: grant.transferUrl,
      transferGrant: grant.grant,
      fileName: grant.fileName ?? input.fileName,
      metadata: input.metadata
    });
    return 'agent_saved';
  }
  const fileName = grant.fileName ?? input.fileName;
  try {
    await saveInBrowser(grant.rangeUrl, fileName, input.metadata);
    return 'browser_handoff';
  } catch (caught) {
    // A container the browser does not walk (WebM, MKV, AVI…) is re-muxed by Soty.
    if (codeOf(caught) !== NEEDS_AGENT) throw caught;
    return viaAgent();
  }
}

/**
 * Fetches the file and hands it to the browser's own download as a same-origin blob — every
 * browser grant is ≤ 32 MiB, so it fits in memory. Clean unless the person asked for the original.
 *
 * Always through a blob, the original included: an `<a download>` pointing at another origin is
 * a suggestion Safari ignores, so a creative opened in a new tab and started playing instead of
 * saving (owner, 2026-11-25), and clicking through several in a row meant a tab each.
 */
async function saveInBrowser(
  url: string,
  fileName: string,
  metadata: DownloadMetadata
): Promise<void> {
  const fetched = await fetchForDownload(url);
  let bytes = fetched.bytes;
  // A name without an extension is looked at by its bytes; a document is left as it came.
  const inspect = !fileName.includes('.') || isMetadataBearingFileName(fileName);
  if (metadata === 'clean' && inspect) {
    const result = stripMediaMetadata(bytes);
    // Not a picture or video at all (a name without an extension): saved as it came.
    const notMedia = result.format === 'unknown' && !isMetadataBearingFileName(fileName);
    if (!result.supported && !notMedia) throw new Error(NEEDS_AGENT);
    bytes = result.bytes;
  }
  saveBytesAsDownload(bytes, fileName, fetched.type);
}
