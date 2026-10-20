/** Addresses advertised to desktop clients must name the gateway, never the Edge runtime. */
export function publicFunctionEndpoint(request: Request, functionPath: string): string {
  const url = new URL(request.url);
  // Same gateway headers as the upload relay: the runtime URL is often an internal :8081.
  const host = request.headers.get('x-forwarded-host')?.trim();
  if (host) {
    const protocol = request.headers.get('x-forwarded-proto')?.trim() ?? url.protocol.slice(0, -1);
    if (protocol !== 'http' && protocol !== 'https') throw new Error('INVALID_RESPONSE');
    const origin = new URL(`${protocol}://${host}`);
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new Error('INVALID_RESPONSE');
    const port = request.headers.get('x-forwarded-port')?.trim();
    if (!/:\d+$/u.test(host) && port && /^\d{1,5}$/u.test(port)) origin.port = port;
    url.protocol = origin.protocol;
    url.hostname = origin.hostname;
    url.port = origin.port;
  }
  const gateway = '/functions/v1/';
  const index = url.pathname.indexOf(gateway);
  // Local Edge strips /functions/v1 before forwarding; restore it for callers.
  const prefix = index < 0 ? gateway : url.pathname.slice(0, index) + gateway;
  url.pathname = prefix + functionPath.replace(/^\/+|\/+$/gu, '');
  url.search = '';
  url.hash = '';
  return url.toString();
}
