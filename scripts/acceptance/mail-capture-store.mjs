import { createHash } from 'node:crypto';
import { readPrivateState, writePrivateState } from './private-state.mjs';

export const MAIL_CAPTURE_IDENTITY = 'soty.acceptance.mail-capture.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const KINDS = new Set([
  'warn_3d',
  'warn_1d',
  'grace',
  'blocked',
  'granted',
  'renewed',
  'member_nudge'
]);

/** Input must already be rendered from the verified campaign's redacted notice.
 * This store has no transport and never replaces a previous notice capture.
 * A replay proves a matching local artifact, not database completion or delivery.
 */
export async function storeNoticeCapture(namespace, id, kind, message, options = {}) {
  if (
    !UUID.test(id) ||
    !KINDS.has(kind) ||
    !message ||
    ['subject', 'html', 'text'].some(key => typeof message[key] !== 'string')
  )
    throw Error('ACCEPTANCE_MAIL_CAPTURE_INVALID');
  const content = { subject: message.subject, html: message.html, text: message.text };
  const encoded = JSON.stringify(content);
  if (Buffer.byteLength(encoded) > 48 * 1024) throw Error('ACCEPTANCE_MAIL_CAPTURE_INVALID');
  const sha256 = createHash('sha256').update(encoded).digest('hex');
  const value = {
    identity: MAIL_CAPTURE_IDENTITY,
    namespace,
    id,
    kind,
    sha256,
    message: content,
    delivered: false
  };
  const name = `mail-${id}.json`;
  let created = true;
  try {
    await writePrivateState(namespace, name, value, { ...options, createOnly: true });
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
      throw error;
    const previous = await readPrivateState(namespace, name, options.root);
    if (JSON.stringify(previous) !== JSON.stringify(value))
      throw Error('ACCEPTANCE_MAIL_CAPTURE_CONFLICT', { cause: error });
    created = false;
  }
  return { id, kind, sha256, created, captured: true, delivered: false };
}
