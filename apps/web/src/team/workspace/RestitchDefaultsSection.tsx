/**
 * The space's one answer for re-stitching.
 *
 * Deliberately not a new screen full of new controls: it mounts the tool's own — the operation
 * row, the two photo galleries with their enable/disable behaviour, the fit mode and the hold
 * ranges — so a member who has used the stitcher already knows this. What is added here is the
 * three things that only make sense for a space: whether it is set up at all, where its
 * downloads land, and the button that prepares its material.
 *
 * The photos live on the agent, as they always have. This records *which of them may be
 * drawn* — ids, never images — so a space's defaults survive a member changing their own
 * library, and so two members with the same space draw from the same set.
 */

import { useCallback, useEffect, useState } from 'react';
import { Eraser, Plus, Replace } from 'lucide-react';
import type {
  AgentSettings,
  ImageEmbeddingSettingsPatch,
  ImageSlot,
  StitchOperation,
  TeamRestitchDefaults
} from '@video-compressor/shared';
import { ImageEmbeddingSection } from '../../components/ImageEmbeddingSection';
import { Button } from '../../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { useTeam } from '../TeamContext';
import { teamErrorMessageFor } from '../errors';
import {
  fetchCompressorState,
  removeScreenImage,
  updateCompressorSettings,
  uploadScreenImage
} from '../../stitcher/api';
import { useOptionalAgent } from '../../AgentContext';
import { analytics } from '../../analytics/service';
import {
  useRestitchPreparation,
  type RestitchPreparationState
} from '../restitch/useRestitchPreparation';

export interface RestitchDefaultsClient {
  getRestitchDefaults: (teamId: string) => Promise<TeamRestitchDefaults | null>;
  setRestitchDefaults: (
    teamId: string,
    defaults: Pick<
      TeamRestitchDefaults,
      | 'operation'
      | 'startImageIds'
      | 'endImageIds'
      | 'fitMode'
      | 'finalDurationMode'
      | 'customFinalDurationSeconds'
    >
  ) => Promise<TeamRestitchDefaults>;
}

/** The tool's own labels for the hold ranges, so the summary reads like the control does. */
const HOLD_KEYS = {
  'random-30-40': 'randomDuration30To40',
  'random-40-50': 'randomDuration40To50',
  'random-50-60': 'randomDuration50To60',
  custom: 'stitcherEndDurationFixed'
} as const;

const OPERATION_KEYS = {
  restitch: 'stitcherOpRestitch',
  stitch: 'stitcherOpStitch',
  unstitch: 'stitcherOpUnstitch'
} as const;

/** What the space will draw from: everything in the library that is not switched off. */
function enabledIds(images: { id: string }[], disabled: readonly string[]): string[] {
  return images.filter(image => !disabled.includes(image.id)).map(image => image.id);
}

export function RestitchDefaultsSection({
  teamId,
  client
}: {
  teamId: string;
  client: RestitchDefaultsClient;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { activeTeam, can } = useTeam();
  const agent = useOptionalAgent();
  const connected = agent?.connection === 'connected';
  const editable = can('manage_metadata');

  const [defaults, setDefaults] = useState<TeamRestitchDefaults | null>(null);
  const [operation, setOperation] = useState<StitchOperation>('restitch');
  const [compressor, setCompressor] = useState<AgentSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const preparation = useRestitchPreparation(teamId);
  // Preparation touches the space's drive; without one there is nothing to prepare, and the
  // way forward is the connection panel one section down rather than a button that would fail.
  const driveConnected = activeTeam?.connectionState === 'connected';

  useEffect(() => {
    let active = true;
    void client
      .getRestitchDefaults(teamId)
      .then(found => {
        if (!active) return;
        setDefaults(found);
        if (found) setOperation(found.operation);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [teamId, client]);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    void fetchCompressorState()
      .then(queue => {
        if (active) setCompressor(queue.settings);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [connected]);

  const updateEmbedding = useCallback((patch: ImageEmbeddingSettingsPatch) => {
    void updateCompressorSettings({ imageEmbedding: patch })
      .then(queue => setCompressor(queue.settings))
      .catch(() => {});
  }, []);

  const uploadImages = useCallback(async (slot: ImageSlot, files: File[]) => {
    for (const file of files) setCompressor((await uploadScreenImage(slot, file)).settings);
  }, []);

  const removeImage = useCallback(async (slot: ImageSlot, id: string) => {
    setCompressor((await removeScreenImage(slot, id)).settings);
  }, []);

  const save = async () => {
    const embedding = compressor?.imageEmbedding;
    if (!embedding) return;
    setSaving(true);
    try {
      const stored = await client.setRestitchDefaults(teamId, {
        operation,
        // A snapshot of what is switched on right now — the galleries above are the library,
        // and this is the space saying which of it to draw from.
        startImageIds: enabledIds(embedding.startImages, embedding.disabledImageIds),
        endImageIds: enabledIds(embedding.endImages, embedding.disabledImageIds),
        fitMode: embedding.fitMode,
        finalDurationMode: embedding.finalDurationMode,
        customFinalDurationSeconds: embedding.customFinalDurationSeconds
      });
      setDefaults(stored);
      // Which operation a space settles on, and how many photos it draws from — no ids, no
      // names, nothing about the space itself.
      analytics.track('setting_changed', {
        setting_name: 'team_restitch_defaults',
        setting_value: stored.operation,
        file_count: stored.startImageIds.length + stored.endImageIds.length
      });
      push({ tone: 'success', text: t('teamRestitchSaved') });
    } catch (error) {
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      setSaving(false);
    }
  };

  const summary = defaults
    ? t('teamRestitchSummary', {
        operation: t(OPERATION_KEYS[defaults.operation]),
        photos: defaults.startImageIds.length + defaults.endImageIds.length,
        hold: t(HOLD_KEYS[defaults.finalDurationMode])
      })
    : t('teamRestitchNotConfigured');

  return (
    <section className="team-panel" aria-labelledby="team-restitch-settings-title">
      <h2 id="team-restitch-settings-title">{t('teamRestitchSection')}</h2>
      <p role="status">{loaded ? summary : ''}</p>

      {/* Read rather than hidden: a member who cannot change this can still see what the
          space does, which is what they need in order to ask for it to change. */}
      {!editable && <p className="team-inline-note">{t('teamRestitchReadOnly')}</p>}
      {!connected && <p className="team-inline-note">{t('teamRestitchAgentMissing')}</p>}

      <div className="field-group">
        <div className="field-label">
          <span>{t('teamRestitchOperation')}</span>
        </div>
        <div className="fit-mode-pictos" role="radiogroup" aria-label={t('teamRestitchOperation')}>
          {(['restitch', 'stitch', 'unstitch'] as const).map(value => {
            const Icon = value === 'restitch' ? Replace : value === 'stitch' ? Plus : Eraser;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                className={operation === value ? 'is-selected' : ''}
                data-tip={t(OPERATION_KEYS[value])}
                aria-label={t(OPERATION_KEYS[value])}
                aria-checked={operation === value}
                disabled={!editable}
                onClick={() => setOperation(value)}
              >
                <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>

      {compressor?.imageEmbedding && (
        <ImageEmbeddingSection
          settings={compressor.imageEmbedding}
          disabled={!editable || !connected}
          update={updateEmbedding}
          uploadImages={uploadImages}
          removeImage={removeImage}
          onValidityChange={() => {}}
          optional={false}
          t={t}
        />
      )}

      {editable && (
        <Button
          type="button"
          variant="primary"
          loading={saving}
          disabled={!connected || !compressor}
          onClick={() => void save()}
        >
          {t('teamRestitchSave')}
        </Button>
      )}

      {editable && (
        <div className="team-restitch-prepare">
          <p className="team-inline-note">{t('teamRestitchPrepareExplain')}</p>
          {/* One reason at a time. Two "first do this" lines side by side make neither of them
              the next step. */}
          {!driveConnected ? (
            <p className="team-inline-note">{t('teamRestitchPrepareNoDrive')}</p>
          ) : (
            <>
              <div className="team-restitch-prepare-actions">
                <Button
                  type="button"
                  variant="secondary"
                  loading={busy(preparation.state.phase)}
                  disabled={!connected || !defaults?.configured}
                  onClick={() => void preparation.prepare()}
                >
                  {t('teamRestitchPrepare')}
                </Button>
                {busy(preparation.state.phase) && (
                  <Button type="button" variant="ghost" onClick={() => void preparation.cancel()}>
                    {t('teamRestitchPrepareStop')}
                  </Button>
                )}
              </div>
              {/* One line that says the same thing throughout: what is happening now, and
                  afterwards how many are ready and how many could not be (SC-006). */}
              <p role="status">{progressLine(preparation.state, t)}</p>
            </>
          )}
          {driveConnected && !defaults?.configured && (
            <p className="team-inline-note">{t('teamRestitchPrepareNeedsDefaults')}</p>
          )}
        </div>
      )}
    </section>
  );
}

function busy(phase: RestitchPreparationState['phase']): boolean {
  return phase === 'folder' || phase === 'listing' || phase === 'running';
}

/** The run in one sentence, in whichever state it is. */
function progressLine(
  state: RestitchPreparationState,
  t: ReturnType<typeof useI18n>['t']
): string {
  if (state.phase === 'idle') return '';
  if (state.phase === 'folder') return t('teamRestitchPrepareFolder');
  if (state.phase === 'listing') return t('teamRestitchPrepareListing');
  if (state.phase === 'failed') {
    return t('teamRestitchPrepareFailed', { reason: state.errorCode ?? '' });
  }
  if (state.phase === 'running') {
    return t('teamRestitchPreparing', { done: state.done, total: state.total });
  }
  // Finished or stopped: the tally is the same sentence either way, because a stopped run
  // keeps everything it had already found.
  const tally = t(
    state.phase === 'canceled' ? 'teamRestitchPrepareStopped' : 'teamRestitchPrepared',
    { ready: state.ready, failed: state.unsupported + state.failed }
  );
  // When nothing came through, the count alone leaves a member with nowhere to go; the reason
  // the agent gave is the part they can act on.
  return state.ready === 0 && state.failed > 0 && state.errorCode
    ? `${tally} — ${teamErrorMessageFor(new Error(state.errorCode), t)}`
    : tally;
}
