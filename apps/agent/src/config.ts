const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 43120;

function validOrigin(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an absolute URL origin.`); }
  if (url.origin !== value || (url.protocol !== 'https:' && url.hostname !== '127.0.0.1')) throw new Error(`${label} must be an HTTPS origin (or 127.0.0.1 for development).`);
  return value;
}

export const config = {
  host: DEFAULT_HOST,
  port: Number(process.env.AGENT_PORT ?? DEFAULT_PORT),
  publicOrigin: process.env.PUBLIC_SITE_ORIGIN ? validOrigin(process.env.PUBLIC_SITE_ORIGIN, 'PUBLIC_SITE_ORIGIN') : null,
  devOrigin: validOrigin(process.env.DEV_SITE_ORIGIN ?? 'http://127.0.0.1:5173', 'DEV_SITE_ORIGIN'),
  version: process.env.npm_package_version ?? '0.1.0-test'
};
if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('AGENT_PORT must be a port from 1024 to 65535.');
export const allowedOrigins = new Set([config.devOrigin, config.publicOrigin, `http://${config.host}:${config.port}`].filter((value): value is string => Boolean(value)));
