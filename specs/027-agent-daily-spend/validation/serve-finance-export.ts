// Execute the unchanged Edge entrypoint with a loopback-only native Deno server.
// Used when the local Docker Edge runtime is unhealthy; not a deployment.
const serve = Deno.serve;
Deno.serve = ((handler: Deno.ServeHandler) =>
  serve({ hostname: '127.0.0.1', port: 54329 }, handler)) as typeof Deno.serve;
await import('../../../supabase/functions/team-finance-export/index.ts');
