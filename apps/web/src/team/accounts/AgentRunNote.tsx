import { useRef, useState, type ReactNode } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import {
  TEAM_AGENT_RUN_MARKERS,
  type TeamAgentRun,
  type TeamAgentRunMarker
} from '@video-compressor/shared';
import { DropdownMenu, IconButton } from '../../components/ui/index';
import { ICON_STROKE } from '../../components/icons';
import { useI18n, type TranslationKey } from '../../i18n';
import { Marked } from './Marked';

const SMALL_ICON = 16;

/** What a run's marker is called, in the press's label and in its menu. */
export function markerLabelKey(marker: TeamAgentRunMarker | null): TranslationKey {
  if (marker === 'green') return 'teamAgentRunMarkerGreen';
  if (marker === 'amber') return 'teamAgentRunMarkerAmber';
  if (marker === 'red') return 'teamAgentRunMarkerRed';
  return 'teamAgentRunMarkerNone';
}

/** The marker as a dot: hollow when there is none, filled with its colour otherwise. */
function MarkerDot({ marker }: { marker: TeamAgentRunMarker | null }) {
  return (
    <span
      className={`team-accounts-marker-dot${marker ? ` is-${marker}` : ' is-none'}`}
      aria-hidden="true"
    />
  );
}

/**
 * A note written on an agent by hand (017's "runs") — one line in the Launch column.
 *
 * The owner, beta 25.11: "What is this? Launches? Why can't I delete it? I click and only the
 * colour changes." The whole line was a hidden button that cycled the colour, it looked like the
 * real launches above it, and edit and delete lived only in the agent's "…". So the line is now
 * plainly a note: the colour is a dot at its start — a control of its own, with a hint and a menu
 * of the four colours — the text is just text, and the note's own "Edit" and "Delete" sit at its
 * end on hover and focus (and stay in the agent's "…"). A real launch on the same agent reads
 * differently: a rocket where the dot is, and a link (`AccountLinkedLaunchRow`).
 */
export function AgentRunNote({
  run,
  canEdit,
  search = '',
  disabled = false,
  busy = false,
  age,
  onSetMarker,
  onEdit,
  onDelete
}: {
  run: TeamAgentRun;
  canEdit: boolean;
  search?: string;
  /** A note of the row is open in its editor. */
  disabled?: boolean;
  /**
   * A write on the row is in flight. The colour dot stays focusable through it — the menu hands
   * focus back to the dot just as the write starts, and a disabled button cannot take it — and
   * only refuses the press.
   */
  busy?: boolean;
  /** When the note was written, drawn by the row. */
  age?: ReactNode;
  onSetMarker: (marker: TeamAgentRunMarker | null) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const dot = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const markerName = t(markerLabelKey(run.marker));
  const choices: readonly (TeamAgentRunMarker | null)[] = [null, ...TEAM_AGENT_RUN_MARKERS];

  return (
    <div
      className={`team-agent-run is-note${run.marker ? ` is-marked is-${run.marker}` : ''}`}
      data-run-id={run.id}
      data-marker={run.marker ?? 'none'}
    >
      {canEdit ? (
        <>
          <IconButton
            ref={dot}
            size="xs"
            className="team-agent-note-marker"
            label={`${t('teamAgentRunMark')}: ${run.note} · ${markerName}`}
            title={t('teamAgentNoteMarkerHint', { marker: markerName })}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-disabled={busy || undefined}
            disabled={disabled}
            onClick={() => {
              if (!busy) setMenuOpen(value => !value);
            }}
          >
            <MarkerDot marker={run.marker} />
          </IconButton>
          <DropdownMenu
            open={menuOpen}
            onClose={() => {
              setMenuOpen(false);
              requestAnimationFrame(() => dot.current?.focus());
            }}
            anchor={dot}
            placement="bottom-start"
            label={`${t('teamAgentRunMark')}: ${run.note}`}
            items={choices.map(marker => ({
              id: `marker:${marker ?? 'none'}`,
              label: t(markerLabelKey(marker)),
              icon: <MarkerDot marker={marker} />,
              checked: run.marker === marker,
              onSelect: () => {
                if (run.marker !== marker) onSetMarker(marker);
              }
            }))}
          />
        </>
      ) : (
        <span className="team-agent-note-marker is-static" title={markerName}>
          <MarkerDot marker={run.marker} />
        </span>
      )}
      <span className="team-agent-run-text" title={`${t('teamAgentNoteKind')}: ${run.note}`}>
        <Marked text={run.note} term={search} />
      </span>
      {age}
      {canEdit && (
        <span className="team-agent-run-actions">
          <IconButton
            size="xs"
            className="team-agent-action is-small"
            label={`${t('teamAgentRunEdit')}: ${run.note}`}
            title={t('teamAgentRunEdit')}
            disabled={disabled || busy}
            onClick={onEdit}
          >
            <Pencil size={SMALL_ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
          <IconButton
            size="xs"
            className="team-agent-action is-small is-danger"
            label={`${t('teamAgentRunDelete')}: ${run.note}`}
            title={t('teamAgentRunDelete')}
            disabled={disabled || busy}
            onClick={onDelete}
          >
            <Trash2 size={SMALL_ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        </span>
      )}
    </div>
  );
}
