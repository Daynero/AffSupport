import type { DragEvent, ReactNode } from 'react';
import type { LandingPreviewState } from '@video-compressor/shared';
import { Button } from '../components/ui';
import { useI18n } from '../i18n';
import { GalleryIconButton } from './internal/GalleryIconButton';

/**
 * Empty / no-active-catalogue state: drop zone + "open folder" + recent list. Presentational and
 * source-agnostic — the OS-only "open folder" button and per-row remove appear only when the
 * source supports them, and any extra sources (e.g. team spaces) render through `teamSources`.
 */
export function LandingViewerWelcome({
  state,
  dragging,
  message,
  canChooseFolder,
  chooseFolder,
  teamSources,
  canRemove,
  activate,
  remove,
  onDragEnter,
  onDragLeave,
  onDrop
}: {
  state: LandingPreviewState;
  dragging: boolean;
  message: string | null;
  canChooseFolder: boolean;
  chooseFolder: () => void;
  teamSources?: ReactNode;
  canRemove: boolean;
  activate: (id: string) => void;
  remove: (id: string) => void;
  onDragEnter: (event: DragEvent) => void;
  onDragLeave: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
}) {
  const { t } = useI18n();
  return (
    <main className="landing-gallery-welcome">
      <section
        className={`landing-gallery-drop-zone ${dragging ? 'is-dragging' : ''}`}
        onDragEnter={onDragEnter}
        onDragOver={event => event.preventDefault()}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span className="landing-gallery-welcome-icon" aria-hidden="true">
          ▱
        </span>
        <h1>{t('landingGalleryDropTitle')}</h1>
        <p>{t('landingGalleryDropHint')}</p>
        {canChooseFolder && (
          <Button variant="primary" onClick={chooseFolder}>
            {t('landingGalleryOpenFolder')}
          </Button>
        )}
        <small>{t('landingGalleryLocalNote')}</small>
        {teamSources}
      </section>
      {message && (
        <p className="landing-gallery-welcome-error" role="alert">
          {message}
        </p>
      )}
      {state.catalogs.length > 0 && (
        <section className="landing-gallery-recent-list">
          <h2>{t('landingGalleryRecent')}</h2>
          {state.catalogs.map(catalog => (
            <div
              key={catalog.id}
              className={`landing-gallery-recent-row ${catalog.sourceAvailable ? '' : 'is-unavailable'}`}
            >
              <button type="button" onClick={() => activate(catalog.id)}>
                <span>
                  <strong>{catalog.name}</strong>
                  <small>
                    {catalog.sourceAvailable
                      ? t('landingGalleryCount', { count: catalog.landingCount })
                      : t('landingGalleryUnavailable')}
                  </small>
                </span>
                <span aria-hidden="true">›</span>
              </button>
              {canRemove && (
                <GalleryIconButton
                  label={t('landingGalleryRemoveCatalog')}
                  onClick={() => remove(catalog.id)}
                >
                  🗑
                </GalleryIconButton>
              )}
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
