import { useEffect, useRef } from 'react';
import { publicConfig } from '../lib/config';
import { navigateTo } from '../lib/navigation';
import { AuthLoadingScreen } from './AuthScreens';

/** Where Google returns a Drive authorization to; see `_shared/google-redirect.ts`. */
export const DRIVE_OAUTH_CALLBACK_PATH = '/oauth/drive/callback';

/**
 * Hands Google's answer to the Edge Function that finishes the connection.
 *
 * The function keeps the transaction, the verifier and the client secret; this
 * page only moves the query across unchanged, replacing its own history entry so
 * the one-time code is not something the back button returns to.
 */
export function DriveOAuthForwardPage() {
  const forwarded = useRef(false);

  useEffect(() => {
    if (forwarded.current) return;
    forwarded.current = true;
    if (!publicConfig.ok) {
      navigateTo('/team?drive=DRIVE_UNAVAILABLE', true);
      return;
    }
    location.replace(
      `${publicConfig.value.supabaseUrl}/functions/v1/drive-oauth-callback${location.search}`
    );
  }, []);

  return <AuthLoadingScreen callback />;
}
