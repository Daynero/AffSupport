/**
 * The only file that imports the Anthropic SDK (063). An `index.ts` builds the client from the
 * function's secret and hands it to pure code as a `ClaudeClient`; tests never load this file.
 *
 * Streaming (`messages.stream(...).finalMessage()`) keeps a large `max_tokens` clear of HTTP
 * timeouts. No `temperature`: the current API version rejects sampling parameters, and the
 * default adaptive thinking is what both models we call expect.
 */
import Anthropic from 'npm:@anthropic-ai/sdk@1.6.0';
import {
  ClaudeTransportError,
  type ClaudeClient,
  type ClaudeRawResult,
  type ClaudeRequest
} from './claude.ts';

export function createClaudeClient(apiKey: string): ClaudeClient {
  const anthropic = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  return {
    async create(request: ClaudeRequest, signal: AbortSignal): Promise<ClaudeRawResult> {
      try {
        const message = await anthropic.messages
          .stream(
            {
              model: request.model,
              max_tokens: request.maxTokens,
              system: request.system,
              messages: [{ role: 'user', content: request.user }],
              output_config: {
                effort: request.effort,
                format: { type: 'json_schema', schema: request.schema }
              }
            },
            { signal }
          )
          .finalMessage();
        const text = message.content
          .flatMap(block => (block.type === 'text' ? [block.text] : []))
          .join('');
        const usage = message.usage;
        return {
          stopReason: message.stop_reason ?? null,
          text: text || null,
          usage: {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheWrite: usage.cache_creation_input_tokens ?? 0
          }
        };
      } catch (error) {
        // Only the HTTP status leaves this file: never the provider's body or the key.
        const status = error instanceof Anthropic.APIError ? (error.status ?? null) : null;
        throw new ClaudeTransportError(typeof status === 'number' ? status : null);
      }
    }
  };
}
