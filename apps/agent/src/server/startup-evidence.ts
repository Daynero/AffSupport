import { readFile, stat } from 'node:fs/promises';
import {
  MACOS_STARTUP_CODES,
  MACOS_STARTUP_STAGES,
  type MacosStartupRecord
} from '@video-compressor/shared';
const PAIRS: Record<string, readonly string[]> = {
  STARTUP_BEGIN: ['boot', 'spawn'],
  STARTUP_NODE_MISSING: ['runtime_check'],
  STARTUP_RUNTIME_MISSING: ['runtime_check'],
  STARTUP_WRONG_ARCHITECTURE: ['spawn'],
  STARTUP_SPAWN_FAILED: ['spawn'],
  STARTUP_EXITED_BEFORE_READY: ['terminal'],
  STARTUP_INTERRUPTED: ['terminal'],
  STARTUP_READY: ['readiness']
};
export function sanitizeStartupEvidence(value: unknown): MacosStartupRecord[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-32).flatMap((row: unknown) => {
    if (
      !row ||
      typeof row !== 'object' ||
      !('schemaVersion' in row) ||
      row.schemaVersion !== 1 ||
      !('attemptId' in row) ||
      typeof row.attemptId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(row.attemptId) ||
      !('timeMs' in row) ||
      typeof row.timeMs !== 'number' ||
      !Number.isSafeInteger(row.timeMs) ||
      row.timeMs < 0 ||
      !('stage' in row) ||
      !MACOS_STARTUP_STAGES.some(stage => stage === row.stage) ||
      !('code' in row) ||
      !MACOS_STARTUP_CODES.some(code => code === row.code) ||
      !('architecture' in row) ||
      !['arm64', 'x64'].includes(String(row.architecture)) ||
      !('buildId' in row) ||
      typeof row.buildId !== 'string' ||
      !/^[A-Za-z0-9.+-]{1,128}$/u.test(row.buildId)
    )
      return [];
    if (!PAIRS[String(row.code)]?.includes(String(row.stage))) return [];
    const stage = MACOS_STARTUP_STAGES.find(stage => stage === row.stage)!;
    const code = MACOS_STARTUP_CODES.find(code => code === row.code)!;
    return [
      {
        schemaVersion: 1,
        attemptId: row.attemptId,
        timeMs: row.timeMs,
        stage,
        code,
        architecture: row.architecture === 'x64' ? 'x64' : 'arm64',
        buildId: row.buildId
      }
    ];
  });
}
export async function readStartupEvidence(
  file: string,
  period: { start?: string | null; end?: string } = {}
) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 32768)
      return { status: 'insufficient', records: [], reason: 'local_evidence_unavailable' };
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    const records = sanitizeStartupEvidence(value).filter(
      row =>
        row.timeMs >= (period.start ? Date.parse(period.start) : 0) &&
        row.timeMs <= (period.end ? Date.parse(period.end) : Number.MAX_SAFE_INTEGER)
    );
    const last = records.at(-1);
    const attempt = last ? records.filter(row => row.attemptId === last.attemptId) : [];
    return {
      status: last ? 'observed' : 'insufficient',
      records,
      lastProvenStage: last?.stage ?? null,
      outcome:
        last?.code === 'STARTUP_READY'
          ? 'ready'
          : last && last.code !== 'STARTUP_BEGIN'
            ? 'failed_or_interrupted'
            : 'insufficient',
      attemptId: last?.attemptId ?? null,
      terminal: attempt.at(-1)?.code ?? null,
      truncated: Array.isArray(value) && value.length > 32,
      earlierHistory: 'unknown',
      windowLimit: 32,
      note: 'Local launcher evidence only. Missing boot, result delivery, physical CPU and remote OS rejection remain unknown.'
    };
  } catch {
    return { status: 'insufficient', records: [], reason: 'local_evidence_unavailable' };
  }
}
