/**
 * Two choices about how team mode behaves, where team mode is configured.
 *
 * They lived on the account page, between a display name and a language — which is where a
 * person looks for who they are, not for how a task or a transcript behaves. What happens to a
 * transcript is still the person's own choice; a new task's maximum is the space's (024): saved
 * for one person, a teammate's next task still started at 100. Each label says whose it is.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { FileText, ListChecks } from 'lucide-react';
import { FormField, Input, Select } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { SaveStateWord, useSaveState } from './SaveStateWord';
import { SettingsSection } from './SettingsSection';

export interface TeamPreferencesClient {
  getTranscriptDeletePref(): Promise<'ask' | 'delete' | 'keep'>;
  setTranscriptDeletePref(value: 'ask' | 'delete' | 'keep'): Promise<void>;
  getTaskProgressMaxDefault(teamId: string): Promise<number>;
  setTaskProgressMaxDefault(teamId: string, value: number): Promise<void>;
}

const PROGRESS_MAX = 10_000;

export function TeamPreferencesSection({
  teamId,
  client
}: {
  teamId: string;
  client: TeamPreferencesClient;
}) {
  const { t } = useI18n();
  const { can } = useTeam();
  const canManage = can('manage_metadata');
  const transcriptTitleId = useId();
  const tasksTitleId = useId();
  const transcriptLabelId = useId();
  const progressId = useId();
  const [transcript, setTranscript] = useState<'ask' | 'delete' | 'keep' | null>(null);
  const [progressMax, setProgressMax] = useState<string | null>(null);
  /** The figure the server holds — what the field goes back to only on a figure it would refuse. */
  const storedMax = useRef<string | null>(null);
  const [progressInvalid, setProgressInvalid] = useState(false);
  const transcriptSave = useSaveState();
  const progressSave = useSaveState();

  useEffect(() => {
    let active = true;
    void client
      .getTranscriptDeletePref()
      .then(value => {
        if (active) setTranscript(value);
      })
      .catch(() => {
        // The default the server itself would apply, so the field says what will happen.
        if (active) setTranscript('ask');
      });
    void client
      .getTaskProgressMaxDefault(teamId)
      .then(value => {
        if (!active) return;
        storedMax.current = String(value);
        setProgressMax(String(value));
      })
      .catch(() => {
        if (active) setProgressMax('100');
      });
    return () => {
      active = false;
    };
  }, [client, teamId]);

  /* A failed write keeps what was chosen on screen and says so beside it (FR-025): put
     back silently, the field looked saved and the next task started at the old figure. */
  const saveProgress = () => {
    if (progressMax === null || progressMax === storedMax.current) return;
    const parsed = Number(progressMax);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > PROGRESS_MAX) {
      setProgressInvalid(true);
      return;
    }
    setProgressInvalid(false);
    void progressSave
      .track(() => client.setTaskProgressMaxDefault(teamId, parsed))
      .then(kept => {
        if (kept) storedMax.current = String(parsed);
      });
  };

  return (
    <div className="settings-field-grid team-preferences">
      <SettingsSection
        icon={FileText}
        titleId={transcriptTitleId}
        title={t('teamTranscriptPreferencesTitle')}
        description={t('teamTranscriptPreferencesDescription')}
        aside={<SaveStateWord state={transcriptSave.state} />}
      >
        {transcript !== null && (
          <FormField
            label={<span id={transcriptLabelId}>{t('accountTranscriptDeleteLabel')}</span>}
            error={transcriptSave.state === 'failed' ? t('teamPreferenceSaveFailed') : undefined}
          >
            <Select
              aria-labelledby={transcriptLabelId}
              value={transcript}
              options={[
                { value: 'ask', label: t('accountTranscriptDeleteAsk') },
                { value: 'delete', label: t('accountTranscriptDeleteAlways') },
                { value: 'keep', label: t('accountTranscriptDeleteNever') }
              ]}
              onChange={value => {
                const next = value as 'ask' | 'delete' | 'keep';
                setTranscript(next);
                void transcriptSave.track(() => client.setTranscriptDeletePref(next));
              }}
            />
          </FormField>
        )}
      </SettingsSection>
      <SettingsSection
        icon={ListChecks}
        titleId={tasksTitleId}
        title={t('teamTaskPreferencesTitle')}
        description={t('teamTaskPreferencesDescription')}
        aside={<SaveStateWord state={progressSave.state} />}
      >
        {progressMax !== null && (
          <FormField
            label={t('accountTaskMaxDefaultLabel')}
            htmlFor={progressId}
            help={t('teamTaskMaxDefaultRange', { max: PROGRESS_MAX })}
            error={
              progressInvalid
                ? t('teamTaskMaxDefaultInvalid', { max: PROGRESS_MAX })
                : progressSave.state === 'failed'
                  ? t('teamPreferenceSaveFailed')
                  : undefined
            }
          >
            <Input
              id={progressId}
              type="number"
              inputMode="numeric"
              min={1}
              max={PROGRESS_MAX}
              width="narrow"
              value={progressMax}
              disabled={!canManage}
              invalid={progressInvalid || progressSave.state === 'failed'}
              onChange={event => {
                setProgressMax(event.target.value);
                setProgressInvalid(false);
              }}
              /* Saved when the field is left, or on Enter. */
              onBlur={saveProgress}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  saveProgress();
                }
              }}
            />
          </FormField>
        )}
      </SettingsSection>
    </div>
  );
}
