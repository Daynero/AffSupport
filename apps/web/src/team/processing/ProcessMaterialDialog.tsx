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

export function ProcessMaterialDialog({
  teamId,
  material,
  destinationFolderId,
  agentCompatible,
  toolContracts,
  client = defaultClient,
  onStarted,
  onClose
}: {
  teamId: string;
  material: CatalogMaterialItem;
  destinationFolderId: string | null;
  agentCompatible: boolean;
  toolContracts: ToolContracts;
  client?: ProcessMaterialClient;
  onStarted: (result: TeamProcessStartResult, input: TeamProcessStartInput) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const tools = useMemo(() => toolsForMaterial(material), [material]);
  const [toolId, setToolId] = useState<TeamProcessTool>(tools[0] ?? 'compressor');
  const [outputName, setOutputName] = useState(() => suggestedOutputName(material, tools[0]));
  const [destination, setDestination] = useState(destinationFolderId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
    try {
      const result = await client.start(input);
      setConflict(false);
      onStarted(result, input);
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : 'PROCESS_FAILED';
      if (code === 'NAME_CONFLICT') setConflict(true);
      else setError(code);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="team-process-dialog" aria-labelledby="team-process-title">
      <div className="team-panel-heading">
        <div>
          <p className="team-workspace-eyebrow">{t('teamProcessEyebrow')}</p>
          <h3 id="team-process-title">{t('teamProcessTitle', { name: material.name })}</h3>
        </div>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('teamFileCancel')}
        </Button>
      </div>

      {!agentCompatible && <p className="team-inline-error">{t('teamProcessAgentUpdate')}</p>}
      {agentCompatible && !compatible && (
        <p className="team-inline-error">{t('teamProcessToolUpdate')}</p>
      )}
      {!destination && <p className="team-inline-error">{t('teamProcessDestinationMissing')}</p>}

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
      <label>
        {t('teamFileDestination')}
        <input value={destination} onChange={event => setDestination(event.target.value)} />
      </label>
      <label>
        {t('teamProcessOutputName')}
        <input value={outputName} onChange={event => setOutputName(event.target.value)} />
      </label>

      {conflict && (
        <div className="team-file-conflict" role="alert">
          <p>{t('teamFileNameConflict')}</p>
          <Button type="button" onClick={() => void start('keep_both')}>
            {t('teamFileKeepBoth')}
          </Button>
        </div>
      )}
      {error && (
        <p className="team-inline-error" role="alert">
          {error}
        </p>
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
    </section>
  );
}

function toolsForMaterial(material: CatalogMaterialItem): TeamProcessTool[] {
  if (material.category === 'video') return ['compressor', 'transcription', 'imageEmbedding'];
  if (material.category === 'archive' || material.category === 'landing') {
    return ['landingOptimizer'];
  }
  return [];
}

function suggestedOutputName(material: CatalogMaterialItem, tool?: TeamProcessTool) {
  const stem = material.name.replace(/\.[^.]+$/u, '');
  if (tool === 'transcription') return `${stem}-transcript.txt`;
  if (tool === 'landingOptimizer') return `${stem}-optimized.zip`;
  return `${stem}-optimized.mp4`;
}

function toolLabel(tool: TeamProcessTool, t: ReturnType<typeof useI18n>['t']) {
  if (tool === 'transcription') return t('teamProcessTranscription');
  if (tool === 'landingOptimizer') return t('teamProcessLanding');
  if (tool === 'imageEmbedding') return t('teamProcessImageEmbedding');
  return t('teamProcessCompressor');
}
