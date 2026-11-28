import { useId, type ReactNode } from 'react';
import { isR2Space } from '../../api/space-storage';
import { Button, FormField, Input } from '../../components/ui/index';
import { useToasts } from '../../components/toast';
import { useI18n, type TranslationKey } from '../../i18n';
import { useOptionalTeam } from '../TeamContext';

/**
 * 057 (FR-050): a catalog of an R2 space is a feed — one CSV address Meta reads on a schedule —
 * not a Google sheet. Its card shows that address, copies it and opens it, and never speaks of
 * Google or of a sheet. A Drive space keeps its sheet's open and copy actions as they were.
 */
export function useCatalogFeedSpace(teamId: string): boolean {
  const team = useOptionalTeam();
  return (
    team?.teams.find(space => space.id === teamId)?.storageBackend === 'r2' || isR2Space(teamId)
  );
}

/** Wording of a stopped or retried write: «у стрічку» for a feed, the sheet's own otherwise. */
const FEED_WORDING: Partial<Record<TranslationKey, TranslationKey>> = {
  catalogPublicationBlockedDrive: 'catalogFeedBlockedTarget',
  catalogPublicationBlockedTarget: 'catalogFeedBlockedTarget',
  catalogPublicationBlockedStale: 'catalogFeedBlockedStale',
  catalogPublicationBlockedGeneric: 'catalogFeedBlockedGeneric',
  catalogPublicationRetried: 'catalogFeedRetried',
  catalogPublicationVerifyingWrite: 'catalogFeedVerifyingWrite',
  catalogPublicationRetryWait: 'catalogFeedRetryWait',
  catalogPublicationAddNowConfirm: 'catalogFeedAddNowConfirm'
};

export function catalogFeedWording(key: TranslationKey, feed: boolean): TranslationKey {
  return feed ? (FEED_WORDING[key] ?? key) : key;
}

export function CatalogFeedAddress({ url }: { url: string }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <FormField label={t('catalogFeedAddressLabel')} help={t('catalogFeedAddressHint')} htmlFor={id}>
      <Input
        id={id}
        value={url}
        readOnly
        spellCheck={false}
        onFocus={event => event.currentTarget.select()}
      />
    </FormField>
  );
}

/**
 * The open and copy actions of a catalog's document, followed by `children` (the dialog's own
 * closing action). For a Drive space this is the markup the created view always had.
 */
export function CatalogDocumentLinks({
  teamId,
  url,
  name,
  children
}: {
  teamId: string;
  url: string;
  name: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const feed = useCatalogFeedSpace(teamId);
  const copy = async (done: TranslationKey) => {
    try {
      await navigator.clipboard.writeText(url);
      push({ tone: 'success', text: t(done) });
    } catch {
      push({ tone: 'error', text: t('teamToastLinkCopyFailed') });
    }
  };
  if (!feed)
    return (
      <div className="team-dialog-actions">
        <a
          className="soty-button button-secondary"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('productCatalogOpen')}
        >
          {t('productCatalogOpenShort')}
        </a>
        <Button
          type="button"
          variant="secondary"
          aria-label={t('productCatalogCopyLink')}
          onClick={() => void copy('productCatalogLinkCopied')}
        >
          {t('productCatalogCopyLinkShort')}
        </Button>
        {children}
      </div>
    );
  return (
    <>
      <CatalogFeedAddress url={url} />
      <div className="team-dialog-actions">
        <Button
          type="button"
          variant="secondary"
          aria-label={t('catalogFeedCopyOf', { name })}
          onClick={() => void copy('catalogFeedCopied')}
        >
          {t('catalogFeedCopy')}
        </Button>
        <a
          className="soty-button button-secondary"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('catalogFeedOpenOf', { name })}
        >
          {t('productCatalogOpenShort')}
        </a>
        {children}
      </div>
    </>
  );
}
