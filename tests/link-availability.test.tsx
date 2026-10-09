// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { Availability } from '../apps/web/src/AgentContext';
import { ToastProvider } from '../apps/web/src/components/toast.js';
import LocalAppDialog from '../apps/web/src/components/LocalAppDialog';
import { translate, type TranslationKey } from '../apps/web/src/i18n';
import { markAgentSeen } from '../apps/web/src/api/client';
import { materialUnavailableMessage } from '../apps/web/src/team/errors';
import {
  LibraryProcessingContextOverride,
  type LibraryProcessingValue
} from '../apps/web/src/team/library/LibraryProcessingProvider';
import { ProcessLibraryDialog } from '../apps/web/src/team/library/ProcessLibraryDialog';
import {
  MATERIAL_ACTIONS,
  type ActionContext,
  type MaterialRef
} from '../apps/web/src/team/materials/actions';
import { ProcessMaterialDialog } from '../apps/web/src/team/processing/ProcessMaterialDialog';
import { renderWithAgent } from './support/fake-agent';

/**
 * 032, US3 / FR-013: a surface says "update Soty" only of an agent that answered
 * and is too old, and "connect Soty" only of one that is not there. The two used
 * to share one boolean, and every surface that read it guessed "update".
 */

vi.mock('../apps/web/src/analytics/service.js', () => ({
  analytics: { track: vi.fn(), setLocale: vi.fn() }
}));

const t = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate('uk', key, values);

const CONNECT = 'Підключіть Soty';
const RECONNECT = 'Перепідключити';
const UPDATE_FILES = t('teamProcessAgentUpdate');

const TEAM_ID = '42000000-0000-4000-8000-000000000001';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('language', 'uk');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the process-material dialog', () => {
  const material = { id: 'm1', name: 'creative.mp4', category: 'video' as const };
  const browseClient = { listMaterials: vi.fn().mockResolvedValue([]) };

  function renderDialog(agentAvailability: Availability) {
    return renderWithAgent(
      <ToastProvider>
        <ProcessMaterialDialog
          teamId={TEAM_ID}
          material={material}
          destinationFolderId="folder-1"
          browseClient={browseClient}
          agentAvailability={agentAvailability}
          toolContracts={{ compressor: 3, transcription: 5, imageEmbedding: 2 }}
          client={{ start: vi.fn() }}
          onStarted={vi.fn()}
          onClose={vi.fn()}
        />
      </ToastProvider>,
      { connection: 'disconnected', toolAvailability: () => agentAvailability }
    );
  }

  it('asks for the link back when the agent is not there', () => {
    renderDialog('disconnected');
    expect(screen.getByText(CONNECT)).toBeTruthy();
    expect(screen.getByRole('button', { name: RECONNECT })).toBeTruthy();
    expect(screen.queryByText(UPDATE_FILES)).toBeNull();
  });

  it('asks for the update when the agent answered and is too old', () => {
    renderDialog('too_old');
    expect(screen.getByText(UPDATE_FILES)).toBeTruthy();
    expect(screen.queryByText(CONNECT)).toBeNull();
    expect(screen.queryByRole('button', { name: RECONNECT })).toBeNull();
  });

  it('says neither when the agent is there and current', () => {
    renderDialog('ready');
    expect(screen.queryByText(UPDATE_FILES)).toBeNull();
    expect(screen.queryByText(CONNECT)).toBeNull();
    expect(screen.queryByRole('button', { name: RECONNECT })).toBeNull();
  });
});

describe('the process-library dialog', () => {
  function batch(agentAvailability: Availability): LibraryProcessingValue {
    return {
      phase: 'ready',
      outcome: null,
      scope: { kind: 'space' },
      scan: {
        created: { transcription: 0, translation: 0, landingOptimization: 0 },
        missing: { transcription: 2, translation: 0, landingOptimization: 0 },
        ready: 0,
        started: false
      },
      // The contracts outlive a lost link, so what this computer does is still known.
      supportedKinds: ['transcription', 'translation'],
      agentAvailability,
      chosenKinds: ['transcription', 'translation'],
      setChosenKinds: vi.fn(),
      previewCount: 0,
      previewError: null,
      previewsChosen: false,
      setPreviewsChosen: vi.fn(),
      activeKind: null,
      done: 0,
      skipped: 0,
      failed: 0,
      failedNames: [],
      total: 2,
      errorCode: null,
      rescan: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      retryFailed: vi.fn().mockResolvedValue(undefined)
    };
  }

  function renderDialog(agentAvailability: Availability) {
    return renderWithAgent(
      <ToastProvider>
        <LibraryProcessingContextOverride value={batch(agentAvailability)}>
          <ProcessLibraryDialog onClose={vi.fn()} />
        </LibraryProcessingContextOverride>
      </ToastProvider>,
      { connection: 'disconnected', toolAvailability: () => agentAvailability }
    );
  }

  it('asks for the link back, keeps the counts, and does not offer to start', () => {
    renderDialog('disconnected');
    expect(screen.getByText(CONNECT)).toBeTruthy();
    expect(screen.getByRole('button', { name: RECONNECT })).toBeTruthy();
    expect(screen.queryByText(UPDATE_FILES)).toBeNull();
    expect(screen.queryByText(t('teamProcessToolUpdate'))).toBeNull();
    // The work is still counted: a lost link empties nothing.
    expect(screen.getByText(t('teamBatchTranscriptions'))).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: t('teamBatchStartCount', { count: 2 }) })
    ).toBeNull();
  });

  it('asks for the update when the agent is too old', () => {
    renderDialog('too_old');
    expect(screen.getByText(UPDATE_FILES)).toBeTruthy();
    expect(screen.queryByText(CONNECT)).toBeNull();
    expect(screen.queryByRole('button', { name: RECONNECT })).toBeNull();
  });

  it('says neither and offers to start when the agent is there', () => {
    renderDialog('ready');
    expect(screen.queryByText(UPDATE_FILES)).toBeNull();
    expect(screen.queryByText(CONNECT)).toBeNull();
    expect(
      screen.getByRole('button', { name: t('teamBatchStartCount', { count: 2 }) })
    ).toBeTruthy();
  });
});

describe('material actions', () => {
  const video: MaterialRef = {
    id: 'm1',
    teamId: 't1',
    name: 'clip.mp4',
    kind: 'file',
    category: 'video',
    availability: 'ready'
  };
  const context = (agentAvailability: Availability): ActionContext => ({
    host: 'explorer-row',
    permissions: {
      view: true,
      download: true,
      upload: true,
      edit: true,
      delete: true,
      process: true,
      manage_members: true,
      manage_metadata: true
    },
    isOwner: true,
    agentAvailability,
    storageConnected: true,
    restitchConfigured: true,
    catalogSettingsReady: true
  });
  const transcribe = MATERIAL_ACTIONS.find(action => action.id === 'transcribe')!;

  it('give the nearest true reason: not running, too old, or nothing', () => {
    const lost = transcribe.available(video, context('disconnected'));
    expect(lost).toEqual({ ok: false, reason: 'AGENT_REQUIRED' });
    expect(materialUnavailableMessage('AGENT_REQUIRED', t)).toBe(
      'Soty не запущений на цьому комп’ютері'
    );

    const old = transcribe.available(video, context('too_old'));
    expect(old).toEqual({ ok: false, reason: 'AGENT_UPDATE_REQUIRED' });
    expect(materialUnavailableMessage('AGENT_UPDATE_REQUIRED', t)).toBe(
      t('teamErrorAgentUpdateRequired')
    );

    expect(transcribe.available(video, context('ready'))).toEqual({ ok: true });
  });
});

describe('the local app dialog', () => {
  it('never asks for an update of an agent that is merely not connected', () => {
    markAgentSeen();
    renderWithAgent(<LocalAppDialog tool="transcription" connection="disconnected" />, {
      connection: 'disconnected',
      toolAvailable: () => false,
      toolAvailability: () => 'disconnected'
    });
    expect(screen.queryByRole('heading', { name: t('localAppUpdateTitle') })).toBeNull();
    expect(screen.getByRole('heading', { name: t('localAppOpenTitle') })).toBeTruthy();
    expect(screen.getByRole('button', { name: RECONNECT })).toBeTruthy();
  });

  it('asks for the update only of an agent that answered and is too old', () => {
    renderWithAgent(<LocalAppDialog tool="transcription" connection="connected" />, {
      connection: 'connected',
      toolAvailable: () => false,
      toolAvailability: () => 'too_old'
    });
    expect(screen.getByRole('heading', { name: t('localAppUpdateTitle') })).toBeTruthy();
  });
});
