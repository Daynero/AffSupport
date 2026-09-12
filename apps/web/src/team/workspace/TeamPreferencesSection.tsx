/**
 * Two choices about how team mode behaves, where team mode is configured.
 *
 * They lived on the account page, between a display name and a language — which is where a
 * person looks for who they are, not for how a task or a transcript behaves. Both are still
 * that person's own choices rather than the space's, and the copy says so: what moved is the
 * door, not the setting.
 */

import { useEffect, useId, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { useI18n } from '../../i18n';
import { SettingsSection } from './SettingsSection';

export interface TeamPreferencesClient {
  getTranscriptDeletePref(): Promise<'ask' | 'delete' | 'keep'>;
  setTranscriptDeletePref(value: 'ask' | 'delete' | 'keep'): Promise<void>;
  getTaskProgressMaxDefault(): Promise<number>;
  setTaskProgressMaxDefault(value: number): Promise<void>;
}

const PROGRESS_MAX = 10_000;

export function TeamPreferencesSection({ client }: { client: TeamPreferencesClient }) {
  const { t } = useI18n();
  const titleId = useId();
  const transcriptId = useId();
  const progressId = useId();
  const [transcript, setTranscript] = useState<'ask' | 'delete' | 'keep' | null>(null);
  const [progressMax, setProgressMax] = useState<string | null>(null);

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
      .getTaskProgressMaxDefault()
      .then(value => {
        if (active) setProgressMax(String(value));
      })
      .catch(() => {
        if (active) setProgressMax('100');
      });
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <SettingsSection
      icon={ListChecks}
      titleId={titleId}
      title={t('teamPreferencesTitle')}
      description={t('teamPreferencesDescription')}
      className="team-preferences"
    >
      {/* Two short choices side by side rather than two full-width fields stacked: neither
          needs the dialog's whole width, and at full width the label above each one read as
          a heading of its own. */}
      <div className="settings-field-grid">
        {transcript !== null && (
          <div className="field-group">
            <label className="field-label" htmlFor={transcriptId}>
              <span>{t('accountTranscriptDeleteLabel')}</span>
            </label>
            <select
              id={transcriptId}
              value={transcript}
              onChange={event => {
                const next = event.target.value as 'ask' | 'delete' | 'keep';
                setTranscript(next);
                void client.setTranscriptDeletePref(next).catch(() => undefined);
              }}
            >
              <option value="ask">{t('accountTranscriptDeleteAsk')}</option>
              <option value="delete">{t('accountTranscriptDeleteAlways')}</option>
              <option value="keep">{t('accountTranscriptDeleteNever')}</option>
            </select>
          </div>
        )}

        {progressMax !== null && (
          <div className="field-group">
            <label className="field-label" htmlFor={progressId}>
              <span>{t('accountTaskMaxDefaultLabel')}</span>
            </label>
            <input
              id={progressId}
              type="number"
              min={1}
              max={PROGRESS_MAX}
              value={progressMax}
              onChange={event => setProgressMax(event.target.value)}
              /* Saved when the field is left, and a figure the server would refuse is put
                 back to what it holds rather than left sitting there unsaved. */
              onBlur={() => {
                const parsed = Number(progressMax);
                if (!Number.isInteger(parsed) || parsed < 1 || parsed > PROGRESS_MAX) {
                  void client
                    .getTaskProgressMaxDefault()
                    .then(value => setProgressMax(String(value)))
                    .catch(() => undefined);
                  return;
                }
                void client.setTaskProgressMaxDefault(parsed).catch(() => undefined);
              }}
            />
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
