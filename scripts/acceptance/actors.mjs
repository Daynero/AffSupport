import { validateLocalTarget } from './target.mjs';

/** Decode only to reject privilege escalation; Auth still validates signature on every request. */
export function createActor(target, credentials, transport = fetch) {
  if (!validateLocalTarget(target).ok) throw new Error('ACCEPTANCE_TARGET_UNSAFE');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(credentials.accessToken.split('.')[1], 'base64url').toString());
  } catch {
    throw new Error('ACCEPTANCE_ACTOR_INVALID');
  }
  if (
    !claims ||
    claims.role !== 'authenticated' ||
    typeof claims.sub !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(claims.sub) ||
    (credentials.expectedSubject !== undefined && claims.sub !== credentials.expectedSubject) ||
    typeof claims.exp !== 'number' ||
    claims.exp * 1000 <= Date.now() ||
    typeof credentials.publicKey !== 'string' ||
    !credentials.publicKey ||
    credentials.publicKey.startsWith('sb_secret_')
  )
    throw new Error('ACCEPTANCE_ACTOR_INVALID');
  if (credentials.publicKey.startsWith('ey')) {
    try {
      const key = JSON.parse(
        Buffer.from(credentials.publicKey.split('.')[1], 'base64url').toString()
      );
      if (key.role !== 'anon') throw new Error('ACCEPTANCE_ACTOR_INVALID');
    } catch {
      throw new Error('ACCEPTANCE_ACTOR_INVALID');
    }
  }
  const request = async (url, body, options = {}, functionRequest = false) => {
    let response;
    try {
      response = await transport(url, {
        method: 'POST',
        redirect: 'error',
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
        headers: {
          ...(functionRequest ? { Origin: 'http://127.0.0.1:5175' } : {}),
          apikey: credentials.publicKey,
          Authorization: `Bearer ${credentials.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
    } catch {
      return { ok: false, status: null, code: 'TRANSPORT_UNKNOWN' };
    }
    // PostgREST returns 204 for successful void RPCs; Functions still require an envelope.
    if (!functionRequest && response.status === 204) return { ok: true, status: 204, data: null };
    let data;
    try {
      data = await response.json();
    } catch {
      return { ok: false, status: response.status, code: 'RESPONSE_INVALID' };
    }
    if (!response.ok) {
      const errorCode = data?.code ?? data?.error?.code;
      const code =
        data &&
        typeof data === 'object' &&
        !Array.isArray(data) &&
        typeof errorCode === 'string' &&
        /^[A-Z0-9_]{1,80}$/.test(errorCode)
          ? errorCode
          : 'SERVER_REJECTED';
      return { ok: false, status: response.status, code };
    }
    return { ok: true, status: response.status, data };
  };
  return {
    actorId: claims.sub,
    async rpc(name, body, options = {}) {
      if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{1,95}$/.test(name))
        throw new Error('ACCEPTANCE_RPC_INVALID');
      return request(`${target.authUrl.replace(/\/$/, '')}/rest/v1/rpc/${name}`, body, options);
    },
    async invoke(name, body, options = {}) {
      if (name !== 'team-invitations') throw new Error('ACCEPTANCE_FUNCTION_INVALID');
      const response = await request(`${target.functionsUrl}/${name}`, body, options, true);
      if (!response.ok) return response;
      const envelope = response.data;
      if (!envelope || envelope.ok !== true || !Object.hasOwn(envelope, 'value'))
        return { ok: false, status: response.status, code: 'RESPONSE_INVALID' };
      return { ok: true, status: response.status, data: envelope.value };
    }
  };
}
