import { useI18n, type TranslationKey } from '../i18n';

/**
 * A loading placeholder that says what it is loading.
 *
 * The contract bans a bare "…" (contracts/ui-conventions.md): an ellipsis on
 * its own is indistinguishable from a stuck screen, an empty list, and a failed
 * request. The caption is the accessible text; the shimmering bars are
 * decoration and are hidden from the accessibility tree.
 */
export function LabeledSkeleton({
  label,
  rows = 3
}: {
  label: TranslationKey;
  /** How many placeholder bars to draw. Purely visual. */
  rows?: number;
}) {
  const { t } = useI18n();
  return (
    <div className="ui-skeleton-list">
      <p className="ui-skeleton-label" aria-live="polite">
        {t(label)}
      </p>
      <div className="ui-skeleton-rows" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <span key={index} className="skeleton ui-skeleton-row" />
        ))}
      </div>
    </div>
  );
}
