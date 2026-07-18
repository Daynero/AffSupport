import { BUILD_ID, BUILD_NUMBER, PRODUCT_VERSION, RELEASE_CHANNEL } from '@video-compressor/shared';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 43120;

function releaseValue(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function validOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL origin.`);
  }
  if (url.origin !== value || (url.protocol !== 'https:' && url.hostname !== '127.0.0.1'))
    throw new Error(`${label} must be an HTTPS origin (or 127.0.0.1 for development).`);
  return value;
}

export const config = {
  host: DEFAULT_HOST,
  port: Number(process.env.AGENT_PORT ?? DEFAULT_PORT),
  publicOrigin: process.env.PUBLIC_SITE_ORIGIN
    ? validOrigin(process.env.PUBLIC_SITE_ORIGIN, 'PUBLIC_SITE_ORIGIN')
    : null,
  devOrigin: validOrigin(process.env.DEV_SITE_ORIGIN ?? 'http://127.0.0.1:5173', 'DEV_SITE_ORIGIN'),
  version: releaseValue('AGENT_VERSION', PRODUCT_VERSION),
  buildNumber: releaseValue('AGENT_BUILD_NUMBER', BUILD_NUMBER),
  buildId: releaseValue('AGENT_BUILD_ID', BUILD_ID),
  channel: releaseValue('AGENT_RELEASE_CHANNEL', RELEASE_CHANNEL),
  sourceRevision: releaseValue('AGENT_SOURCE_REVISION', 'development')
};
if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535)
  throw new Error('AGENT_PORT must be a port from 1024 to 65535.');
export const allowedOrigins = new Set(
  [config.devOrigin, config.publicOrigin, `http://${config.host}:${config.port}`].filter(
    (value): value is string => Boolean(value)
  )
);
