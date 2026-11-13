/** Rename changes Drive's version even when its binary content is unchanged. */
export interface RenamePreviewIdentity {
  checksum: string | null;
  size: number | null;
  mimeType: string | null;
}

/** Commit authority first; an optional thumbnail repair must never replay a rename. */
export async function commitRenameWithPreview<T>(input: {
  before: RenamePreviewIdentity;
  after: RenamePreviewIdentity;
  commit: () => Promise<T>;
  preserve: () => Promise<void>;
}): Promise<T> {
  const result = await input.commit();
  if (
    input.before.checksum &&
    input.before.checksum === input.after.checksum &&
    input.before.size !== null &&
    input.before.size === input.after.size &&
    input.before.mimeType !== null &&
    input.before.mimeType === input.after.mimeType
  ) {
    // Missing cache bytes or a provider outage fall back to ordinary preview warming.
    await input.preserve().catch(() => undefined);
  }
  return result;
}
