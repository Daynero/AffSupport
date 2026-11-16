import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  FadeImage,
  FormField,
  Input,
  Pagination,
  Progress
} from '../../components/ui/index';
import { useI18n } from '../../i18n';
import {
  globalPool,
  importPoolImages,
  POOL_IMAGE_PATTERN,
  type GlobalPoolImage,
  type GlobalPoolOverview,
  type GlobalPoolTeam,
  type PoolImportProgress
} from '../../api/catalog-global-pool';

const PAGE_SIZE = 60;
/** The production media origin (scripts/generate-csp-headers.mjs allows it for images). */
const DEFAULT_MEDIA_ORIGIN = 'https://catalog-images.soty.pp.ua';

/**
 * The shared white image pool (052) for the platform owner: how full it is, whether
 * its images are served, which spaces use it before it is switched on for everyone,
 * the images themselves, and adding a folder of new ones.
 */
export function ImagePoolPanel() {
  const { t, language } = useI18n();
  const [overview, setOverview] = useState<GlobalPoolOverview | null>(null);
  const [problem, setProblem] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setOverview(await globalPool.overview());
      setProblem(false);
    } catch {
      setProblem(true);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (problem && !overview)
    return (
      <Alert color="error" live="alert">
        {t('adminPoolLoadError')}
      </Alert>
    );
  if (!overview) return null;
  return (
    <div className="admin-pool">
      <PoolStatus overview={overview} onChange={setOverview} />
      <PoolPilot overview={overview} onChange={setOverview} />
      <PoolUpload overview={overview} onDone={refresh} language={language} />
      <PoolGallery key={overview.images.total} />
    </div>
  );
}

function PoolStatus({
  overview,
  onChange
}: {
  overview: GlobalPoolOverview;
  onChange: (next: GlobalPoolOverview) => void;
}) {
  const { t } = useI18n();
  const headingId = useId();
  const originId = useId();
  const [origin, setOrigin] = useState(overview.policy.mediaOrigin ?? DEFAULT_MEDIA_ORIGIN);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const { images, policy } = overview;
  const serving = !policy.mediaOrigin
    ? 'unconfigured'
    : policy.servingVerifiedAt && Date.now() - Date.parse(policy.servingVerifiedAt) < 5 * 60_000
      ? 'verified'
      : 'unverified';
  const configure = async () => {
    setBusy(true);
    setFailed(false);
    try {
      onChange(
        await globalPool.configure({
          environment: 'production',
          mediaOrigin: origin.trim().replace(/\/+$/u, ''),
          routingRevision:
            policy.routingRevision === 'unconfigured' ? 'r1' : policy.routingRevision,
          acceptedKeyVersions: policy.acceptedKeyVersions.length ? policy.acceptedKeyVersions : [1]
        })
      );
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="admin-card" aria-labelledby={headingId}>
      <div className="admin-card-heading">
        <div>
          <h3 id={headingId}>{t('adminPoolTitle')}</h3>
          <p>{t(policy.activatedAt ? 'adminPoolSubtitleActive' : 'adminPoolSubtitlePilot')}</p>
        </div>
        <Badge
          color={
            serving === 'verified' ? 'success' : serving === 'unverified' ? 'warning' : 'neutral'
          }
        >
          {t(
            serving === 'verified'
              ? 'adminPoolServingVerified'
              : serving === 'unverified'
                ? 'adminPoolServingUnverified'
                : 'adminPoolServingUnconfigured'
          )}
        </Badge>
      </div>
      <dl className="admin-pool-counts">
        {(
          [
            ['adminPoolReady', images.ready],
            ['adminPoolPending', images.pending],
            ['adminPoolFailed', images.failed],
            ['adminPoolHidden', images.hidden],
            ['adminPoolUses', images.uses]
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt>{t(label)}</dt>
            <dd className="numeric">{value}</dd>
          </div>
        ))}
      </dl>
      {serving === 'unconfigured' && (
        <form
          className="release-testers-form"
          onSubmit={event => {
            event.preventDefault();
            void configure();
          }}
        >
          <FormField label={t('adminPoolMediaOrigin')} htmlFor={originId}>
            <Input id={originId} value={origin} onChange={event => setOrigin(event.target.value)} />
          </FormField>
          <Button type="submit" color="primary" loading={busy} disabled={!origin.trim()}>
            {t('adminPoolConfigure')}
          </Button>
        </form>
      )}
      {failed && (
        <Alert color="error" live="alert">
          {t('adminPoolActionError')}
        </Alert>
      )}
    </Card>
  );
}

function PoolPilot({
  overview,
  onChange
}: {
  overview: GlobalPoolOverview;
  onChange: (next: GlobalPoolOverview) => void;
}) {
  const { t } = useI18n();
  const headingId = useId();
  const queryId = useId();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<GlobalPoolTeam[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const value = query.trim();
    if (value.length < 2) {
      setFound([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void globalPool
        .teams(value)
        .then(result => current && setFound(result.teams))
        .catch(() => current && setFound([]));
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query]);
  const run = async (action: () => Promise<GlobalPoolOverview>) => {
    setBusy(true);
    setFailed(false);
    try {
      onChange(await action());
      setQuery('');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const inPilot = new Set(overview.pilot.map(team => team.teamId));
  if (overview.policy.activatedAt) return null;
  return (
    <Card className="admin-card" aria-labelledby={headingId}>
      <div className="admin-card-heading">
        <div>
          <h3 id={headingId}>{t('adminPoolPilotTitle')}</h3>
          <p>{t('adminPoolPilotSubtitle')}</p>
        </div>
      </div>
      {overview.pilot.length ? (
        <ul className="admin-pool-teams">
          {overview.pilot.map(team => (
            <li key={team.teamId}>
              <span>{team.name}</span>
              <Button
                size="sm"
                color="neutral"
                variant="ghost"
                disabled={busy}
                onClick={() => void run(() => globalPool.removePilot(team.teamId))}
              >
                {t('adminPoolPilotRemove')}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState className="admin-empty" size="sm" title={t('adminPoolPilotEmpty')} />
      )}
      <FormField label={t('adminPoolPilotSearch')} htmlFor={queryId}>
        <Input
          id={queryId}
          autoComplete="off"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
      </FormField>
      {found.length > 0 && (
        <ul className="admin-pool-teams">
          {found
            .filter(team => !inPilot.has(team.teamId))
            .map(team => (
              <li key={team.teamId}>
                <span>{team.name}</span>
                <Button
                  size="sm"
                  color="primary"
                  variant="soft"
                  disabled={busy}
                  onClick={() => void run(() => globalPool.addPilot(team.teamId))}
                >
                  {t('adminPoolPilotAdd')}
                </Button>
              </li>
            ))}
        </ul>
      )}
      {failed && (
        <Alert color="error" live="alert">
          {t('adminPoolActionError')}
        </Alert>
      )}
    </Card>
  );
}

function PoolUpload({
  overview,
  onDone,
  language
}: {
  overview: GlobalPoolOverview;
  onDone: () => Promise<void>;
  language: string;
}) {
  const { t } = useI18n();
  const headingId = useId();
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<PoolImportProgress | null>(null);
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  // A browser exposes a folder picker only through this non-standard attribute.
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
  }, []);
  const start = async (list: FileList | null) => {
    const files = [...(list ?? [])].filter(file => POOL_IMAGE_PATTERN.test(file.name));
    if (!files.length) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setState('running');
    setProgress({ total: files.length, uploaded: 0, skipped: 0 });
    try {
      await importPoolImages(files, { signal: abort.signal, onProgress: setProgress });
      setState('done');
    } catch {
      if (!abort.signal.aborted) setState('error');
    } finally {
      await onDone();
    }
  };
  const done = progress ? progress.uploaded + progress.skipped : 0;
  const locale = language === 'uk' ? 'uk-UA' : 'en-US';
  return (
    <Card className="admin-card" aria-labelledby={headingId}>
      <div className="admin-card-heading">
        <div>
          <h3 id={headingId}>{t('adminPoolUploadTitle')}</h3>
          <p>{t('adminPoolUploadSubtitle')}</p>
        </div>
      </div>
      <div className="admin-pool-actions">
        <Button
          color="primary"
          disabled={state === 'running' || !overview.policy.mediaOrigin}
          onClick={() => folderInput.current?.click()}
        >
          {t('adminPoolUploadFolder')}
        </Button>
        <Button
          color="neutral"
          variant="outline"
          disabled={state === 'running' || !overview.policy.mediaOrigin}
          onClick={() => filesInput.current?.click()}
        >
          {t('adminPoolUploadFiles')}
        </Button>
        <input
          ref={folderInput}
          type="file"
          multiple
          hidden
          onChange={event => {
            void start(event.target.files);
            event.target.value = '';
          }}
        />
        <input
          ref={filesInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          hidden
          onChange={event => {
            void start(event.target.files);
            event.target.value = '';
          }}
        />
      </div>
      {progress && (
        <div className="admin-pool-progress" aria-live="polite">
          <Progress
            value={(done / Math.max(1, progress.total)) * 100}
            label={t('adminPoolUploadTitle')}
            color={state === 'error' ? 'error' : 'primary'}
          />
          <p>
            {t(
              state === 'error'
                ? 'adminPoolUploadError'
                : state === 'done'
                  ? 'adminPoolUploadDone'
                  : 'adminPoolUploadRunning',
              { done, total: progress.total }
            )}
          </p>
        </div>
      )}
      {overview.jobs.length > 0 && (
        <ul className="admin-pool-jobs">
          {overview.jobs.map(job => (
            <li key={job.id}>
              <span>{new Date(job.createdAt).toLocaleString(locale)}</span>
              <span className="numeric">
                {t('adminPoolJobCounts', {
                  ready: job.ready,
                  total: job.totalFiles,
                  failed: job.failed,
                  waiting: job.waiting
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PoolGallery() {
  const { t } = useI18n();
  const headingId = useId();
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ images: GlobalPoolImage[]; total: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async (target: number) => {
    try {
      setResult(await globalPool.images({ offset: (target - 1) * PAGE_SIZE, limit: PAGE_SIZE }));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load(page);
  }, [load, page]);
  const toggle = async (image: GlobalPoolImage) => {
    try {
      await globalPool.setVisible(image.id, !image.active);
      await load(page);
    } catch {
      setFailed(true);
    }
  };
  return (
    <Card className="admin-card" aria-labelledby={headingId}>
      <div className="admin-card-heading">
        <div>
          <h3 id={headingId}>{t('adminPoolGalleryTitle')}</h3>
          <p>{t('adminPoolGallerySubtitle')}</p>
        </div>
      </div>
      {failed && (
        <Alert color="error" live="alert">
          {t('adminPoolLoadError')}
        </Alert>
      )}
      {result && !result.images.length && (
        <EmptyState className="admin-empty" size="sm" title={t('adminPoolGalleryEmpty')} />
      )}
      {result && result.images.length > 0 && (
        <ul className="admin-pool-grid">
          {result.images.map(image => (
            <li key={image.id} data-hidden={!image.active || undefined}>
              <div className="admin-pool-thumb">
                {image.url && image.state === 'ready' ? (
                  <FadeImage src={image.url} alt={image.name ?? ''} loading="lazy" />
                ) : (
                  <span>
                    {t(image.state === 'failed' ? 'adminPoolFailed' : 'adminPoolPending')}
                  </span>
                )}
              </div>
              <div className="admin-pool-meta">
                <strong>
                  {image.garment ?? '—'} · {image.color ?? '—'}
                </strong>
                <span className="numeric">{t('adminPoolImageUses', { count: image.uses })}</span>
              </div>
              <Button size="sm" color="neutral" variant="ghost" onClick={() => void toggle(image)}>
                {t(image.active ? 'adminPoolHide' : 'adminPoolShow')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {result && (
        <Pagination
          page={page}
          pageCount={Math.ceil(result.total / PAGE_SIZE)}
          onChange={setPage}
          label={t('adminPoolGalleryTitle')}
          previousLabel={t('adminPoolPrevious')}
          nextLabel={t('adminPoolNext')}
        />
      )}
    </Card>
  );
}
