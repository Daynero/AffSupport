import { AGENT_TOOL_CONTRACTS } from '@video-compressor/shared';
import { useId, useMemo, useState } from 'react';
import { AudioLines, FolderOpen, ImagePlus, Shrink, SlidersHorizontal } from 'lucide-react';
import type {
  CatalogMaterialItem,
  TeamProcessStartResult,
  ToolContracts
} from '@video-compressor/shared';
import type { TeamProcessStartInput } from '../../api/team';
import { teamApi } from '../../api/team';
import type { Availability } from '../../AgentContext';
import { ReconnectAction } from '../../components/ReconnectAction';
import { useI18n, type TranslationKey } from '../../i18n';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { FolderPicker, type FolderPickerClient } from '../catalog/FolderPicker';
import { useToasts } from '../../components/toast';
import { teamErrorMessage } from '../errors';
import { Alert, Button, FormField, Input, RadioGroup } from '../../components/ui/index';

type TeamProcessTool = 'compressor' | 'imageEmbedding' | 'transcription' | 'landingOptimizer';

const CONTRACTS: Record<TeamProcessTool, number> = {
  compressor: 3,
  imageEmbedding: 2,
  transcription: AGENT_TOOL_CONTRACTS.transcription,
  landingOptimizer: 2
};

export interface ProcessMaterialClient {
  start(input: TeamProcessStartInput): Promise<TeamProcessStartResult>;
}

const defaultClient: ProcessMaterialClient = {
  start: input => teamApi.startProcess(input)
};

/** What the dialog reads of a material: the explorer's rows and the catalog's items both have it. */
export type ProcessableMaterial = Pick<CatalogMaterialItem, 'id' | 'name' | 'category'>;

export function ProcessMaterialDialog({
  teamId,
  material,
  destinationFolderId,
  agentAvailability,
  toolContracts,
  client = defaultClient,
  browseClient,
  onStarted,
  onClose,
  initialTool
}: {
  teamId: string;
  material: ProcessableMaterial;
  destinationFolderId: string | null;
  /** Reads the folder tree for the destination picker. */
  browseClient: FolderPickerClient;
  /** Whether the local app is there for the work, and if not, why (032 FR-013). */
  agentAvailability: Availability;
  toolContracts: ToolContracts;
  client?: ProcessMaterialClient;
  onStarted: (result: TeamProcessStartResult, input: TeamProcessStartInput) => void;
  onClose: () => void;
  /** Preselect a tool (e.g. transcription from the card's Transcribe). */
  initialTool?: TeamProcessTool;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const tools = useMemo(() => toolsForMaterial(material), [material]);
  const initialToolId: TeamProcessTool =
    initialTool && tools.includes(initialTool) ? initialTool : (tools[0] ?? 'compressor');
  const [toolId, setToolId] = useState<TeamProcessTool>(initialToolId);
  const [outputName, setOutputName] = useState(() => suggestedOutputName(material, initialToolId));
  const [destination, setDestination] = useState(destinationFolderId ?? '');
  const [destinationName, setDestinationName] = useState<string | null>(
    destinationFolderId ? t('teamFolderPickerCurrentFolder') : null
  );
  const [pickingFolder, setPickingFolder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const toolContractVersion = toolContracts[toolId] ?? 0;
  const agentReady = agentAvailability === 'ready';
  const compatible = agentReady && toolContractVersion >= CONTRACTS[toolId];

  const start = async (conflictMode: 'cancel' | 'keep_both') => {
    if (!destination || !compatible || !outputName.trim()) return;
    const input: TeamProcessStartInput = {
      teamId,
      materialId: material.id,
      toolId,
      optionsSummary: {},
      destinationFolderId: destination,
      outputName: outputName.trim(),
      conflictMode,
      idempotencyKey: crypto.randomUUID(),
      agentContractVersion: 1,
      toolContractVersion
    };
    setBusy(true);
    try {
      const result = await client.start(input);
      setConflict(false);
      push({ tone: 'success', text: t('teamToastProcessStarted') });
      onStarted(result, input);
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : 'PROCESS_FAILED';
      // A name clash asks a question; anything else is a failure to announce.
      if (code === 'NAME_CONFLICT') setConflict(true);
      else push({ tone: 'error', text: teamErrorMessage(code, t) });
    } finally {
      setBusy(false);
    }
  };

  const outputId = useId();
  const titleId = useId();

  return (
    <Modal
      labelledBy={titleId}
      size="md"
      className="team-process-dialog"
      onClose={onClose}
      closeLabel={t('teamClose')}
      initialFocus={`[id="${outputId}"]`}
    >
      <h2 id={titleId}>{t('teamProcessTitle', { name: material.name })}</h2>

      {/* The reason, not a boolean (032 FR-013): "update Soty" is said only of
          an agent that answered and is too old; a lost link asks for the link. */}
      {agentAvailability === 'too_old' && (
        <Alert color="warning" variant="soft" live="alert">
          {t('teamProcessAgentUpdate')}
        </Alert>
      )}
      {agentAvailability === 'disconnected' && (
        <Alert
          color="warning"
          variant="soft"
          live="alert"
          action={<ReconnectAction surface="team_process_dialog" />}
        >
          {t('linkConnectSoty')}
        </Alert>
      )}
      {agentAvailability === 'blocked' && (
        <Alert color="warning" variant="soft" live="alert">
          {t('linkBrowserBlocked')}
        </Alert>
      )}
      {agentAvailability === 'account' && (
        <Alert color="warning" variant="soft" live="alert">
          {t('entitlementBlocked')}
        </Alert>
      )}
      {agentReady && !compatible && (
        <Alert color="warning" variant="soft" live="alert">
          {t('teamProcessToolUpdate')}
        </Alert>
      )}
      {/* A choice with names and a line each (070, T060): this was a `<select>`
          whose options were the tools' names and nothing else, so "Додавання
          зображень" beside "Компресор відео" said nothing about which one makes
          the file smaller. One tool needs no choice at all — it is named. */}
      {tools.length > 1 ? (
        <RadioGroup
          label={t('teamProcessTool')}
          value={toolId}
          onChange={next => {
            setToolId(next);
            setOutputName(suggestedOutputName(material, next));
          }}
          options={tools.map(tool => ({
            value: tool,
            label: toolLabel(tool, t),
            description: t(TOOL_CAPTION[tool]),
            icon: toolIcon(tool)
          }))}
        />
      ) : tools[0] ? (
        <p className="team-process-only-tool">
          {toolIcon(tools[0])}
          <span>
            <strong>{toolLabel(tools[0], t)}</strong>
            <small>{t(TOOL_CAPTION[tools[0]])}</small>
          </span>
        </p>
      ) : null}
      {/* A destination is chosen by looking at the folders, not by typing a
          Drive id nothing in the interface ever shows. The old field also
          pre-rendered "no destination" as an error before anyone had done
          anything wrong; the button carries that state instead now. */}
      <FormField label={t('teamFileDestination')}>
        <Button
          color="neutral"
          variant="outline"
          className="team-process-destination"
          onClick={() => setPickingFolder(true)}
        >
          <FolderOpen size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {destinationName ?? t('teamFolderPickerChoose')}
        </Button>
      </FormField>
      {pickingFolder && (
        <FolderPicker
          teamId={teamId}
          client={browseClient}
          title={t('teamProcessDestinationTitle')}
          onClose={() => setPickingFolder(false)}
          onSelect={folder => {
            setDestination(folder.id);
            setDestinationName(folder.name);
            setPickingFolder(false);
          }}
        />
      )}
      <FormField label={t('teamProcessOutputName')} htmlFor={outputId}>
        <Input
          id={outputId}
          value={outputName}
          onChange={event => setOutputName(event.target.value)}
        />
      </FormField>

      {conflict && (
        <Alert
          className="team-file-conflict"
          color="warning"
          variant="soft"
          live="alert"
          action={
            <Button color="neutral" variant="outline" onClick={() => void start('keep_both')}>
              {t('teamFileKeepBoth')}
            </Button>
          }
        >
          {t('teamFileNameConflict')}
        </Alert>
      )}
      <div className="team-dialog-actions">
        <Button color="neutral" variant="ghost" onClick={onClose}>
          {t('teamCancel')}
        </Button>
        <Button
          color="primary"
          variant="solid"
          loading={busy}
          disabled={!compatible || !destination || !outputName.trim()}
          onClick={() => void start('cancel')}
        >
          {t('teamProcessStart')}
        </Button>
      </div>
    </Modal>
  );
}

/** One line under each tool's name — the home screen's own caption where the tool has a page. */
const TOOL_CAPTION: Record<TeamProcessTool, TranslationKey> = {
  compressor: 'videoCompressorCaption',
  transcription: 'transcriptionCaption',
  imageEmbedding: 'teamProcessImageEmbeddingCaption',
  landingOptimizer: 'landingOptimizerCaption'
};

function toolIcon(tool: TeamProcessTool) {
  const Icon =
    tool === 'transcription'
      ? AudioLines
      : tool === 'landingOptimizer'
        ? SlidersHorizontal
        : tool === 'imageEmbedding'
          ? ImagePlus
          : Shrink;
  return <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />;
}

function toolsForMaterial(material: ProcessableMaterial): TeamProcessTool[] {
  if (material.category === 'video') return ['compressor', 'transcription', 'imageEmbedding'];
  if (material.category === 'archive' || material.category === 'landing') {
    return ['landingOptimizer'];
  }
  return [];
}

function suggestedOutputName(material: ProcessableMaterial, tool?: TeamProcessTool) {
  const stem = material.name.replace(/\.[^.]+$/u, '');
  if (tool === 'transcription') return `${stem}.txt`;
  if (tool === 'landingOptimizer') return `${stem}-optimized.zip`;
  return `${stem}-optimized.mp4`;
}

function toolLabel(tool: TeamProcessTool, t: ReturnType<typeof useI18n>['t']) {
  if (tool === 'transcription') return t('teamProcessTranscription');
  if (tool === 'landingOptimizer') return t('teamProcessLanding');
  if (tool === 'imageEmbedding') return t('teamProcessImageEmbedding');
  return t('teamProcessCompressor');
}
