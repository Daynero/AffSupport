import type { TeamMaterialRowKind } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { KIND_LABEL } from './rowKinds';

/**
 * One-click kind filters (011, FR-023). Folders are never filtered out — they
 * are how you get anywhere — so the chips name the file kinds only.
 */
const CHIP_KINDS: TeamMaterialRowKind[] = [
  'landing',
  'image',
  'video',
  'transcript',
  'archive',
  'other'
];

export function KindFilterBar({
  kinds,
  onChange
}: {
  kinds: TeamMaterialRowKind[];
  onChange: (kinds: TeamMaterialRowKind[]) => void;
}) {
  const { t } = useI18n();
  const toggle = (kind: TeamMaterialRowKind) =>
    onChange(kinds.includes(kind) ? kinds.filter(item => item !== kind) : [...kinds, kind]);
  return (
    <div className="team-explorer-kinds" role="group" aria-label={t('teamExplorerKindsLabel')}>
      <button
        type="button"
        className="team-explorer-kind-chip"
        aria-pressed={kinds.length === 0}
        onClick={() => onChange([])}
      >
        {t('teamExplorerKindAll')}
      </button>
      {CHIP_KINDS.map(kind => (
        <button
          key={kind}
          type="button"
          className="team-explorer-kind-chip"
          aria-pressed={kinds.includes(kind)}
          onClick={() => toggle(kind)}
        >
          {t(KIND_LABEL[kind])}
        </button>
      ))}
    </div>
  );
}
