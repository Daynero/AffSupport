import { type ReactNode } from 'react';
import { PRODUCTION_SITE_ORIGIN } from '@video-compressor/shared';
import { useI18n } from '../i18n';
import { siteChannel } from '../lib/config';
import { useReleaseTester } from '../lib/release-tester';
import { Card, EmptyState, LoadingState } from './ui/index';

/**
 * Feature 051: the candidate address works on production data, so only the
 * people testing it use it. Anyone else who reaches it is told what it is and
 * sent to the main site; the main site itself is never gated.
 */
export function ReleaseTesterGate({
  children,
  origin
}: {
  children: ReactNode;
  origin?: string | null;
}) {
  const onNext = siteChannel(origin) === 'next';
  const status = useReleaseTester(onNext);
  const { t } = useI18n();
  if (!onNext) return <>{children}</>;
  if (status === 'tester') return <>{children}</>;
  if (status === 'checking')
    return (
      <main className="page-container release-tester-gate">
        <LoadingState shape="block" count={1} label={t('releaseTesterChecking')} />
      </main>
    );
  return (
    <main className="page-container release-tester-gate">
      <Card className="release-tester-gate-card">
        <EmptyState
          titleAs="h1"
          title={t('releaseTesterGateTitle')}
          description={t('releaseTesterGateBody')}
          action={
            <a
              className="ui-button ui-button--solid ui-button--md ui-color-primary"
              href={PRODUCTION_SITE_ORIGIN}
            >
              {t('releaseTesterGateAction')}
            </a>
          }
        />
      </Card>
    </main>
  );
}
