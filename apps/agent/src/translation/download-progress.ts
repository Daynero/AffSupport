/**
 * Aggregate download progress across the several models the transcription tool
 * needs (Whisper speech model + TranslateGemma translator + any alignment
 * model). Progress is byte-weighted so a small model finishing does not jump
 * the bar; models already present contribute nothing to the remaining work, so
 * a partial install only downloads what is missing.
 */
export interface ModelDownloadState {
  label: string;
  present: boolean;
  /** Total size in bytes (0 when unknown). */
  sizeBytes: number;
  /** Bytes fetched so far for this model in the current session. */
  downloadedBytes: number;
}

export interface CompositeDownloadProgress {
  /** Sum of sizes of the models that still need downloading. */
  totalBytes: number;
  /** Bytes fetched of those still-missing models. */
  downloadedBytes: number;
  /** 0–100 across the missing models, 100 when nothing is missing, null when unknown. */
  progress: number | null;
  /** Labels of the models still missing, for the confirmation prompt. */
  remaining: string[];
}

export function weightedDownloadProgress(
  models: readonly ModelDownloadState[]
): CompositeDownloadProgress {
  const missing = models.filter(model => !model.present);
  const totalBytes = missing.reduce((total, model) => total + Math.max(0, model.sizeBytes), 0);
  const downloadedBytes = missing.reduce(
    (total, model) =>
      total + Math.min(Math.max(0, model.downloadedBytes), Math.max(0, model.sizeBytes)),
    0
  );

  let progress: number | null;
  if (missing.length === 0) {
    progress = 100;
  } else if (totalBytes <= 0) {
    progress = null; // sizes unknown — indeterminate
  } else {
    progress = Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100));
  }

  return { totalBytes, downloadedBytes, progress, remaining: missing.map(model => model.label) };
}
