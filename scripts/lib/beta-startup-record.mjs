import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Claim before starting anything, then retain enough ownership for beta:down after a failure. */
export function claimBetaStartup(file, initial) {
  const ownerId = randomUUID();
  let record = { ...initial, ownerId };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  function publish(next, claim) {
    const temporary = `${file}.${ownerId}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
    try {
      if (claim) {
        // link is both atomic and exclusive: another startup's journal wins.
        linkSync(temporary, file);
      } else {
        if (JSON.parse(readFileSync(file, 'utf8')).ownerId !== ownerId)
          throw new Error('BETA_STARTUP_OWNERSHIP_CHANGED');
        renameSync(temporary, file);
      }
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  publish(record, true);
  return {
    update(fields) {
      const next = { ...record, ...fields, ownerId };
      publish(next, false);
      record = next;
    }
  };
}
