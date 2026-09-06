/**
 * A file's tag (011): Finder's coloured dot, beside the size.
 *
 * Deliberately Finder's, because that is where everyone already reads this:
 * seven colours, one per file, no vocabulary to learn, and the meaning stays
 * the team's own — the product never says what red is for.
 *
 * Who may set one is the whole design of this component. A tag is a shared
 * judgement about a file, and a space where everyone re-colours everyone
 * else's files is worse than a space with no tags, so setting one is the
 * owner's alone. For everyone else the dot is not a disabled button — it is
 * not a button at all: a control that cannot be pressed still says "you could
 * press this", and this one cannot. Untagged, it is simply not there for them,
 * because a row of empty outlines down a column reads as work waiting to be
 * done by someone who cannot do it.
 */

import { useEffect, useRef, useState } from 'react';
import { TEAM_MATERIAL_TAG_COLORS, type TeamMaterialTagColor } from '@video-compressor/shared';
import { useI18n, type TranslationKey } from '../../i18n';

const COLOR_LABEL: Record<TeamMaterialTagColor, TranslationKey> = {
  red: 'teamTagRed',
  orange: 'teamTagOrange',
  yellow: 'teamTagYellow',
  green: 'teamTagGreen',
  blue: 'teamTagBlue',
  purple: 'teamTagPurple',
  grey: 'teamTagGrey'
};

export function TagDot({
  color,
  name,
  canTag,
  onChange
}: {
  color: TeamMaterialTagColor | null;
  /** The file the tag belongs to, for the control's accessible name. */
  name: string;
  /** Only the space's owner may change a tag; everyone else reads it. */
  canTag: boolean;
  onChange: (color: TeamMaterialTagColor | null) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const label = color ? t(COLOR_LABEL[color]) : t('teamTagNone');

  if (!canTag) {
    // Nothing at all rather than an empty ring: an untagged file has nothing
    // to say to a reader who cannot tag it.
    if (!color) return null;
    return (
      <span
        className={`team-tag-dot is-${color}`}
        aria-label={t('teamTagOf', { name, tag: label })}
        role="img"
      />
    );
  }

  return (
    <div
      className="team-tag"
      ref={root}
      /* The row underneath opens a preview and the grid selects; a press meant
         for the tag is not either of those. */
      onClick={event => event.stopPropagation()}
    >
      <button
        ref={trigger}
        type="button"
        className={`team-tag-dot is-button${color ? ` is-${color}` : ' is-none'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('teamTagOf', { name, tag: label })}
        onClick={() => setOpen(value => !value)}
      />
      {open && (
        <div className="team-tag-menu" role="menu" aria-label={t('teamTagPick')}>
          <div className="team-tag-swatches">
            {TEAM_MATERIAL_TAG_COLORS.map(option => (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={color === option}
                className={`team-tag-swatch is-${option}${color === option ? ' is-active' : ''}`}
                aria-label={t(COLOR_LABEL[option])}
                onClick={() => {
                  // Pressing the colour a file already has takes it off, the
                  // way Finder's own tag does.
                  onChange(color === option ? null : option);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <button
            type="button"
            role="menuitem"
            className="team-tag-clear"
            disabled={color === null}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            {t('teamTagClear')}
          </button>
        </div>
      )}
    </div>
  );
}
