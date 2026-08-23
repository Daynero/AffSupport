/**
 * Minimal ambient declaration for the Deno globals the Supabase edge functions use.
 *
 * The test tree imports helpers out of `supabase/functions/**` (for example
 * `_shared/auth.ts`, `_shared/cors.ts`, `_shared/credentials.ts`) and those modules read
 * configuration through `Deno.env.get`. Those files run on Deno in production and on Node
 * under vitest, where the global does not exist — the tests that exercise them stub or
 * avoid the code paths that touch it.
 *
 * This declaration exists so `tsconfig.check.json` can type-check the test tree without
 * pulling in the full Deno type package, which would drag in a second, conflicting set of
 * lib definitions for `fetch`, `Request` and friends.
 *
 * Deliberately narrow: declare only what is actually reached. Widening this file to the
 * real Deno namespace would let backend code start depending on APIs that have no Node
 * equivalent, which is precisely the drift this repository's type gates exist to catch.
 */
declare const Deno: {
  readonly env: {
    get(key: string): string | undefined;
  };
};
