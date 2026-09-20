import { useI18n } from '../../i18n';

/**
 * What Soty does with Drive access, said before the owner grants it.
 *
 * Google's verification asks for the privacy disclosure to be visible in the
 * product at the point of use, not only on the policy page.
 */
export function DriveDataUseNotice() {
  const { t } = useI18n();
  return (
    <p className="team-connect-acl-note">
      {t('teamDriveDataUse')}{' '}
      <a href="/privacy#google-drive" target="_blank" rel="noreferrer">
        {t('googleDataUseLink')}
      </a>
    </p>
  );
}
