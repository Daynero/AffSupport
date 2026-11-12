import { TeamApiError } from '../../api/team';
import { parseCatalogCommandReceipt, type CatalogCommandReceipt } from '@video-compressor/shared';
import {
  normalizeCatalogCommandIntent,
  type CatalogCommandIntent,
  type CatalogCommandJournal
} from './catalogCommandJournal';
export type CommandOutcome =
  | { kind: 'confirmed'; receipt: CatalogCommandReceipt }
  | { kind: 'rejected' | 'unknown' | 'obsolete'; error: unknown };
export interface CommandState {
  intent: CatalogCommandIntent;
  phase: 'working' | 'unknown';
  error?: unknown;
}
interface Dependencies {
  journal: Pick<CatalogCommandJournal, 'list' | 'put' | 'remove'>;
  request: (intent: CatalogCommandIntent) => Promise<unknown>;
  read: (commandId: string, signal: AbortSignal) => Promise<unknown | null>;
  cancel: (intent: CatalogCommandIntent) => Promise<unknown>;
  wait: <T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) => Promise<T>;
  definiteRejection: (error: unknown) => boolean;
  changed: () => void;
  isCurrent: () => boolean;
}
/** One owner for pending command identities. Reading cannot execute or resend an intent. */
export class CatalogCommandCoordinator {
  private active = true;
  private locked = new Set<string>();
  private controllers = new Set<AbortController>();
  readonly states = new Map<string, CommandState>();
  private readonly deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
    for (const intent of deps.journal.list())
      this.states.set(intent.commandId, { intent, phase: 'unknown' });
  }
  private current(): boolean {
    return this.active && this.deps.isCurrent();
  }
  blocked(catalogId: string): boolean {
    return [...this.states.values()].some(state => state.intent.catalogIds.includes(catalogId));
  }
  dispose(): void {
    this.active = false;
    for (const controller of this.controllers) controller.abort();
  }
  async submit(input: CatalogCommandIntent): Promise<CommandOutcome> {
    if (!this.current()) return { kind: 'obsolete', error: new Error('SCOPE_CHANGED') };
    const intent = normalizeCatalogCommandIntent(input);
    if (!intent) return { kind: 'rejected', error: new TeamApiError('INVALID_INPUT', false) };
    if (this.locked.size >= 4 || intent.catalogIds.some(id => this.blocked(id)))
      return { kind: 'rejected', error: new TeamApiError('WRONG_STATE', false) };
    // Persist before dispatch. A storage refusal sends no server mutation.
    try {
      this.deps.journal.put(intent);
    } catch (error) {
      return { kind: 'rejected', error };
    }
    this.states.set(intent.commandId, { intent, phase: 'working' });
    return this.perform(intent, 'request');
  }
  async reconcile(commandId: string): Promise<CommandOutcome> {
    const state = this.states.get(commandId);
    if (!state) return { kind: 'rejected', error: new TeamApiError('NOT_FOUND', false) };
    return this.perform(state.intent, 'read');
  }
  async cancel(commandId: string): Promise<CommandOutcome> {
    const state = this.states.get(commandId);
    if (!state) return { kind: 'rejected', error: new TeamApiError('NOT_FOUND', false) };
    return this.perform(state.intent, 'cancel');
  }
  private notify(): void {
    try {
      this.deps.changed();
    } catch {
      /* Rendering cannot change command authority. */
    }
  }
  private async perform(
    intent: CatalogCommandIntent,
    mode: 'request' | 'read' | 'cancel'
  ): Promise<CommandOutcome> {
    if (!this.current()) return { kind: 'obsolete', error: new Error('SCOPE_CHANGED') };
    if (this.locked.size >= 4 || this.locked.has(intent.commandId))
      return { kind: 'rejected', error: new TeamApiError('WRONG_STATE', false) };
    this.locked.add(intent.commandId);
    this.states.set(intent.commandId, { intent, phase: 'working' });
    this.notify();
    const controller = new AbortController();
    this.controllers.add(controller);
    const obsolete = (): CommandOutcome => ({
      kind: 'obsolete',
      error: new Error('SCOPE_CHANGED')
    });
    const observe = (value: unknown): CatalogCommandReceipt | null =>
      parseCatalogCommandReceipt(value, intent);
    const confirm = (receipt: CatalogCommandReceipt): CommandOutcome => {
      this.states.delete(intent.commandId);
      try {
        this.deps.journal.remove(intent.commandId);
      } catch {
        /* Safe to re-read this sealed receipt on reload. */
      }
      return { kind: 'confirmed', receipt };
    };
    let error: unknown;
    try {
      if (!this.current()) return obsolete();
      try {
        const value = await this.deps.wait(
          signal =>
            mode === 'read'
              ? this.deps.read(intent.commandId, signal)
              : mode === 'cancel'
                ? this.deps.cancel(intent)
                : this.deps.request(intent),
          controller.signal
        );
        if (!this.current()) return obsolete();
        const receipt = observe(value);
        if (receipt) return confirm(receipt);
        error = new TeamApiError(
          value === null ? 'PROCESS_RESULT_UNCERTAIN' : 'INVALID_RESPONSE',
          true
        );
      } catch (cause) {
        if (!this.current()) return obsolete();
        error = cause;
        if (mode === 'request' && this.deps.definiteRejection(cause)) {
          this.states.delete(intent.commandId);
          try {
            this.deps.journal.remove(intent.commandId);
          } catch {
            /* Future reconciliation cannot write. */
          }
          return { kind: 'rejected', error: cause };
        }
      }
      // A read failure/null is not retried in a loop. Dispatched writes get one bounded readback.
      if (mode !== 'read') {
        try {
          const value = await this.deps.wait(
            signal => this.deps.read(intent.commandId, signal),
            controller.signal
          );
          if (!this.current()) return obsolete();
          const receipt = observe(value);
          if (receipt) return confirm(receipt);
        } catch (cause) {
          error = cause;
        }
      }
      if (!this.current()) return obsolete();
      this.states.set(intent.commandId, { intent, phase: 'unknown', error });
      return { kind: 'unknown', error };
    } finally {
      this.locked.delete(intent.commandId);
      this.controllers.delete(controller);
      if (this.current()) this.notify();
    }
  }
}

/** End local waiting without claiming that a server mutation was cancelled. */
/**
 * How long after sending a catalog creation a read that finds nothing still means "on its
 * way". Well past the command deadline and a retried edge call; after it, the server's empty
 * answer means nothing was created (production 2026-11-12).
 */
export const CREATION_NOT_RECEIVED_AFTER_MS = 90_000;

export function withCatalogCommandDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  milliseconds = 15_000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (success: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parent.removeEventListener('abort', abort);
      controller.abort();
      if (success) resolve(value as T);
      else reject(value);
    };
    const abort = () => finish(false, new DOMException('Catalog scope changed', 'AbortError'));
    const timer = setTimeout(
      () => finish(false, new TeamApiError('PROCESS_RESULT_UNCERTAIN', true)),
      milliseconds
    );
    parent.addEventListener('abort', abort, { once: true });
    if (parent.aborted) {
      abort();
      return;
    }
    try {
      work(controller.signal).then(
        value => finish(true, value),
        error => finish(false, error)
      );
    } catch (error) {
      finish(false, error);
    }
  });
}
