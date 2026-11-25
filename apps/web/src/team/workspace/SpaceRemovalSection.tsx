import { useId, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { navigateTo } from '../../lib/navigation';
import { teamResolverRoute } from '../routes';
import { useTeam } from '../TeamContext';
import { SpaceRemovalDialog, type SpaceRemovalClient } from '../lobby/SpaceRemovalDialog';
import { SettingsSection } from './SettingsSection';

/**
 * Deleting the space, at the end of its owner's General settings (2026-11-25) — where Linear,
 * Notion and GitHub keep it: last, quiet, and only for the person who can do it. The press opens
 * the same dialog the lobby card does, which decides between "hand it over first" and "delete".
 * Leaving stays under Members, beside the ownership transfer (024, FR-049).
 */
export function SpaceRemovalSection({
  teamId,
  client
}: {
  teamId: string;
  client: SpaceRemovalClient;
}) {
  const { t } = useI18n();
  const { teams, replaceTeams, refreshTeams, setActiveTeamId } = useTeam();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const space = teams.find(team => team.id === teamId) ?? null;
  if (!space || space.role !== 'owner') return null;

  return (
    <SettingsSection
      icon={Trash2}
      titleId={titleId}
      title={t('spaceRemovalSettingsTitle')}
      description={t('spaceRemovalSettingsBody')}
      className="space-removal-section"
    >
      <Button
        type="button"
        color="error"
        variant="outline"
        className="space-removal-start"
        onClick={() => setOpen(true)}
      >
        {t('spaceRemovalDeleteMenu')}
      </Button>
      {open && (
        <SpaceRemovalDialog
          space={space}
          client={client}
          onClose={() => setOpen(false)}
          onRemoved={() => {
            setOpen(false);
            setActiveTeamId(null);
            replaceTeams(teams.filter(team => team.id !== teamId));
            void refreshTeams();
            navigateTo(teamResolverRoute({ showAll: true }), true);
          }}
          onTransferred={() => {
            setOpen(false);
            void refreshTeams();
          }}
        />
      )}
    </SettingsSection>
  );
}
