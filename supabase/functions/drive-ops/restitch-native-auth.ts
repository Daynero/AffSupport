import { authorizeCaller, type CallerAuthClient } from '../_shared/auth.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord, parseUuid } from '../_shared/validation.ts';
/** Metadata extraction only after the existing real Auth verifier accepted the
 * original token. This is not a JWT signature verifier or local-dev auth seam.
 * SQL must still require that exact session to belong to this actor and be live. */
export async function authorizeRestitchNativeEnrollment(
  request: Request,
  client: CallerAuthClient
): Promise<{ userId: string; sessionId: string }> {
  let authorized: Awaited<ReturnType<typeof authorizeCaller>>;
  try {
    authorized = await authorizeCaller(request, client);
  } catch (cause) {
    if (cause instanceof TeamFunctionError) throw cause;
    throw new TeamFunctionError('TEAM_TRANSPORT_UNAVAILABLE', { retryable: true });
  }
  try {
    const parts = authorized.jwt.split('.');
    if (parts.length !== 3 || !parts[1] || !/^[A-Za-z0-9_-]+$/u.test(parts[1])) throw Error();
    const encoded = parts[1].replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isRecord(value)) throw Error();
    const actor = parseUuid(authorized.userId),
      subject = parseUuid(value.sub),
      session = parseUuid(value.session_id);
    if (!actor.ok || !subject.ok || !session.ok || subject.value !== actor.value) throw Error();
    return { userId: actor.value, sessionId: session.value };
  } catch {
    throw new TeamFunctionError('AUTH_REQUIRED');
  }
}
