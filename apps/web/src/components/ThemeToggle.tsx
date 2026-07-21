import { useId } from 'react';
import { useI18n } from '../i18n';
import { useTheme } from '../lib/theme';

const RAY_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];
const STARS = [
  { cx: 17.6, cy: 6.6, r: 0.9, delay: 0 },
  { cx: 19.6, cy: 12, r: 0.7, delay: 0.35 },
  { cx: 13.6, cy: 18.8, r: 0.8, delay: 0.7 }
];

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, toggleTheme } = useTheme();
  const { t } = useI18n();
  const isDark = theme === 'dark';
  const maskId = useId();

  return (
    <button
      type="button"
      className={`theme-toggle ${compact ? 'theme-toggle-compact' : ''}`}
      onClick={event => toggleTheme({ x: event.clientX, y: event.clientY })}
      aria-label={isDark ? t('themeToLight') : t('themeToDark')}
      aria-pressed={isDark}
      title={isDark ? t('themeToLight') : t('themeToDark')}
    >
      <span className="theme-toggle__halo" aria-hidden="true" />
      <svg
        className="theme-toggle__icon"
        viewBox="0 0 24 24"
        width="20"
        height="20"
        aria-hidden="true"
      >
        <defs>
          <mask id={maskId}>
            <rect x="0" y="0" width="24" height="24" fill="#fff" />
            <circle className="theme-toggle__cutter" cx="24" cy="4" r="7" fill="#000" />
          </mask>
        </defs>
        <g
          className="theme-toggle__rays"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          {RAY_ANGLES.map(angle => (
            <line
              key={angle}
              x1="12"
              y1="12"
              x2="12"
              y2="1.5"
              transform={`rotate(${angle} 12 12)`}
            />
          ))}
        </g>
        <circle
          className="theme-toggle__core"
          cx="12"
          cy="12"
          r="5.6"
          fill="currentColor"
          mask={`url(#${maskId})`}
        />
        <g className="theme-toggle__stars" fill="currentColor">
          {STARS.map(star => (
            <circle
              key={`${star.cx}-${star.cy}`}
              cx={star.cx}
              cy={star.cy}
              r={star.r}
              style={{ '--star-delay': `${star.delay}s` } as React.CSSProperties}
            />
          ))}
        </g>
      </svg>
    </button>
  );
}
