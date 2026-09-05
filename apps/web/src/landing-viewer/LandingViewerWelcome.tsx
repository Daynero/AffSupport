import type { ReactNode } from 'react';
import { ChevronRight, Folder, History, Trash2, Users } from 'lucide-react';
import type { LandingPreviewState } from '@video-compressor/shared';
import { DropZone } from '../components/DropZone';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useI18n } from '../i18n';
import { GalleryIconButton } from './internal/GalleryIconButton';

/**
 * The tool before a folder is open: the compressor's drop zone, then the folders opened
 * before and, in the local app, the connected team spaces. Presentational — the OS-only
 * picker and per-row removal appear only when the source supports them.
 */
export function LandingViewerWelcome({
  state,
  message,
  canChooseFolder,
  chooseFolder,
  onDropData,
  teamSources,
  canRemove,
  activate,
  remove
}: {
  state: LandingPreviewState;
  message: string | null;
  canChooseFolder: boolean;
  chooseFolder: () => void;
  onDropData: (data: DataTransfer) => void;
  teamSources?: ReactNode;
  canRemove: boolean;
  activate: (id: string) => void;
  remove: (id: string) => void;
}) {
  const { t } = useI18n();
  const recent = state.catalogs.filter(catalog => catalog.sourceKind !== 'team');
  const team = state.catalogs.filter(catalog => catalog.sourceKind === 'team');
  return (
    <main className="workspace lv-welcome">
      <section className="add-files-section" aria-label={t('landingGalleryDropTitle')}>
        <DropZone
          disabled={!canChooseFolder}
          importing={false}
          chooseFiles={chooseFolder}
          addDroppedFiles={() => {}}
          onDropData={onDropData}
          title={t('landingGalleryDropTitle')}
          formats={t('landingGalleryDropFormats')}
          activeLabel={t('landingGalleryDropActive')}
          secondaryAction={
            canChooseFolder
              ? { label: t('landingGalleryOpenFolder'), run: chooseFolder }
              : undefined
          }
          t={t}
        />
      </section>
      {message && (
        <p className="lv-welcome-error" role="alert">
          {message}
        </p>
      )}
      {(recent.length > 0 || team.length > 0 || teamSources) && (
        <div className="lv-sources">
          {recent.length > 0 && (
            <section className="lv-source-card" aria-labelledby="lv-recent-title">
              <h2 id="lv-recent-title">
                <History size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                {t('landingGalleryRecent')}
              </h2>
              <p>{t('landingGalleryRecentBody')}</p>
              <RecentList
                catalogs={recent}
                canRemove={canRemove}
                activate={activate}
                remove={remove}
              />
            </section>
          )}
          {(team.length > 0 || teamSources) && (
            <section className="lv-source-card" aria-labelledby="lv-team-title">
              <h2 id="lv-team-title">
                <Users size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                {t('landingGalleryTeamSourceLabel')}
              </h2>
              <p>{t('landingGalleryTeamCardBody')}</p>
              {team.length > 0 && (
                <RecentList
                  catalogs={team}
                  canRemove={canRemove}
                  activate={activate}
                  remove={remove}
                />
              )}
              {teamSources}
            </section>
          )}
        </div>
      )}
      <p className="lv-welcome-note">{t('landingGalleryLocalNote')}</p>
    </main>
  );
}

function RecentList({
  catalogs,
  canRemove,
  activate,
  remove
}: {
  catalogs: LandingPreviewState['catalogs'];
  canRemove: boolean;
  activate: (id: string) => void;
  remove: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="lv-recent-list">
      {catalogs.map(catalog => {
        const Icon = catalog.sourceKind === 'team' ? Users : Folder;
        return (
          <div
            key={catalog.id}
            className={`lv-recent-row ${catalog.sourceAvailable ? '' : 'is-unavailable'}`.trim()}
          >
            <button type="button" onClick={() => activate(catalog.id)}>
              <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              <span className="lv-recent-row-copy">
                <strong>{catalog.name}</strong>
                <small>
                  {catalog.sourceAvailable
                    ? t('landingGalleryCount', { count: catalog.landingCount })
                    : t('landingGalleryUnavailable')}
                </small>
              </span>
              <ChevronRight size={18} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
            {canRemove && (
              <GalleryIconButton
                label={t('landingGalleryRemoveCatalog')}
                onClick={() => remove(catalog.id)}
              >
                <Trash2 size={18} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </GalleryIconButton>
            )}
          </div>
        );
      })}
    </div>
  );
}
