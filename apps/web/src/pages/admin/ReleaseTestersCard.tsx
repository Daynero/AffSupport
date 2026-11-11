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

type Tester = { user_id: string; email: string; added_at: string };

/**
 * Feature 051: who besides administrators may use the release candidate on
 * the `next` address. The owner adds the one other person testing a release
 * here, by the email they signed in with.
 */
export function ReleaseTestersCard() {
  const { t, language } = useI18n();
  const headingId = useId();
  const emailId = useId();
  const [testers, setTesters] = useState<Tester[] | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<'unknown' | 'error' | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await requireSupabaseClient().rpc('admin_list_release_testers');
    // Before the candidate that adds the list reaches the database there is no
    // list to show; the card says so rather than failing the admin page.
    setTesters(error ? [] : (data ?? []));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const value = email.trim();
    if (!value) return;
    setBusy(true);
    setProblem(null);
    const { error } = await requireSupabaseClient().rpc('admin_add_release_tester', {
      p_email: value
    });
    setBusy(false);
    if (error) {
      setProblem(error.message.includes('RELEASE_TESTER_UNKNOWN_EMAIL') ? 'unknown' : 'error');
      return;
    }
    setEmail('');
    await load();
  };

  const remove = async (userId: string) => {
    setBusy(true);
    setProblem(null);
    const { error } = await requireSupabaseClient().rpc('admin_remove_release_tester', {
      p_user_id: userId
    });
    setBusy(false);
    if (error) setProblem('error');
    await load();
  };

  return (
    <Card className="admin-card release-testers-card" aria-labelledby={headingId}>
      <div className="admin-card-heading">
        <div>
          <h3 id={headingId}>{t('adminReleaseTestersTitle')}</h3>
          <p>{t('adminReleaseTestersSubtitle', { origin: PREVIEW_SITE_ORIGIN })}</p>
        </div>
      </div>
      <form
        className="release-testers-form"
        onSubmit={event => {
          event.preventDefault();
          void add();
        }}
      >
        <FormField label={t('adminReleaseTestersEmail')} htmlFor={emailId}>
          <Input
            id={emailId}
            type="email"
            autoComplete="off"
            value={email}
            onChange={event => setEmail(event.target.value)}
          />
        </FormField>
        <Button type="submit" color="primary" loading={busy} disabled={!email.trim()}>
          {t('adminReleaseTestersAdd')}
        </Button>
      </form>
      {problem && (
        <Alert color="error" live="alert">
          {t(problem === 'unknown' ? 'adminReleaseTestersUnknown' : 'adminReleaseTestersError')}
        </Alert>
      )}
      {testers && testers.length ? (
        <Table
          size="sm"
          className="admin-table"
          columns="minmax(0, 2fr) minmax(0, 1fr) auto"
          aria-labelledby={headingId}
        >
          <TableHeader>
            <TableHeaderCell>{t('email')}</TableHeaderCell>
            <TableHeaderCell>{t('joined')}</TableHeaderCell>
            <TableHeaderCell>
              <span className="sr-only">{t('adminReleaseTestersRemove')}</span>
            </TableHeaderCell>
          </TableHeader>
          {testers.map(tester => (
            <TableRow key={tester.user_id}>
              <TableCell>{tester.email}</TableCell>
              <TableCell>
                {new Date(tester.added_at).toLocaleString(language === 'uk' ? 'uk-UA' : 'en-US')}
              </TableCell>
              <TableCell>
                <Button
                  size="sm"
                  color="neutral"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void remove(tester.user_id)}
                >
                  {t('adminReleaseTestersRemove')}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </Table>
      ) : (
        testers && (
          <EmptyState className="admin-empty" size="sm" title={t('adminReleaseTestersEmpty')} />
        )
      )}
    </Card>
  );
}
