import { builtForEnvironment } from '../../lib/config';
export const launchCatalogVideoEnabled = () =>
  builtForEnvironment() === 'beta' && import.meta.env.VITE_CATALOG_VIDEO_VARIANTS === 'true';
