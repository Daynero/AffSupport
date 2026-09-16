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
import { Popover } from '../../components/ui/index';

export const COLOR_LABEL: Record<TeamMaterialTagColor, TranslationKey> = {
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

  const label = color ? t(COLOR_LABEL[color]) : t('teamTagNone');

  /*
   * Press, slide, release (the owner, 024): holding the dot opens the colours at once, and letting
   * go over one chooses it — the way a macOS pop-up menu is used in a single gesture. A plain
   * click still opens the menu and leaves it open; the keyboard is unchanged.
   */
  const pressed = useRef(false);
  const [aimed, setAimed] = useState<string | null>(null);
  const swatchAt = (x: number, y: number) => {
    const target = document.elementFromPoint(x, y);
    const swatch =
      target instanceof HTMLElement ? target.closest<HTMLButtonElement>('.team-tag-swatch') : null;
    return swatch && !swatch.disabled && root.current?.ownerDocument.contains(swatch)
      ? swatch
      : null;
  };
  useEffect(() => {
    if (!open) return;
    const move = (event: PointerEvent) => {
      if (!pressed.current) return;
      setAimed(swatchAt(event.clientX, event.clientY)?.dataset.swatch ?? null);
    };
    const release = (event: PointerEvent) => {
      if (!pressed.current) return;
      setAimed(null);
      const swatch = swatchAt(event.clientX, event.clientY);
      if (swatch) {
        pressed.current = false;
        swatch.click();
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', release);
    return () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', release);
    };
  }, [open]);

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
        onPointerDown={event => {
          if (event.button !== 0 || open) return;
          // Touch captures the pointer to the dot; release it so the colours can be reached.
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          pressed.current = true;
          setOpen(true);
        }}
        onClick={() => {
          // Already opened by the press that ended in this click.
          if (pressed.current) {
            pressed.current = false;
            return;
          }
          setOpen(value => !value);
        }}
      />
      <Popover
        open={open}
        onClose={() => {
          pressed.current = false;
          setOpen(false);
          trigger.current?.focus();
        }}
        anchor={root}
        placement="bottom-start"
        frequent
        label={t('teamTagPick')}
        surface="none"
        className="team-tag-menu"
      >
        <div className="team-tag-menu-items" role="menu" aria-label={t('teamTagPick')}>
          <div className="team-tag-swatches">
            {TEAM_MATERIAL_TAG_COLORS.map(option => (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={color === option}
                data-swatch={option}
                className={`team-tag-swatch is-${option}${color === option ? ' is-active' : ''}${aimed === option ? ' is-aimed' : ''}`}
                aria-label={t(COLOR_LABEL[option])}
                onClick={() => {
                  // Pressing the colour a file already has takes it off, the
                  // way Finder's own tag does.
                  onChange(color === option ? null : option);
                  setOpen(false);
                }}
              />
            ))}
            {/* "No marker" as one more swatch — an empty circle struck through, the
                way design tools say "no fill" — rather than a line of text under the
                colours (the owner, 024). Named, and titled for the pointer. */}
            <button
              type="button"
              role="menuitem"
              data-swatch="clear"
              className={`team-tag-swatch is-clear${aimed === 'clear' ? ' is-aimed' : ''}`}
              disabled={color === null}
              aria-label={t('teamTagClear')}
              title={t('teamTagClear')}
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            />
          </div>
        </div>
      </Popover>
    </div>
  );
}
