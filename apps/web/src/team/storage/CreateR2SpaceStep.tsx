import { useEffect, useState } from 'react';
import { RadioGroup } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { configuredEnvironment, siteChannel } from '../../lib/config';
import { r2SpaceCreationAvailable } from '../../api/space-storage';

export type SpaceStorageChoice = 'drive' | 'r2';

/**
 * 057 (US11): whether this person may create a space on Soty storage here. The address decides
 * first — never on the production address — and only then is the permit asked for, so the
 * production site never even calls it. Until the answer arrives the choice is not offered.
 */
export function useR2SpaceCreation(
  isStorageR2Pilot: (() => Promise<boolean>) | undefined,
  enabled: boolean
): boolean {
  const addressAllows = r2SpaceCreationAvailable({
    channel: siteChannel(),
    environment: configuredEnvironment(),
    pilot: true
  });
  const ask = enabled && addressAllows && isStorageR2Pilot !== undefined;
  const [pilot, setPilot] = useState(false);
  useEffect(() => {
    if (!ask || !isStorageR2Pilot) return;
    let live = true;
    void isStorageR2Pilot()
      .catch(() => false)
      .then(value => {
        if (live) setPilot(value === true);
      });
    return () => {
      live = false;
    };
  }, [ask, isStorageR2Pilot]);
  return ask && pilot;
}

/**
 * Where the files of a new space live: a Google Drive folder chosen in the next step, or Soty
 * storage, which needs no folder at all — the space is ready the moment it is named. Shown only
 * to a pilot, inside the name step, so creating stays one step for them.
 */
export function CreateR2SpaceStep({
  value,
  onChange,
  disabled = false
}: {
  value: SpaceStorageChoice;
  onChange: (value: SpaceStorageChoice) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <RadioGroup<SpaceStorageChoice>
      variant="cards"
      label={t('teamCreateStorageLabel')}
      value={value}
      onChange={onChange}
      disabled={disabled}
      options={[
        {
          value: 'drive',
          label: t('teamCreateStorageDrive'),
          description: t('teamCreateStorageDriveHint')
        },
        {
          value: 'r2',
          label: t('teamCreateStorageR2'),
          description: t('teamCreateStorageR2Hint')
        }
      ]}
    />
  );
}
