/**
 * The adversarial suite as data (009 SC-008).
 *
 * SC-008 asks for "at least thirty attack attempts, refused in 100% of cases" — a number. A
 * number is only worth something if it is counted from the attempts that actually run, so
 * each adversarial area keeps its attempts here as a table: the area's own test file runs the
 * table one `it` per attempt, and `tests/adversarial-suite-size.test.ts` runs every table
 * again and counts. An attempt added to an area is counted the moment it exists; an attempt
 * that stops being refused fails both files.
 *
 * An attempt reports what happened rather than asserting, so the counter can tell "refused"
 * from "let through" without catching assertion errors.
 */

export interface AttemptOutcome {
  refused: boolean;
  /** What the target actually did, for the failure message: a status and a code, never a secret. */
  evidence: string;
}

export interface AdversarialAttempt<Target> {
  name: string;
  attempt(target: Target): Promise<AttemptOutcome>;
}

export interface AdversarialSuite<Target> {
  /** The test file that runs this table one attempt per `it`. */
  testFile: string;
  /** A fresh target per attempt, so no attempt depends on another's leftovers. */
  start(): Promise<Target & { stop(): Promise<void> }>;
  attempts: readonly AdversarialAttempt<Target>[];
}

/** Runs one attempt against a fresh target and always stops the target. */
export async function runAttempt<Target>(
  suite: AdversarialSuite<Target>,
  attempt: AdversarialAttempt<Target>
): Promise<AttemptOutcome> {
  const target = await suite.start();
  try {
    return await attempt.attempt(target);
  } finally {
    await target.stop();
  }
}

export function outcome(refused: boolean, evidence: string): AttemptOutcome {
  return { refused, evidence };
}

/** A multipart/form-data body Fastify's `inject` accepts. */
export function multipartBody(
  parts: readonly (
    | { kind: 'field'; name: string; value: string }
    | { kind: 'file'; name: string; filename: string; content: Buffer | string }
  )[]
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----soty-adversarial-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.kind === 'field') {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`)
      );
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            'Content-Type: application/octet-stream\r\n\r\n'
        ),
        typeof part.content === 'string' ? Buffer.from(part.content) : part.content,
        Buffer.from('\r\n')
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
  };
}
