import { useCallback, useEffect, useId, useState } from 'react';
import { PREVIEW_SITE_ORIGIN } from '@video-compressor/shared';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  FormField,
  Input,
  Table,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow
} from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { requireSupabaseClient } from '../../lib/supabase';

type Pilot = {
  user_id: string;
  email: string;
  /** Decimal text: PostgREST hands a bigint over without a double in between. */
  max_space_bytes: string;
  added_at: string;
  removed_at: string | null;
};

/** The limit is set in decimal gigabytes, as storage is sold (10^9 bytes). */
const GIGABYTE = 1_000_000_000;
/** The database refuses more than 10 TiB per space; 10 240 GB stays below it. */
const MAX_GIGABYTES = 10_240;
const DEFAULT_GIGABYTES = '100';
/** PostgREST answers PGRST202 for a function that is not in its schema cache. */
const MISSING_FUNCTION = 'PGRST202';

type Problem = 'unknown' | 'limit' | 'error' | 'load';

function gigabytes(bytes: string): number | null {
  if (!/^[0-9]{1,19}$/u.test(bytes)) return null;
  return Number(BigInt(bytes) / 1_000_000n) / 1000;
}

/**
 * 057 (US11): who may create spaces whose files live on Soty storage (R2) instead of Google
 * Drive, and how large each of their spaces may grow. The permit works on the `next` address
 * only; taking it away never deletes the spaces a person already made.
 */
export function StorageR2PilotsCard() {
  const { t, language } = useI18n();
  const headingId = useId();
  const emailId = useId();
  const limitId = useId();
  const [pilots, setPilots] = useState<Pilot[] | null>(null);
  const [email, setEmail] = useState('');
  const [limit, setLimit] = useState(DEFAULT_GIGABYTES);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const locale = language === 'uk' ? 'uk-UA' : 'en-US';

  const load = useCallback(async () => {
    const { data, error } = await requireSupabaseClient().rpc('admin_list_storage_r2_pilots');
    if (error) {
      // Before the release that adds the pilot reaches the database there is nobody to list.
      setPilots([]);
      if (error.code !== MISSING_FUNCTION) setProblem('load');
      return;
    }
    setPilots((data ?? []).filter(pilot => pilot.removed_at === null));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const parsedLimit = /^[0-9]{1,5}$/u.test(limit.trim()) ? Number(limit.trim()) : null;
  const limitValid = parsedLimit !== null && parsedLimit >= 1 && parsedLimit <= MAX_GIGABYTES;

  const add = async () => {
    const value = email.trim();
    if (!value) return;
    if (!limitValid || parsedLimit === null) {
      setProblem('limit');
      return;
    }
    setBusy(true);
    setProblem(null);
    const { error } = await requireSupabaseClient().rpc('admin_add_storage_r2_pilot', {
      p_email: value,
      p_max_bytes: parsedLimit * GIGABYTE
    });
    setBusy(false);
    if (error) {
      setProblem(
        error.message.includes('STORAGE_R2_PILOT_UNKNOWN_EMAIL')
          ? 'unknown'
          : error.message.includes('INVALID_INPUT')
            ? 'limit'
            : 'error'
      );
      return;
    }
    setEmail('');
    await load();
  };

  const remove = async (userId: string) => {
    setBusy(true);
    setProblem(null);
    const { error } = await requireSupabaseClient().rpc('admin_remove_storage_r2_pilot', {
      p_user_id: userId
    });
    setBusy(false);
    if (error) setProblem('error');
    await load();
  };

  const problemText: Record<Problem, string> = {
    unknown: t('adminStorageR2PilotsUnknown'),
    limit: t('adminStorageR2PilotsBadLimit', { max: MAX_GIGABYTES.toLocaleString(locale) }),
    error: t('adminStorageR2PilotsError'),
    load: t('adminStorageR2PilotsLoadError')
  };

  return (
    <Card className="admin-card storage-r2-pilots-card" aria-labelledby={headingId}>
      <div className="admin-card-heading">
        <div>
          <h3 id={headingId}>{t('adminStorageR2PilotsTitle')}</h3>
          <p>{t('adminStorageR2PilotsSubtitle', { origin: PREVIEW_SITE_ORIGIN })}</p>
        </div>
      </div>
      <form
        className="release-testers-form"
        onSubmit={event => {
          event.preventDefault();
          void add();
        }}
      >
        <FormField label={t('adminStorageR2PilotsEmail')} htmlFor={emailId}>
          <Input
            id={emailId}
            type="email"
            autoComplete="off"
            value={email}
            onChange={event => setEmail(event.target.value)}
          />
        </FormField>
        <FormField label={t('adminStorageR2PilotsLimit')} htmlFor={limitId}>
          <Input
            id={limitId}
            inputMode="numeric"
            autoComplete="off"
            value={limit}
            invalid={!limitValid}
            onChange={event => setLimit(event.target.value)}
          />
        </FormField>
        <Button
          type="submit"
          color="primary"
          loading={busy}
          disabled={!email.trim() || !limitValid}
        >
          {t('adminStorageR2PilotsAdd')}
        </Button>
      </form>
      {problem && (
        <Alert color="error" live="alert">
          {problemText[problem]}
        </Alert>
      )}
      {pilots && pilots.length ? (
        <Table
          size="sm"
          className="admin-table"
          columns="minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) auto"
          aria-labelledby={headingId}
        >
          <TableHeader>
            <TableHeaderCell>{t('email')}</TableHeaderCell>
            <TableHeaderCell>{t('adminStorageR2PilotsLimitColumn')}</TableHeaderCell>
            <TableHeaderCell>{t('joined')}</TableHeaderCell>
            <TableHeaderCell>
              <span className="sr-only">{t('adminStorageR2PilotsRemove')}</span>
            </TableHeaderCell>
          </TableHeader>
          {pilots.map(pilot => {
            const size = gigabytes(pilot.max_space_bytes);
            return (
              <TableRow key={pilot.user_id}>
                <TableCell>{pilot.email}</TableCell>
                <TableCell>
                  {size === null
                    ? '—'
                    : t('adminStorageR2PilotsLimitValue', { size: size.toLocaleString(locale) })}
                </TableCell>
                <TableCell>{new Date(pilot.added_at).toLocaleString(locale)}</TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    color="neutral"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`${t('adminStorageR2PilotsRemove')} ${pilot.email}`}
                    onClick={() => void remove(pilot.user_id)}
                  >
                    {t('adminStorageR2PilotsRemove')}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </Table>
      ) : (
        pilots && (
          <EmptyState className="admin-empty" size="sm" title={t('adminStorageR2PilotsEmpty')} />
        )
      )}
    </Card>
  );
}
