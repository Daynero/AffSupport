#!/usr/bin/env bash
# Browser uploads go straight to the private production staging bucket, so its CORS must
# name every origin that uploads: the hosted site, the next channel (it shares production
# storage, owner decision 2026-11-16) and the installed app's loopback. Exact origins only,
# PUT only, the one signed header. Re-running is safe: the rule set is replaced as a whole.
set -euo pipefail
cd "$(dirname "$0")/.."

bucket=soty-catalog-images-production-staging
wrangler=wrangler@4.112.0
rules="$(mktemp -t soty-cors)"
trap 'rm -f "$rules"' EXIT
cat >"$rules" <<'JSON'
{"rules":[{"allowed":{"origins":["https://soty.pp.ua","https://next.soty.pp.ua","http://127.0.0.1:43120","http://localhost:43120"],"methods":["PUT"],"headers":["Content-Type"]},"maxAgeSeconds":300}]}
JSON

(cd apps/catalog-image-delivery && npx --yes "$wrangler" r2 bucket cors set "$bucket" --file "$rules" --force)
(cd apps/catalog-image-delivery && npx --yes "$wrangler" r2 bucket cors list "$bucket") | grep -E 'allowed_origins|allowed_methods'
