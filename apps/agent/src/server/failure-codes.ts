/**
 * Stable codes for failures the local app reports.
 *
 * Twenty routes relayed `error.message` straight to the browser. Those messages
 * come from Node, FFmpeg and the filesystem, and they routinely carry a full
 * path — so the interface was showing people `ENOENT: no such file or
 * directory, open '/Users/name/Videos/private thing.mov'` and we were shipping
 * that string into toasts, screenshots and support threads (FR-029/FR-029a).
 *
 * They are also untranslatable. The interface renders a code by looking it up;
 * an English sentence from a C library falls through to the generic message,
 * so relaying it was not even buying the user a better explanation.
 *
 * The list is deliberately short. A code per cause is a vocabulary nobody
 * maintains; these name the things a person can actually do something about.
 */
export const FAILURE_CODES = [
  'UPLOAD_FAILED',
  'IMPORT_FAILED',
  'FILE_TOO_LARGE',
  'FILE_UNAVAILABLE',
  'UNSUPPORTED_FORMAT',
  'DISK_FULL',
  'PERMISSION_DENIED',
  'PATH_NOT_GRANTED',
  'TOOL_UNAVAILABLE',
  'OPERATION_FAILED'
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

/**
 * Codes the rest of the agent already throws by name.
 *
 * Kept separate from the list above because these are not ours to choose: they
 * are an existing vocabulary that routes, the team bridge and the interface all
 * agree on. What matters here is only that they are recognised as codes and
 * passed through, rather than being mistaken for a message and replaced with a
 * generic one — which is exactly what my first version of this did, and the
 * suite caught it.
 */
const PASSTHROUGH_CODES = [
  'AGENT_REQUIRED',
  'AGENT_UPDATE_REQUIRED',
  'DOWNLOAD_CANCELED',
  'EMBED_IMAGES_REQUIRED',
  'ENTITLEMENT_TOKEN_INVALID',
  'INVALID_ARCHIVE',
  'INVALID_INPUT',
  'INVALID_RESPONSE',
  'NAME_CONFLICT',
  'NOT_FOUND',
  'PREVIEW_BRIDGE_NOT_INITIALIZED',
  'PREVIEW_CANCELED',
  'PREVIEW_ORIGIN_UNAVAILABLE',
  'TRANSITION_NOT_ALLOWED',
  'IMAGE_UNSUPPORTED_FORMAT',
  'IMAGE_DAMAGED',
  'IMAGE_TOO_LARGE',
  'IMAGE_UNAVAILABLE',
  'IMAGE_IMPORT_FAILED',
  'INVALID_CUSTOM_IMAGE_DURATION'
] as const;

const KNOWN = new Set<string>([...FAILURE_CODES, ...PASSTHROUGH_CODES]);

/**
 * Maps a thrown value to a code, without letting its text through.
 *
 * A message that is *already* one of our codes passes unchanged — several
 * layers throw them deliberately. Everything else is classified by the errno
 * the platform gave us, which is the part that carries meaning, and never by
 * the sentence, which carries the path.
 */
export function failureCode(error: unknown, fallback: FailureCode = 'OPERATION_FAILED'): string {
  if (error instanceof Error && KNOWN.has(error.message)) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  switch (typeof code === 'string' ? code : '') {
    case 'ENOSPC':
      return 'DISK_FULL';
    case 'EACCES':
    case 'EPERM':
      return 'PERMISSION_DENIED';
    case 'ENOENT':
      return 'FILE_UNAVAILABLE';
    case 'EFBIG':
      return 'FILE_TOO_LARGE';
    default:
      return fallback;
  }
}
