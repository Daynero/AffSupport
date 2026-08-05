#!/bin/zsh
set -euo pipefail
dmg="$PWD/release/$(node scripts/release-meta.mjs artifact-name)"
build_id=$(node scripts/release-meta.mjs build-id); api_version=$(node scripts/release-meta.mjs api-version)
[[ -f "$dmg" ]] || { print -u2 "DMG not found"; exit 1; }
[[ -z "$(lsof -tiTCP:43120 -sTCP:LISTEN 2>/dev/null)" ]] || { print -u2 "Quit the currently running Wishly Agent before DMG verification."; exit 1; }
work=$(mktemp -d /tmp/wishly-dmg-verify.XXXXXX); mount=''; agent_pid=''; listener_pid=''
cleanup() { [[ -z "$agent_pid" ]] || kill -TERM "$agent_pid" 2>/dev/null || true; [[ -z "$listener_pid" ]] || kill -TERM "$listener_pid" 2>/dev/null || true; [[ -z "$mount" ]] || hdiutil detach -quiet "$mount" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT INT TERM
attach=$(hdiutil attach -readonly -nobrowse "$dmg"); mount=$(print -r -- "$attach" | sed -n 's|^.*\t\(/Volumes/.*\)$|\1|p' | tail -1)
[[ -d "$mount/Wishly Agent.app" && -L "$mount/Applications" && -f "$mount/.background/background.png" ]]
ditto "$mount/Wishly Agent.app" "$work/Wishly Agent.app"
app="$work/Wishly Agent.app"; [[ -f "$app/Contents/Resources/AppIcon.icns" ]]
finder_extension="$app/Contents/PlugIns/WishlyFinderExtension.appex"
finder_binary="$finder_extension/Contents/MacOS/WishlyFinderExtension"
[[ -x "$finder_binary" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :NSExtension:NSExtensionPointIdentifier' "$finder_extension/Contents/Info.plist")" == "com.apple.FinderSync" ]]
codesign --verify --strict "$finder_extension"
for binary in "$app/Contents/Resources/runtime/bin/ffmpeg" "$app/Contents/Resources/runtime/bin/ffprobe" "$app/Contents/Resources/runtime/node"; do [[ "$(file "$binary")" == *arm64* ]]; done
mkdir -p "$work/home/Library/Application Support/Wishly" "$work/video"
ffmpeg="$app/Contents/Resources/runtime/bin/ffmpeg"; ffprobe="$app/Contents/Resources/runtime/bin/ffprobe"
"$ffmpeg" -hide_banner -loglevel error -f lavfi -i testsrc2=size=640x360:rate=24 -f lavfi -i sine=frequency=440 -t 3 -c:v libx264 -c:a aac -shortest "$work/video/test input.mp4"
size=$(stat -f '%z' "$work/video/test input.mp4")
cat > "$work/home/Library/Application Support/Wishly/state.json" <<JSON
{"jobs":[{"id":"dmg-e2e","inputPath":"$work/video/test input.mp4","outputPath":"$work/video/test output.mp4","fileName":"test input.mp4","durationSeconds":3,"originalSize":$size,"finalSize":null,"progress":0,"status":"queued","error":null,"preset":"balanced","estimateStatus":"waiting","estimatePreset":"balanced"}],"settings":{"preset":"balanced","outputMode":"next-to-originals","outputFolder":null}}
JSON
env -i PATH=/usr/bin:/bin /usr/bin/open -n --env NO_OPEN=1 --env WISHLY_ALLOW_UNINSTALLED_AGENT=1 --env TMPDIR=/tmp --env HOME="$work/home" --stdout "$work/agent.log" --stderr "$work/agent.log" "$app"
for i in {1..40}; do /usr/bin/curl -fsS --max-time 1 http://127.0.0.1:43120/health -o /dev/null 2>/dev/null && break; sleep .25; done
listener_pid=$(lsof -tiTCP:43120 -sTCP:LISTEN); [[ -n "$listener_pid" ]]
agent_pid=$(ps -o ppid= -p "$listener_pid" | tr -d ' '); [[ -n "$agent_pid" ]]
[[ "$(ps -o command= -p "$agent_pid")" == *"$app/Contents/MacOS/WishlyAgent"* ]]
[[ "$(ps -o command= -p "$listener_pid")" == *"$app/Contents/Resources/runtime/node"* ]]
headers="$work/pair.headers"; /usr/bin/curl -sS -D "$headers" -o /dev/null --max-redirs 0 http://127.0.0.1:43120/pair
token=$(sed -n 's/^[Ll]ocation: .*#agentToken=\([a-f0-9]*\).*/\1/p' "$headers" | tr -d '\r'); [[ ${#token} -eq 64 ]]
origin='https://soty.pp.ua'; health=$(/usr/bin/curl -fsS -H "Origin: $origin" -H "x-session-token: $token" http://127.0.0.1:43120/api/health); print -r -- "$health" | grep -q '"ok":true'; print -r -- "$health" | grep -q "\"buildId\":\"$build_id\""; print -r -- "$health" | grep -q "\"apiVersion\":$api_version"
# The packaged agent gates tool routes behind a server-issued entitlement token.
# Mint one with the release private key and submit it: this both unlocks the
# smoke test below and proves the public key embedded in the build actually
# matches the signing key (otherwise the whole entitlement path is broken).
print -r -- "$health" | grep -q '"entitlement":{"enforced":true'
entitlement_token=$(node -e '
const { readFileSync } = require("fs");
const { createPrivateKey, sign } = require("crypto");
const key = createPrivateKey(readFileSync("config/keys/agent-entitlement.private.pem"));
const now = Math.floor(Date.now() / 1000);
const payload = Buffer.from(JSON.stringify({ v: 1, sub: "dmg-e2e", plan: "pro", iat: now, exp: now + 3600 })).toString("base64url");
const sig = sign("sha256", Buffer.from("wat1." + payload), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
process.stdout.write("wat1." + payload + "." + sig);
')
entitlement=$(/usr/bin/curl -fsS -X POST -H "Origin: $origin" -H "x-session-token: $token" -H 'content-type: application/json' --data "{\"token\":\"$entitlement_token\"}" http://127.0.0.1:43120/api/entitlement); print -r -- "$entitlement" | grep -q '"entitled":true'
event_headers="$work/events.headers"; set +e; /usr/bin/curl -sS -D "$event_headers" -o /dev/null --max-time 1 -H "Origin: $origin" "http://127.0.0.1:43120/api/events?token=$token"; event_status=$?; set -e
[[ $event_status -eq 0 || $event_status -eq 28 ]]; grep -qi "^access-control-allow-origin: $origin" "$event_headers"
/usr/bin/curl -fsS -X POST -H "Origin: $origin" -H "x-session-token: $token" -H 'content-type: application/json' --data '{"ids":["dmg-e2e"]}' http://127.0.0.1:43120/api/queue/start >/dev/null
for i in {1..40}; do state=$(/usr/bin/curl -fsS -H "Origin: $origin" -H "x-session-token: $token" http://127.0.0.1:43120/api/queue); print -r -- "$state" | grep -q '"status":"completed"' && break; sleep .25; done
print -r -- "$state" | grep -q '"status":"completed"'
# The agent derives a collision-safe output name itself, so read the real
# path back from the queue state instead of assuming the seeded one.
output_path=$(print -r -- "$state" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["jobs"][0]["outputPath"])')
probe_result=$("$ffprobe" -v error -show_entries format=duration,size -of json "$output_path"); [[ "$probe_result" == *'"duration"'* ]]
/usr/bin/open "$app"; sleep 1; [[ "$(lsof -tiTCP:43120 -sTCP:LISTEN | wc -l | tr -d ' ')" == 1 ]]
/usr/bin/osascript -e 'tell application id "local.video.compressor.test" to quit'; for i in {1..20}; do kill -0 "$listener_pid" 2>/dev/null || break; sleep .25; done; ! kill -0 "$listener_pid" 2>/dev/null
agent_pid=''; listener_pid=''
print "DMG Finder extension, open launch, single instance, clean quit, bundled runtimes, secure production pairing, health, compression, and bundled FFprobe verified."
