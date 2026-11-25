/**
 * What a clip of the re-stitch timeline opens (071): its switch, its pictures and its length.
 *
 * One panel under the strip rather than two columns beside each other — the strip already shows
 * both ends, so the panel only needs to say more about the one that was picked, the way an
 * editor's inspector follows the selected clip.
 */

import { useEffect, useState } from 'react';
import { Image as ImageIcon, Timer } from 'lucide-react';
import type {
  RestitchPoolSummary,
  RestitchSlot,
  RestitchSourceInput
} from '@video-compressor/shared';
import { ICON_SIZE, ICON_STROKE } from '../../../components/icons';
import { Collapse, Input, RadioGroup, Switch } from '../../../components/ui/index';
import { parseMillisecondsInput } from '../../../components/ImageEmbeddingSection';
import { useI18n } from '../../../i18n';
import { RestitchSourcePool, type RestitchSourcePoolClient } from '../RestitchSourcePool';
import { BUILTIN_PICTURES, builtinSlot, type RestitchForm } from './restitch-form';

export function RestitchSlotPanel({
  teamId,
  slot,
  form,
  onForm,
  formEditable,
  pool,
  poolsEditable,
  poolClient,
  onPoolChange,
  thumbnailFor
}: {
  teamId: string;
  slot: RestitchSlot;
  form: RestitchForm;
  onForm: (next: RestitchForm) => void;
  formEditable: boolean;
  pool: RestitchPoolSummary | null;
  poolsEditable: boolean;
  poolClient?: RestitchSourcePoolClient;
  onPoolChange: (slot: RestitchSlot, items: RestitchSourceInput[]) => void;
  thumbnailFor?: (materialId: string) => string | null;
}) {
  const { t } = useI18n();
  const enabled = slot === 'start' ? form.startEnabled : form.endEnabled;
  const builtin = builtinSlot(enabled, pool);

  return (
    <section
      className={`team-restitch-slot team-restitch-slot-${slot}${enabled ? '' : ' is-off'}`}
      aria-labelledby={`team-restitch-slot-${slot}`}
    >
      {/* The name the strip uses, and the same switch it carries. */}
      <div className="team-restitch-slot-head">
        <h3 id={`team-restitch-slot-${slot}`}>
          {t(slot === 'start' ? 'teamRestitchPartStart' : 'teamRestitchPartEnd')}
        </h3>
        <Switch
          className="feature-switch"
          checked={enabled}
          disabled={!formEditable}
          onChange={next =>
            onForm(
              slot === 'start' ? { ...form, startEnabled: next } : { ...form, endEnabled: next }
            )
          }
          label={t(slot === 'start' ? 'teamRestitchStartSwitch' : 'teamRestitchEndSwitch')}
        />
      </div>
      <span className="team-restitch-hint">
        {enabled
          ? t(slot === 'start' ? 'teamRestitchStartHint' : 'teamRestitchEndHint')
          : t(slot === 'start' ? 'teamRestitchStartOffHint' : 'teamRestitchEndOffHint')}
      </span>
      <Collapse open={enabled}>
        <div className="team-restitch-slot-body">
          {pool && (
            <RestitchSourcePool
              teamId={teamId}
              slot={slot}
              pool={pool}
              editable={poolsEditable}
              client={poolClient}
              onChange={onPoolChange}
              thumbnailFor={thumbnailFor}
              builtin={
                builtin
                  ? { picture: BUILTIN_PICTURES[slot], label: t('teamRestitchBuiltinName') }
                  : null
              }
            />
          )}
          {/* The final picture's length is the strip's own slider; only the start's is here. */}
          {slot === 'start' && <StartLength form={form} onForm={onForm} disabled={!formEditable} />}
        </div>
      </Collapse>
    </section>
  );
}

/** One frame, or a length in milliseconds — the stitcher's own control, unchanged. */
function StartLength({
  form,
  onForm,
  disabled
}: {
  form: RestitchForm;
  onForm: (next: RestitchForm) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(String(form.customStartDurationMs));
  useEffect(() => setText(String(form.customStartDurationMs)), [form.customStartDurationMs]);
  const valid = parseMillisecondsInput(text) !== null;
  const custom = form.startDurationMode !== 'one-frame';
  return (
    <div className="field-group team-restitch-length">
      <div className="field-label">
        <span>{t('teamRestitchDurationLabel')}</span>
      </div>
      <div className="start-duration-row">
        <RadioGroup
          className="fit-mode-pictos"
          variant="pictos"
          label={t('startImageDuration')}
          value={custom ? 'custom' : 'one-frame'}
          disabled={disabled}
          onChange={mode => onForm({ ...form, startDurationMode: mode })}
          options={[
            {
              value: 'one-frame',
              label: t('startDurationOneFrame'),
              icon: <ImageIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            },
            {
              value: 'custom',
              label: t('customDuration'),
              icon: <Timer size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            }
          ]}
        />
        {custom && (
          <Input
            className="custom-duration-input"
            width="narrow"
            size="sm"
            suffix={t('millisecondsUnit')}
            type="text"
            inputMode="numeric"
            placeholder="100"
            value={text}
            disabled={disabled}
            aria-label={t('customStartDurationInput')}
            invalid={Boolean(text) && !valid}
            onChange={event => {
              setText(event.target.value);
              const ms = parseMillisecondsInput(event.target.value);
              if (ms !== null) onForm({ ...form, customStartDurationMs: ms });
            }}
          />
        )}
      </div>
      <Collapse open={custom && Boolean(text) && !valid}>
        <span className="soty-field-error">{t('invalidCustomStartDuration')}</span>
      </Collapse>
    </div>
  );
}
