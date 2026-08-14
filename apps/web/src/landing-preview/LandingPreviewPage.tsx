import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/ui';
import { useI18n } from '../i18n';
import { analytics, trackTeamLandingRender } from '../analytics/service';
import { teamApi } from '../api/team';
import { landingGalleryOpenTeamSpace, renderTeamLanding } from '../api/client';
import { useOptionalTeam } from '../team/TeamContext';
import { agentLandingSource, LandingViewer, useLandingViewer } from '../landing-viewer';
import { buildTeamPreviewCatalogSnapshot } from './team-catalog';

/**
 * The standalone local landing previewer tool. It is now a thin composition over the reusable
 * `landing-viewer` engine: it wires the agent-backed source and layers on the agent-app-only team
 * bridge (import a connected space as a catalogue, create shared renders, `?team=` auto-open). The
 * viewer UI, viewport mechanics, and transport all live in `landing-viewer`.
 */
export default function LandingPreviewPage() {
  const { t } = useI18n();
  const team = useOptionalTeam();
  const source = useMemo(() => agentLandingSource(), []);
  const viewer = useLandingViewer({ source });
  const { pushState, setMessage, loaded, selected, activeCatalog } = viewer;

  const [openingTeamId, setOpeningTeamId] = useState<string | null>(null);
  const [renderingTeamMaterialId, setRenderingTeamMaterialId] = useState<string | null>(null);
  const autoOpenedTeam = useRef<string | null>(null);

  useEffect(() => {
    document.title = `${t('landingGallery')} — Soty`;
  }, [t]);

  useEffect(() => {
    analytics.track('tool_opened', { tool_identifier: 'landing-preview' });
  }, []);

  const openTeamSpace = useCallback(
    async (teamId: string) => {
      const selectedTeam = team?.teams.find(
        candidate => candidate.id === teamId && candidate.permissions.view
      );
      if (!selectedTeam || openingTeamId) return;
      setMessage(null);
      setOpeningTeamId(teamId);
      try {
        const snapshot = await buildTeamPreviewCatalogSnapshot({
          teamId,
          teamName: selectedTeam.name,
          client: teamApi
        });
        pushState(await landingGalleryOpenTeamSpace(snapshot));
      } catch {
        setMessage(t('landingGalleryTeamOpenFailed'));
      } finally {
        setOpeningTeamId(null);
      }
    },
    [openingTeamId, pushState, setMessage, t, team]
  );

  useEffect(() => {
    if (!loaded || team?.loading) return;
    const teamId = new URLSearchParams(window.location.search).get('team');
    if (!teamId || autoOpenedTeam.current === teamId) return;
    if (!team?.teams.some(candidate => candidate.id === teamId && candidate.permissions.view)) {
      return;
    }
    autoOpenedTeam.current = teamId;
    void openTeamSpace(teamId);
  }, [loaded, openTeamSpace, team]);

  const renderSelectedTeamLanding = useCallback(async () => {
    if (
      !selected ||
      selected.sourceKind !== 'team' ||
      !activeCatalog?.teamId ||
      renderingTeamMaterialId
    ) {
      return;
    }
    const startedAt = Date.now();
    setMessage(null);
    setRenderingTeamMaterialId(selected.sourceRelativePath);
    try {
      const job = await teamApi.startLandingRender(
        activeCatalog.teamId,
        selected.sourceRelativePath,
        'default'
      );
      await renderTeamLanding(job);
      trackTeamLandingRender({ outcome: 'ready', durationMs: Date.now() - startedAt });
      await openTeamSpace(activeCatalog.teamId);
    } catch {
      trackTeamLandingRender({ outcome: 'failed', durationMs: Date.now() - startedAt });
      setMessage(t('landingGalleryTeamRenderFailed'));
    } finally {
      setRenderingTeamMaterialId(null);
    }
  }, [activeCatalog, openTeamSpace, renderingTeamMaterialId, selected, setMessage, t]);

  const teams = team?.teams.filter(candidate => candidate.permissions.view) ?? [];
  const teamSources =
    teams.length > 0 ? (
      <div className="landing-gallery-team-sources">
        <span>{t('landingGalleryTeamSourceLabel')}</span>
        {teams.map(candidate => (
          <Button
            key={candidate.id}
            variant="secondary"
            disabled={openingTeamId !== null}
            onClick={() => void openTeamSpace(candidate.id)}
          >
            {openingTeamId === candidate.id
              ? t('landingGalleryTeamOpening')
              : t('landingGalleryOpenTeamSpace', { name: candidate.name })}
          </Button>
        ))}
      </div>
    ) : undefined;

  return (
    <LandingViewer
      viewer={viewer}
      teamSources={teamSources}
      openingTeam={openingTeamId !== null}
      onRefreshActiveTeamSpace={teamId => void openTeamSpace(teamId)}
      onCreateTeamPreview={() => void renderSelectedTeamLanding()}
      renderingTeamMaterialId={renderingTeamMaterialId}
    />
  );
}
