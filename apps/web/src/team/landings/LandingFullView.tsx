import { useEffect, useState, type CSSProperties } from 'react';
import {
  DEFAULT_LANDING_VIEWER_PRESET,
  normalizeLandingViewerPreset,
  type CatalogMaterialItem,
  type LandingViewerPreset,
  type RenderArtifactRef
} from '@video-compressor/shared';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { MaterialPreview, type MaterialPreviewClient } from '../preview/MaterialPreview';
import { LandingViewerControls } from './LandingViewerControls';
import { LANDING_VIEWER_PRESET_STORAGE_KEY } from './index';
import { Modal } from '../../components/Modal';

function storedPreset(): LandingViewerPreset {
  if (typeof window === 'undefined') return { ...DEFAULT_LANDING_VIEWER_PRESET };
  try {
    const stored = window.localStorage.getItem(LANDING_VIEWER_PRESET_STORAGE_KEY);
    return normalizeLandingViewerPreset(stored ? JSON.parse(stored) : null);
  } catch {
    return { ...DEFAULT_LANDING_VIEWER_PRESET };
  }
}

/** Full team landing viewer: the existing safe preview composed with shared viewer controls. */
export function LandingFullView({
  teamId,
  material,
  client,
  artifact,
  artifactClient,
  onClose
}: {
  teamId: string;
  material: CatalogMaterialItem;
  client?: MaterialPreviewClient;
  artifact?: RenderArtifactRef;
  artifactClient?: {
    getLandingRenderArtifact: (
      teamId: string,
      materialId: string,
      preset: string
    ) => Promise<RenderArtifactRef | null>;
    landingRenderImageUrl: (artifact: RenderArtifactRef, segment: number) => string;
  };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [preset, setPreset] = useState(storedPreset);
  const [cachedArtifact, setCachedArtifact] = useState<RenderArtifactRef | null>(null);
  const [cachedError, setCachedError] = useState(false);
  const updatePreset = (next: LandingViewerPreset) => {
    setPreset(next);
    window.localStorage.setItem(LANDING_VIEWER_PRESET_STORAGE_KEY, JSON.stringify(next));
  };

  useEffect(() => {
    let active = true;
    if (!artifact || !artifactClient) return;
    setCachedArtifact(null);
    setCachedError(false);
    void artifactClient
      .getLandingRenderArtifact(teamId, material.id, artifact.preset)
      .then(value => {
        if (!active) return;
        if (!value?.segmentTokens) setCachedError(true);
        else setCachedArtifact(value);
      })
      .catch(() => {
        if (active) setCachedError(true);
      });
    return () => {
      active = false;
    };
  }, [artifact, artifactClient, material.id, teamId]);

  if (artifact && artifactClient) {
    return (
      /* Same primitive as every other dialog — see MaterialPreview. */
      <Modal
        labelledBy="team-preview-title"
        bare
        backdropClassName="team-preview-backdrop"
        className="team-preview-dialog landing-full-view"
        onClose={onClose}
        data={{
          'data-landing-device': preset.device,
          'data-landing-scheme': preset.colorScheme,
          'data-landing-zoom': String(preset.zoom)
        }}
      >
        <header className="team-preview-heading">
          <div>
            <p>{t('teamPreviewEyebrow')}</p>
            <h2 id="team-preview-title">{material.name}</h2>
          </div>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('teamPreviewClose')}
          </Button>
        </header>
        <div className="landing-full-view-toolbar">
          <LandingViewerControls preset={preset} onChange={updatePreset} />
        </div>
        <div className="team-preview-content">
          {!cachedArtifact && !cachedError && <p aria-live="polite">{t('teamPreviewLoading')}</p>}
          {cachedError && (
            <p className="team-inline-error" role="alert">
              {t('teamLandingNeedsRerender')}
            </p>
          )}
          {cachedArtifact?.segmentTokens && (
            <div
              className="team-landing-preview team-landing-cached"
              style={{ '--landing-viewer-zoom': String(preset.zoom) } as CSSProperties}
            >
              {cachedArtifact.segmentTokens.map((_, segment) => (
                <img
                  loading="lazy"
                  decoding="async"
                  key={segment}
                  src={artifactClient.landingRenderImageUrl(cachedArtifact, segment)}
                  alt={segment === 0 ? material.name : ''}
                  referrerPolicy="no-referrer"
                />
              ))}
            </div>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <MaterialPreview
      teamId={teamId}
      material={material}
      client={client}
      landingPreset={preset}
      toolbar={<LandingViewerControls preset={preset} onChange={updatePreset} />}
      onClose={onClose}
    />
  );
}
