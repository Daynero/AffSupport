import type { ScreenProps, SurfaceId } from '../review/model';
import { AccountReview } from './account/AccountReview';
import { AuthReview } from './auth/AuthReview';
import { ComponentShowcase } from './components/ComponentShowcase';
import { CompressorReview } from './compressor/CompressorReview';
import { HomeReview } from './home/HomeReview';
import { LandingGalleryReview } from './landing-gallery/LandingGalleryReview';
import { LandingOptimizerReview } from './landing-optimizer/LandingOptimizerReview';
import { ShellReview } from './shell/ShellReview';
import { CreateSpaceReview } from './team/CreateSpaceReview';
import { TeamLobbyReview } from './team/TeamLobbyReview';
import { TeamSettingsReview } from './team/TeamSettingsReview';
import { TeamWorkspaceReview } from './team/TeamWorkspaceReview';
import { TranscriptionReview } from './transcription/TranscriptionReview';

const screens: Record<SurfaceId, (props: ScreenProps) => React.ReactNode> = {
  'auth-entry': AuthReview,
  'global-shell': ShellReview,
  'home-tools': HomeReview,
  compressor: CompressorReview,
  'landing-optimizer': LandingOptimizerReview,
  'landing-gallery': LandingGalleryReview,
  transcription: TranscriptionReview,
  'team-lobby': TeamLobbyReview,
  'team-create-space': CreateSpaceReview,
  'team-workspace': TeamWorkspaceReview,
  'team-settings': TeamSettingsReview,
  'account-profile': AccountReview,
  'component-showcase': ComponentShowcase
};

export function ScreenRegistry({ surfaceId, ...props }: ScreenProps & { surfaceId: SurfaceId }) {
  const Screen = screens[surfaceId];
  return <Screen {...props} />;
}
