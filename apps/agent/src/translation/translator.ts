import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import type { AlignmentLink } from '@video-compressor/shared';
import {
  TRANSLATION_MODEL_DESCRIPTOR,
  TRANSLATION_RUNTIME_DESCRIPTOR,
  translationModelPath,
  translationModelPresent,
  translationRuntimePath,
  translationRuntimePresent
} from './tools.js';

export interface TranslationInputSegment {
  id: string;
  text: string;
}

export interface TranslateRequest {
  sourceLanguage: string;
  targetLanguage: string;
  segments: TranslationInputSegment[];
  /**
   * Called as each segment finishes (in completion order, carrying its original
   * index). Lets the caller pipeline downstream work — e.g. start CPU alignment
   * on a segment while later segments are still translating on the GPU — and
   * report real progress.
   */
  onSegment?: (segment: TranslationOutputSegment, index: number) => void;
}

export interface TranslationOutputSegment {
  sourceSegmentId: string;
  translatedText: string;
  /** Source↔target character alignments, or [] when only sentence-level is known. */
  alignments: AlignmentLink[];
}

/**
 * A local translation engine. Implementations run one inference at a time,
 * honor AbortSignal, never expose an unsecured network port, and keep the model
 * warm across calls.
 */
export interface Translator {
  available(): boolean;
  modelVersion(): string;
  translate(request: TranslateRequest, signal: AbortSignal): Promise<TranslationOutputSegment[]>;
  close?(): Promise<void>;
}

export interface LocalLlamaHttpResult {
  statusCode: number;
  body: string;
}

interface CompletionResponse {
  content?: unknown;
  error?: { message?: unknown };
}

const START_TIMEOUT_MS = 120_000;
// Killing the server frees ~2.5 GB of RAM but makes the next translation pay a
// full cold model load (up to two minutes). Five minutes proved far too eager —
// a user pausing between creatives hit a cold start every time — so idle exit
// waits half an hour.
const IDLE_EXIT_MS = 30 * 60_000;
// Keep the model resident for as long as the process lives; IDLE_EXIT_MS already
// kills the whole process to free RAM. A short sleep-idle used to unload weights
// mid-job (e.g. during a pause between segments), forcing a costly reload.
const MODEL_SLEEP_SECONDS = 24 * 60 * 60;
// Number of segments translated concurrently. Matches the server's slot count
// so llama.cpp continuous-batches them in one forward pass instead of decoding
// one segment at a time. Transcript lines are short, so per-request overhead
// dominates — six slots keep the GPU fed without exhausting the shared context
// (which scales with the slot count below).
const TRANSLATION_CONCURRENCY = 6;

function normalizedLanguage(code: string): string {
  const parts = code.trim().replaceAll('_', '-').split('-').filter(Boolean);
  if (!parts.length) return '';
  return parts
    .map((part, index) => {
      if (index === 0) return part.toLowerCase();
      if (part.length === 2 || /^\d{3}$/u.test(part)) return part.toUpperCase();
      if (part.length === 4) return `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`;
      return part.toLowerCase();
    })
    .join('-');
}

/**
 * TranslateGemma runs in a long-lived official llama.cpp server bound only to
 * the loopback interface on a dynamically reserved port. Every request must
 * present a per-launch random API key so other local processes cannot use the
 * model, logs are disabled so transcript contents never enter diagnostics, and
 * an idle timer terminates it to release RAM.
 */
export class LlamaTranslator implements Translator {
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private apiKey = '';
  private starting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private inferenceTail: Promise<void> = Promise.resolve();

  available(): boolean {
    return translationModelPresent() && translationRuntimePresent();
  }

  modelVersion(): string {
    return [
      'translategemma-4b-it-q4_k_m',
      TRANSLATION_MODEL_DESCRIPTOR.sha256.slice(0, 16),
      `llama.cpp-${TRANSLATION_RUNTIME_DESCRIPTOR.tag}`
    ].join('@');
  }

  async translate(
    request: TranslateRequest,
    signal: AbortSignal
  ): Promise<TranslationOutputSegment[]> {
    if (!this.available()) throw new Error('TRANSLATOR_UNAVAILABLE');
    const sourceLanguage = normalizedLanguage(request.sourceLanguage);
    const targetLanguage = normalizedLanguage(request.targetLanguage);
    if (!sourceLanguage || sourceLanguage === 'auto') {
      throw new Error('SOURCE_LANGUAGE_UNKNOWN');
    }
    if (!targetLanguage || targetLanguage === 'auto') {
      throw new Error('TARGET_LANGUAGE_UNSUPPORTED');
    }

    return this.withInferenceLock(signal, async () => {
      await this.ensureServer(signal);
      this.clearIdleTimer();
      const segments = request.segments;
      const out: TranslationOutputSegment[] = new Array(segments.length);
      let nextIndex = 0;
      try {
        // A bounded pool: each worker pulls the next segment index and issues its
        // own /completion request. The server batches the concurrent requests
        // across its slots. Order is preserved by writing into out[index].
        const worker = async (): Promise<void> => {
          for (;;) {
            const index = nextIndex++;
            if (index >= segments.length) return;
            if (signal.aborted) throw abortError();
            const segment = segments[index];
            const translatedText = await this.runOne(
              sourceLanguage,
              targetLanguage,
              segment.text,
              signal
            );
            const result: TranslationOutputSegment = {
              sourceSegmentId: segment.id,
              translatedText,
              alignments: []
            };
            out[index] = result;
            request.onSegment?.(result, index);
          }
        };
        const pool = Math.min(TRANSLATION_CONCURRENCY, segments.length);
        await Promise.all(Array.from({ length: pool }, () => worker()));
        return out;
      } finally {
        this.scheduleIdleExit();
      }
    });
  }

  async close(): Promise<void> {
    this.clearIdleTimer();
    const child = this.child;
    this.child = null;
    this.port = null;
    if (child && child.exitCode === null) {
      await new Promise<void>(resolve => {
        const force = setTimeout(() => child.kill('SIGKILL'), 3_000);
        force.unref();
        child.once('exit', () => {
          clearTimeout(force);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
  }

  private async ensureServer(signal: AbortSignal): Promise<void> {
    if (this.child?.exitCode === null && this.port) {
      const health = await localLlamaHttpRequest(
        this.port,
        this.apiKey,
        'GET',
        '/health',
        undefined,
        signal
      ).catch(() => null);
      if (health?.statusCode === 200) return;
    }
    if (!this.starting) {
      this.starting = this.startServer().finally(() => {
        this.starting = null;
      });
    }
    await abortable(this.starting, signal);
  }

  private async withInferenceLock<T>(signal: AbortSignal, inference: () => Promise<T>): Promise<T> {
    const predecessor = this.inferenceTail;
    let release = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    // Even when a queued request is cancelled, its already-resolved gate stays
    // chained after the predecessor. A later request therefore cannot jump
    // ahead of an inference that is still running.
    this.inferenceTail = predecessor.catch(() => undefined).then(() => gate);
    try {
      await abortable(predecessor, signal);
      return await inference();
    } finally {
      release();
    }
  }

  private async startServer(): Promise<void> {
    await this.close();
    const port = await reserveLoopbackPort();
    const apiKey = randomBytes(32).toString('hex');
    const child = spawn(
      translationRuntimePath(),
      [
        '--model',
        translationModelPath(),
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--api-key',
        apiKey,
        // Context is shared across slots, so scale it with the slot count to
        // keep ~2048 tokens per concurrent segment.
        '--ctx-size',
        String(2048 * TRANSLATION_CONCURRENCY),
        '--parallel',
        String(TRANSLATION_CONCURRENCY),
        '--n-gpu-layers',
        '99',
        // TranslateGemma's intentionally strict structured Jinja template
        // cannot pass llama-server's startup-time generic string-message
        // autoparser probe. Keep inference on the raw /completion endpoint and
        // render that exact translation prompt ourselves; a built-in template
        // is selected only so the unused chat endpoint can initialize.
        '--no-jinja',
        '--chat-template',
        'gemma',
        '--no-webui',
        '--log-disable',
        '--sleep-idle-seconds',
        String(MODEL_SLEEP_SECONDS)
      ],
      {
        shell: false,
        // Prompts and translations must never be copied into Wishly logs.
        stdio: ['ignore', 'ignore', 'ignore']
      }
    );
    this.child = child;
    this.port = port;
    this.apiKey = apiKey;

    let spawnError: Error | null = null;
    child.once('error', error => {
      spawnError = error;
    });
    child.once('exit', () => {
      if (this.child === child) this.child = null;
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error('The local translation runtime could not start.');
      if (child.exitCode !== null) {
        throw new Error('The local translation runtime exited during startup.');
      }
      const health = await localLlamaHttpRequest(port, apiKey, 'GET', '/health', undefined).catch(
        () => null
      );
      if (health?.statusCode === 200) return;
      await delay(100);
    }
    await this.close();
    throw new Error('The local translation model took too long to load.');
  }

  private async runOne(
    sourceLanguage: string,
    targetLanguage: string,
    text: string,
    signal: AbortSignal
  ): Promise<string> {
    if (!this.port) throw new Error('TRANSLATOR_UNAVAILABLE');
    const result = await localLlamaHttpRequest(
      this.port,
      this.apiKey,
      'POST',
      '/completion',
      {
        prompt: translationPrompt(sourceLanguage, targetLanguage, text),
        // A translation is roughly the length of its source; cap generation to a
        // generous multiple of the input so a short segment can't spend the full
        // budget over-generating. The 768 ceiling keeps genuinely long lines from
        // being silently truncated mid-sentence while still fitting the ~2048
        // tokens/slot context. `temperature:0` keeps it deterministic.
        n_predict: Math.min(768, Math.ceil(text.length * 1.5) + 48),
        temperature: 0,
        top_p: 1,
        stream: false,
        cache_prompt: true,
        stop: ['<end_of_turn>']
      },
      signal
    );
    let parsed: CompletionResponse;
    try {
      parsed = JSON.parse(result.body) as CompletionResponse;
    } catch {
      throw new Error('The local translator returned an invalid response.');
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      // Deliberately do not include the server body; a model error can echo its
      // prompt, which contains private transcript text.
      throw new Error('The local translator rejected the translation request.');
    }
    const content = parsed.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('The local translator returned an empty translation.');
    }
    return content.trim();
  }

  private scheduleIdleExit(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.close();
    }, IDLE_EXIT_MS);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/**
 * Renders the text-only branch of TranslateGemma's embedded Jinja template.
 * llama-server automatically prepends the model BOS token for /completion, so
 * the prompt starts at `<start_of_turn>` to avoid a duplicate BOS.
 */
export function translationPrompt(
  sourceLanguage: string,
  targetLanguage: string,
  text: string
): string {
  const sourceName = englishLanguageName(sourceLanguage);
  const targetName = englishLanguageName(targetLanguage);
  return (
    `<start_of_turn>user\n` +
    `You are a professional ${sourceName} (${sourceLanguage}) to ${targetName} (${targetLanguage}) translator. ` +
    `Your goal is to accurately convey the meaning and nuances of the original ${sourceName} text while adhering ` +
    `to ${targetName} grammar, vocabulary, and cultural sensitivities.\n` +
    `Produce only the ${targetName} translation, without any additional explanations or commentary. ` +
    `Please translate the following ${sourceName} text into ${targetName}:\n\n\n` +
    `${text.trim()}\n<end_of_turn>\n<start_of_turn>model\n`
  );
}

function englishLanguageName(code: string): string {
  const base = code.split('-')[0].toLowerCase();
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(base);
    if (name) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    // Fall back to the code; llama.cpp has already validated the BCP-47 tag.
  }
  return base.toUpperCase();
}

/**
 * Reserves a free TCP port on the loopback interface for a llama.cpp server.
 * The port is bound and released again; the tiny window before llama-server
 * rebinds it is covered by the startup health check, which fails the launch if
 * the server could not take the port.
 */
export function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() =>
        port ? resolve(port) : reject(new Error('No loopback port could be reserved.'))
      );
    });
  });
}

export function localLlamaHttpRequest(
  port: number,
  apiKey: string,
  method: 'GET' | 'POST',
  requestPath: string,
  json?: unknown,
  signal?: AbortSignal
): Promise<LocalLlamaHttpResult> {
  if (signal?.aborted) return Promise.reject(abortError());
  const body = json === undefined ? '' : JSON.stringify(json);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(body
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
              }
            : {})
        }
      },
      response => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          // Translation segments are short; cap defensive buffering.
          if (responseBody.length < 2 * 1024 * 1024) responseBody += chunk;
        });
        response.on('end', () =>
          resolve({ statusCode: response.statusCode ?? 0, body: responseBody })
        );
      }
    );
    const onAbort = () => request.destroy(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    request.once('error', reject);
    request.once('close', () => signal?.removeEventListener('abort', onAbort));
    if (body) request.write(body);
    request.end();
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function abortError(): Error {
  return new Error('aborted');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Chooses the production translator. */
export function createTranslator(): Translator {
  return new LlamaTranslator();
}
