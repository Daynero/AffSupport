import type { TeamMaterialProvenanceEntry } from '@video-compressor/shared';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';

export function ProvenancePanel({
  materialId,
  entries,
  inheritedMetadata,
  onNavigate
}: {
  materialId: string;
  entries: TeamMaterialProvenanceEntry[];
  inheritedMetadata?: {
    geo: string | null;
    language: string | null;
    offer: string | null;
    tags: string[];
  } | null;
  onNavigate: (materialId: string) => void;
}) {
  const { t } = useI18n();
  if (!entries.length) return null;
  return (
    <section className="team-provenance" aria-labelledby="team-provenance-title">
      <h3 id="team-provenance-title">{t('teamProvenanceTitle')}</h3>
      {inheritedMetadata && (
        <p className="team-provenance-inherited">
          <strong>{t('teamProvenanceInherited')}:</strong>{' '}
          {[
            inheritedMetadata.geo,
            inheritedMetadata.language,
            inheritedMetadata.offer,
            ...inheritedMetadata.tags
          ]
            .filter(Boolean)
            .join(' · ') || t('teamCatalogUnfilled')}
        </p>
      )}
      <ul>
        {entries.map((entry, index) => {
          const firstSource =
            entries.findIndex(
              candidate => candidate.sourceMaterialId === entry.sourceMaterialId
            ) === index;
          const materialIsSource = materialId === entry.sourceMaterialId;
          return (
            <li key={entry.linkId}>
              <span className="team-provenance-relation">
                {entry.relation === 'version_of'
                  ? t('teamProvenanceVersionBranch')
                  : t('teamProvenanceProcessedFrom')}
              </span>
              <strong>{entry.sourceNameSnapshot}</strong>
              {firstSource && entry.sourceName !== entry.sourceNameSnapshot && (
                <small>{t('teamProvenanceCurrentName', { name: entry.sourceName })}</small>
              )}
              {firstSource && (
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={t('teamProvenanceOpenSource', {
                    name: entry.sourceNameSnapshot
                  })}
                  onClick={() => onNavigate(entry.sourceMaterialId)}
                >
                  {t('teamProvenanceOpen')}
                </Button>
              )}
              {!materialIsSource && entry.derivativeMaterialId !== materialId && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onNavigate(entry.derivativeMaterialId)}
                >
                  {entry.derivativeName}
                </Button>
              )}
              {entry.toolId && (
                <small>
                  {entry.toolId} · v{entry.toolContractVersion ?? '—'}
                </small>
              )}
              {entry.sourceLifecycle !== 'active' && (
                <small>{t('teamProvenanceSourceUnavailable')}</small>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
