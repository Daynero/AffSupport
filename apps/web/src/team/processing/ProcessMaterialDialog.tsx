import { useMemo, useState } from 'react';
import type {
  CatalogMaterialItem,
  TeamProcessStartResult,
  ToolContracts
} from '@video-compressor/shared';
import type { TeamProcessStartInput } from '../../api/team';
import { teamApi } from '../../api/team';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { Modal } from '../../components/Modal';
import { FolderPicker, type FolderPickerClient } from '../catalog/FolderPicker';
import { useToasts } from '../../components/toast';
import { teamErrorMessage } from '../errors';

type TeamProcessTool = 'compressor' | 'imageEmbedding' | 'transcription' | 'landingOptimizer';

const CONTRACTS: Record<TeamProcessTool, number> = {
  compressor: 3,
  imageEmbedding: 2,
  transcription: 5,
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
  agentCompatible,
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
  agentCompatible: boolean;
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
  const [toolId, setToolId] = useState<TeamProcessTool>(
    initialTool && tools.includes(initialTool) ? initialTool : (tools[0] ?? 'compressor')
  );
  const [outputName, setOutputName] = useState(() => suggestedOutputName(material, tools[0]));
  const [destination, setDestination] = useState(destinationFolderId ?? '');
  const [destinationName, setDestinationName] = useState<string | null>(
    destinationFolderId ? t('teamFolderPickerCurrentFolder') : null
  );
  const [pickingFolder, setPickingFolder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const toolContractVersion = toolContracts[toolId] ?? 0;
  const compatible = agentCompatible && toolContractVersion >= CONTRACTS[toolId];

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

  return (
    <Modal
      labelledBy="team-process-title"
      size="lg"
      className="team-process-dialog"
      onClose={onClose}
    >
      <div className="team-panel-heading">
        <div>
          <p className="team-workspace-eyebrow">{t('teamProcessEyebrow')}</p>
          <h3 id="team-process-title">{t('teamProcessTitle', { name: material.name })}</h3>
        </div>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('teamCancel')}
        </Button>
      </div>

      {!agentCompatible && <p className="team-inline-error">{t('teamProcessAgentUpdate')}</p>}
      {agentCompatible && !compatible && (
        <p className="team-inline-error">{t('teamProcessToolUpdate')}</p>
      )}
      <label>
        {t('teamProcessTool')}
        <select
          value={toolId}
          onChange={event => {
            const next = event.target.value as TeamProcessTool;
            setToolId(next);
            setOutputName(suggestedOutputName(material, next));
          }}
        >
          {tools.map(tool => (
            <option key={tool} value={tool}>
              {toolLabel(tool, t)}
            </option>
          ))}
        </select>
      </label>
      {/* A destination is chosen by looking at the folders, not by typing a
          Drive id nothing in the interface ever shows. The old field also
          pre-rendered "no destination" as an error before anyone had done
          anything wrong; the button carries that state instead now. */}
      <div className="team-process-destination">
        <span className="team-field-label">{t('teamFileDestination')}</span>
        <Button type="button" variant="secondary" onClick={() => setPickingFolder(true)}>
          {destinationName ?? t('teamFolderPickerChoose')}
        </Button>
      </div>
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
      <label>
        {t('teamProcessOutputName')}
        <input
          id="team-process-output-name"
          value={outputName}
          onChange={event => setOutputName(event.target.value)}
        />
      </label>

      {conflict && (
        <div className="team-file-conflict" role="alert">
          <p>{t('teamFileNameConflict')}</p>
          <Button type="button" onClick={() => void start('keep_both')}>
            {t('teamFileKeepBoth')}
          </Button>
        </div>
      )}
      <div className="team-dialog-actions">
        <Button
          type="button"
          variant="primary"
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
