// Team landings (004), folded into the explorer by 011. The viewer, its
// controls and the render-item derivation remain; the gallery and its tab do
// not. Client-side viewer-preset storage key is versioned so a future
// preset-shape change can migrate rather than misparse.
export const LANDING_VIEWER_PRESET_STORAGE_KEY = 'soty.landing-viewer.v1';
export { LandingFullView } from './LandingFullView';
export { LandingViewerControls } from './LandingViewerControls';
export { deriveLandingGalleryItems, useTeamLandings } from './useTeamLandings';
