// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import React, { type ReactNode } from 'react';
const { share, preference, push, begin, complete, reportError } = vi.hoisted(() => ({
  share: vi.fn(),
  preference: vi.fn(),
  push: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  reportError: vi.fn()
}));
vi.mock('../apps/web/src/analytics/service', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/analytics/service')>()),
  startTeamFileAttempt: begin,
  completeTeamFileAttempt: complete
}));
vi.mock('../apps/web/src/api/team', () => ({
  teamApi: { shareLibraryMaterial: share, getLibrarySharePreference: preference },
  TeamApiError: class extends Error {
    code: string;
    retryable: boolean;
    constructor(code: string, retryable: boolean) {
      super(code);
      this.code = code;
      this.retryable = retryable;
    }
  }
}));
vi.mock('../apps/web/src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../apps/web/src/components/toast', () => ({ useToasts: () => ({ push }) }));
vi.mock('../apps/web/src/team/catalog/useMaterialActions', () => ({
  useMaterialActions: () => ({ busy: false }),
  analyticsOutcome: () => 'failure',
  retryableError: () => false,
  reportFileAttemptError: reportError
}));
vi.mock('../apps/web/src/team/catalog/FolderPicker', () => ({ FolderPicker: () => null }));
vi.mock('../apps/web/src/team/materials/MaterialNote', () => ({ MaterialNoteDialog: () => null }));
vi.mock('../apps/web/src/components/ui/index', () => ({
  Modal: ({ children, onClose }: { children: ReactNode; onClose: () => void }) => (
    <div role="dialog">
      <button onClick={onClose}>close-link</button>
      {children}
    </div>
  ),
  ErrorState: ({ message }: { message: string }) => <div role="alert">{message}</div>,
  LoadingState: () => <div role="status">loading</div>,
  Checkbox: ({
    label,
    checked,
    disabled,
    onChange
  }: {
    label: string;
    checked: boolean;
    disabled?: boolean;
    onChange: (value: boolean) => void;
  }) => (
    <label>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
      />
      {label}
    </label>
  ),
  FormField: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Button: ({
    loading: _loading,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => <button {...props} />
}));
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
import { analytics } from '../apps/web/src/analytics/service';
import { useMaterialActionHost } from '../apps/web/src/team/materials/MaterialActionHost';
function Harness({ teamId = 'team' }: { teamId?: string }) {
  const host = useMaterialActionHost({
    teamId,
    storageKind: 'shared_drive',
    surface: 'catalog_manager',
    material: {
      id: 'catalog',
      teamId,
      name: 'catalog.csv',
      kind: 'file',
      category: 'other',
      availability: 'ready'
    },
    permissions: {
      upload: true,
      process: true,
      download: true,
      view: true,
      edit: true,
      delete: true,
      manage_members: true,
      manage_metadata: true
    },
    browseClient: {} as never,
    onChanged: () => undefined
  });
  return (
    <>
      <button onClick={host.handlers.copyLink}>get-link</button>
      <button onClick={host.handlers.share}>share</button>
      {host.dialogs}
    </>
  );
}
const OWNER = '47000000-0000-4000-8000-000000000071';
beforeEach(() => {
  setPrivateCacheScope(OWNER, 'owner');
  begin.mockImplementation(() => ({ attemptId: crypto.randomUUID(), completed: false }));
  preference.mockResolvedValue({ remembered: false, allowLinkOnCopy: false });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const url = 'https://drive.google.com/file/d/catalog/view';
function clipboard() {
  const writeText = vi.fn().mockRejectedValue(new Error('denied'));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return writeText;
}
it('keeps the URL selectable and retries only clipboard copying after denial', async () => {
  const write = clipboard();
  share.mockResolvedValue({ state: 'ready', url });
  render(<Harness />);
  fireEvent.click(screen.getByText('get-link'));
  await screen.findByDisplayValue(url);
  expect(screen.getByDisplayValue(url)).toHaveProperty('readOnly', true);
  fireEvent.click(screen.getByText('materialActionCopyLink'));
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  expect(share).toHaveBeenCalledTimes(1);
  expect(push).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
});
it('serializes double clicks before the first request settles', async () => {
  clipboard();
  let resolve!: (value: unknown) => void;
  share.mockReturnValue(
    new Promise(r => {
      resolve = r;
    })
  );
  render(<Harness />);
  fireEvent.click(screen.getByText('get-link'));
  fireEvent.click(screen.getByText('get-link'));
  expect(share).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ state: 'ready', url }));
});
it('retries only reads after a lost link response and hides late results from another team', async () => {
  clipboard();
  share.mockRejectedValueOnce(new Error('lost')).mockResolvedValue({ state: 'ready', url });
  const view = render(<Harness />);
  fireEvent.click(screen.getByText('get-link'));
  await waitFor(() => expect(push).toHaveBeenCalled());
  fireEvent.click(screen.getByText('get-link'));
  await screen.findByDisplayValue(url);
  expect(
    share.mock.calls.every(
      ([request]) => request.allowIfRestricted === false && request.rememberChoice === false
    )
  ).toBe(true);
  expect(preference).not.toHaveBeenCalled();
  view.rerender(<Harness teamId="other" />);
  expect(screen.queryByDisplayValue(url)).toBeNull();
});

it('records one correlated share lifecycle after the selectable result appears, even if clipboard is denied', async () => {
  clipboard();
  const attempt = { attemptId: 'attempt', completed: false };
  begin.mockReturnValue(attempt);
  share.mockResolvedValue({ state: 'ready', url });
  render(<Harness />);
  fireEvent.click(screen.getByText('get-link'));
  await screen.findByDisplayValue(url);
  await waitFor(() =>
    expect(complete).toHaveBeenCalledWith(attempt, {
      outcome: 'success',
      retryable: false,
      delivery: 'url_visible'
    })
  );
  expect(begin).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'share',
      storageKind: 'shared_drive',
      surface: 'catalog_manager'
    })
  );
  expect(complete).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('materialActionCopyLink'));
  expect(share).toHaveBeenCalledTimes(1);
  expect(begin).toHaveBeenCalledTimes(1);
});
it('keeps the failed share cause correlated to the same attempt', async () => {
  const attempt = { attemptId: 'failed-attempt', completed: false };
  begin.mockReturnValue(attempt);
  const error = new Error('DRIVE_UNAVAILABLE');
  share.mockRejectedValue(error);
  render(<Harness />);
  fireEvent.click(screen.getByText('get-link'));
  await waitFor(() => expect(reportError).toHaveBeenCalledWith(attempt, error));
  expect(complete).toHaveBeenCalledWith(attempt, { outcome: 'failure', retryable: false });
});

it('gets a link without requesting a permission mutation or saving sharing consent', async () => {
  clipboard();
  share.mockResolvedValue({ state: 'ready', url, public: true, permissionChanged: false });
  render(<Harness />);
  fireEvent.click(screen.getByText('get-link'));
  await screen.findByDisplayValue(url);
  expect(share).toHaveBeenCalledWith(
    expect.objectContaining({
      allowIfRestricted: false,
      rememberChoice: false
    })
  );
});

it('keeps a restricted but verified provider URL available for manual copying', async () => {
  clipboard();
  share.mockResolvedValue({ state: 'confirmation_required', url, public: false, canShare: false });
  render(<Harness />);
  fireEvent.click(screen.getByText('get-link'));
  await screen.findByDisplayValue(url);
  expect(screen.getByDisplayValue(url)).toHaveProperty('readOnly', true);
  expect(push).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'teamShareFailed' }));
});

const restricted = {
  state: 'confirmation_required',
  url,
  public: false,
  canShare: true,
  permissionChanged: false,
  sharing: 'unchanged',
  linkProtocol: 2,
  serverNow: '2026-11-06T00:00:00.000Z',
  shareVersion: null
};
const publicResult = {
  ...restricted,
  state: 'ready',
  public: true,
  permissionChanged: true,
  sharing: 'confirmed',
  shareVersion: '47000000-0000-4000-8000-000000000099'
};
it.each([false, true])(
  'requires explicit consent and remembers only the selected choice (%s)',
  async remember => {
    clipboard();
    share.mockResolvedValueOnce(restricted).mockResolvedValueOnce(publicResult);
    render(<Harness />);
    fireEvent.click(screen.getByText('share'));
    await screen.findByText('creativeLibraryShareApprove');
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]![0]).toMatchObject({
      allowIfRestricted: false,
      rememberChoice: false
    });
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', false);
    if (remember) fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('creativeLibraryShareApprove'));
    await screen.findByText('materialLinkPublic');
    expect(share.mock.calls[1]![0]).toMatchObject({
      allowIfRestricted: true,
      rememberChoice: remember,
      expectedActorId: OWNER,
      expectedShareVersion: null
    });
    expect(share.mock.calls[1]![0].idempotencyKey).toMatch(/^share\.v2:\d{13}:[a-f0-9-]{36}$/);
  }
);
it('uses existing remembered consent without silently remembering a new choice', async () => {
  clipboard();
  preference.mockResolvedValue({ remembered: true, allowLinkOnCopy: true });
  share.mockResolvedValueOnce(restricted).mockResolvedValueOnce(publicResult);
  render(<Harness />);
  fireEvent.click(screen.getByText('share'));
  await screen.findByText('materialLinkPublic');
  expect(share).toHaveBeenCalledTimes(2);
  expect(share.mock.calls[1]![0]).toMatchObject({ allowIfRestricted: true, rememberChoice: false });
});
it('keeps a lost permission write pending and checks by reading only', async () => {
  clipboard();
  share
    .mockResolvedValueOnce(restricted)
    .mockRejectedValueOnce(new Error('lost reply'))
    .mockResolvedValueOnce(publicResult);
  render(<Harness />);
  fireEvent.click(screen.getByText('share'));
  await screen.findByText('creativeLibraryShareApprove');
  fireEvent.click(screen.getByText('creativeLibraryShareApprove'));
  await screen.findByText('materialLinkCheck');
  expect(screen.getByDisplayValue(url)).toHaveProperty('readOnly', true);
  fireEvent.click(screen.getByText('materialLinkCheck'));
  await screen.findByText('materialLinkPublic');
  expect(share).toHaveBeenCalledTimes(3);
  expect(share.mock.calls[2]![0]).toMatchObject({
    allowIfRestricted: false,
    rememberChoice: false
  });
  expect(share.mock.calls.filter(([request]) => request.allowIfRestricted)).toHaveLength(1);
});
it('fences a remembered approval when the actor changes before preference reading settles', async () => {
  clipboard();
  let resolve!: (value: unknown) => void;
  preference.mockReturnValue(
    new Promise(r => {
      resolve = r;
    })
  );
  share.mockResolvedValue(restricted);
  render(<Harness />);
  fireEvent.click(screen.getByText('share'));
  await waitFor(() => expect(preference).toHaveBeenCalledTimes(1));
  await act(async () => {
    setPrivateCacheScope('47000000-0000-4000-8000-000000000072', 'viewer');
    resolve({ remembered: true, allowLinkOnCopy: true });
  });
  expect(share).toHaveBeenCalledTimes(1);
  expect(screen.queryByDisplayValue(url)).toBeNull();
});
it('shows progress while the first read is pending and the verified URL when it settles', async () => {
  let resolve!: (value: unknown) => void;
  share.mockReturnValue(
    new Promise(r => {
      resolve = r;
    })
  );
  render(<Harness />);
  fireEvent.click(screen.getByText('get-link'));
  expect(screen.getByRole('status').textContent).toBe('loading');
  await act(async () => resolve(restricted));
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByDisplayValue(url)).toHaveProperty('readOnly', true);
});
it('closes pending progress immediately and fences a late URL after dismissal', async () => {
  const write = clipboard();
  let resolve!: (value: unknown) => void;
  share.mockReturnValue(
    new Promise(r => {
      resolve = r;
    })
  );
  render(<Harness />);
  fireEvent.click(screen.getByText('get-link'));
  expect(screen.getByRole('status')).not.toBeNull();
  fireEvent.click(screen.getByText('close-link'));
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => resolve(restricted));
  expect(screen.queryByDisplayValue(url)).toBeNull();
  expect(write).not.toHaveBeenCalled();
});
it('bounds a stalled preference read and retains explicit confirmation without opening access', async () => {
  clipboard();
  vi.useFakeTimers();
  preference.mockReturnValue(new Promise(() => {}));
  share.mockResolvedValue(restricted);
  try {
    render(<Harness />);
    await act(async () => {
      fireEvent.click(screen.getByText('share'));
    });
    expect(preference).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_001);
    });
    expect(screen.getByDisplayValue(url)).toHaveProperty('readOnly', true);
    expect(screen.getByText('creativeLibraryShareApprove')).not.toBeNull();
    expect(share).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('correlates explicit confirmation with the Share inspection that asked for consent', async () => {
  clipboard();
  const track = vi.spyOn(analytics, 'track');
  share.mockResolvedValueOnce(restricted).mockResolvedValueOnce(publicResult);
  const started = (step: string) => {
    for (const [event, props] of track.mock.calls) {
      if (
        event !== 'operation_started' ||
        !props ||
        !('flow_step' in props) ||
        props.flow_step !== step
      )
        continue;
      return {
        flow_id: 'flow_id' in props ? props.flow_id : undefined,
        parent_flow_id: 'parent_flow_id' in props ? props.parent_flow_id : undefined
      };
    }
    return undefined;
  };
  try {
    render(<Harness />);
    fireEvent.click(screen.getByText('share'));
    await screen.findByText('creativeLibraryShareApprove');
    const parent = started('material_link_share')?.flow_id;
    expect(parent).toBeTypeOf('string');
    fireEvent.click(screen.getByText('creativeLibraryShareApprove'));
    await screen.findByText('materialLinkPublic');
    const confirmation = started('material_link_confirm');
    expect(confirmation?.parent_flow_id).toBe(parent);
    expect(confirmation?.flow_id).not.toBe(parent);
  } finally {
    track.mockRestore();
  }
});
it('shows the closed visibility failure reason while retaining the verified URL', async () => {
  clipboard();
  share.mockResolvedValue({
    ...restricted,
    public: null,
    canShare: false,
    state: 'ready',
    visibilityCode: 'PERMISSION_DENIED'
  });
  render(<Harness />);
  fireEvent.click(screen.getByText('get-link'));
  await screen.findByDisplayValue(url);
  expect(screen.getByRole('alert').textContent).toBe('teamErrorPermissionDenied');
  expect(screen.getByText('materialLinkCheck')).not.toBeNull();
});

it.each([300_001, 31 * 24 * 60 * 60 * 1000])(
  'requires a fresh inspection after an idle confirmation (%s ms)',
  async elapsed => {
    clipboard();
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    share.mockResolvedValueOnce(restricted).mockResolvedValueOnce(publicResult);
    try {
      render(<Harness />);
      fireEvent.click(screen.getByText('share'));
      await screen.findByText('creativeLibraryShareApprove');
      now.mockReturnValue(elapsed);
      fireEvent.click(screen.getByText('creativeLibraryShareApprove'));
      await screen.findByText('materialLinkExpired');
      expect(share).toHaveBeenCalledTimes(1);
      expect(screen.getByDisplayValue(url)).toHaveProperty('readOnly', true);
      expect(screen.getByText('materialLinkCheck')).not.toBeNull();
    } finally {
      now.mockRestore();
    }
  }
);
