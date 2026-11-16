#!/usr/bin/env bash
# 052 pilot (owner decision 2026-11-16): connect serving of the shared white image pool.
#
#   1. builds and deploys the delivery Worker (route catalog-images.soty.pp.ua/g/*),
#   2. gives the Worker and the Supabase functions the same alias keyring.
#
# The keyring lives only in ~/Library/Application Support/Soty/signing/ (0600); it is
# never printed, passed on a command line or committed. Re-running is safe: the same
# keyring is reused, the Worker is redeployed in place.
set -euo pipefail
cd "$(dirname "$0")/.."

signing="$HOME/Library/Application Support/Soty/signing"
keys="$signing/catalog-global-alias-keys.json"
project_ref=yvvvignywfmbdgkcxtfk
wrangler=wrangler@4.112.0

if [[ ! -f "$keys" ]]; then
  (umask 077 && node -e 'process.stdout.write(JSON.stringify({"1":require("node:crypto").randomBytes(32).toString("base64")}))' >"$keys")
fi
[[ "$(stat -f %Lp "$keys")" == 600 ]] || { echo "keyring must be 0600: $keys" >&2; exit 1; }

echo "→ building the delivery Worker"
npm run --silent build -w @video-compressor/catalog-image-delivery >/dev/null

echo "→ deploying the Worker"
(cd apps/catalog-image-delivery && npx --yes "$wrangler" deploy)

echo "→ Worker secret CATALOG_GLOBAL_ALIAS_KEYS"
(cd apps/catalog-image-delivery && npx --yes "$wrangler" secret put CATALOG_GLOBAL_ALIAS_KEYS <"$keys")

echo "→ Supabase secret CATALOG_GLOBAL_ALIAS_KEYS"
env_file="$(mktemp -t soty-alias)"
trap 'rm -f "$env_file"' EXIT
chmod 600 "$env_file"
printf 'CATALOG_GLOBAL_ALIAS_KEYS=%s\n' "$(cat "$keys")" >"$env_file"
SUPABASE_ACCESS_TOKEN="$(sed -n 's/^SUPABASE_ACCESS_TOKEN=//p' config/keys/supabase-release-cli.env)" \
  npx supabase secrets set --project-ref "$project_ref" --env-file "$env_file"

echo "✓ serving connected. Anonymous probe of the Worker (503 until the keyring reaches it is normal for a few seconds):"
curl -s -o /dev/null -w '  /g/ probe → HTTP %{http_code}\n' https://catalog-images.soty.pp.ua/g/probe.jpg || true
