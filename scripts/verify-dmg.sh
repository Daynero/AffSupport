#!/bin/zsh
set -euo pipefail
dmg="$PWD/release/LocalVideoCompressor-v0.1.0-test-macOS-arm64.dmg"
[[ -f "$dmg" ]] || { print -u2 "DMG not found"; exit 1; }
work=$(mktemp -d /tmp/lvc-dmg-verify.XXXXXX); mount=''; agent_pid=''; listener_pid=''
cleanup() { [[ -z "$agent_pid" ]] || kill -TERM "$agent_pid" 2>/dev/null || true; [[ -z "$listener_pid" ]] || kill -TERM "$listener_pid" 2>/dev/null || true; [[ -z "$mount" ]] || hdiutil detach -quiet "$mount" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
attach=$(hdiutil attach -readonly -nobrowse "$dmg"); mount=$(print -r -- "$attach" | sed -n 's|^.*\t\(/Volumes/.*\)$|\1|p' | tail -1)
[[ -d "$mount/Local Video Compressor Agent.app" && -L "$mount/Applications" && -f "$mount/.background/background.png" ]]
ditto "$mount/Local Video Compressor Agent.app" "$work/Local Video Compressor Agent.app"
app="$work/Local Video Compressor Agent.app"; [[ -f "$app/Contents/Resources/AppIcon.icns" ]]
for binary in "$app/Contents/Resources/runtime/bin/ffmpeg" "$app/Contents/Resources/runtime/bin/ffprobe" "$app/Contents/Resources/runtime/node"; do [[ "$(file "$binary")" == *arm64* ]]; done
mkdir -p "$work/home/Library/Application Support/Local Video Compressor" "$work/video"
ffmpeg="$app/Contents/Resources/runtime/bin/ffmpeg"; ffprobe="$app/Contents/Resources/runtime/bin/ffprobe"
"$ffmpeg" -hide_banner -loglevel error -f lavfi -i testsrc2=size=640x360:rate=24 -f lavfi -i sine=frequency=440 -t 3 -c:v libx264 -c:a aac -shortest "$work/video/test input.mp4"
size=$(stat -f '%z' "$work/video/test input.mp4")
cat > "$work/home/Library/Application Support/Local Video Compressor/state.json" <<JSON
{"jobs":[{"id":"dmg-e2e","inputPath":"$work/video/test input.mp4","outputPath":"$work/video/test output.mp4","fileName":"test input.mp4","durationSeconds":3,"originalSize":$size,"finalSize":null,"progress":0,"status":"queued","error":null,"preset":"balanced","estimateStatus":"waiting","estimatePreset":"balanced"}],"settings":{"preset":"balanced","outputMode":"next-to-originals","outputFolder":null}}
JSON
env -i PATH=/usr/bin:/bin /usr/bin/open -n --env NO_OPEN=1 --env TMPDIR=/tmp --env HOME="$work/home" --stdout "$work/agent.log" --stderr "$work/agent.log" "$app"
for i in {1..40}; do /usr/bin/curl -fsS --max-time 1 http://127.0.0.1:43120/health -o /dev/null 2>/dev/null && break; sleep .25; done
listener_pid=$(lsof -tiTCP:43120 -sTCP:LISTEN); [[ -n "$listener_pid" ]]
agent_pid=$(ps -o ppid= -p "$listener_pid" | tr -d ' '); [[ -n "$agent_pid" ]]
[[ "$(ps -o command= -p "$agent_pid")" == *"$app/Contents/MacOS/LocalVideoCompressor"* ]]
[[ "$(ps -o command= -p "$listener_pid")" == *"$app/Contents/Resources/runtime/node"* ]]
headers="$work/pair.headers"; /usr/bin/curl -sS -D "$headers" -o /dev/null --max-redirs 0 http://127.0.0.1:43120/pair
token=$(sed -n 's/^[Ll]ocation: .*#agentToken=\([a-f0-9]*\).*/\1/p' "$headers" | tr -d '\r'); [[ ${#token} -eq 64 ]]
origin='https://local-video-compressor-test.pages.dev'; health=$(/usr/bin/curl -fsS -H "Origin: $origin" -H "x-session-token: $token" http://127.0.0.1:43120/api/health); print -r -- "$health" | grep -q '"ok":true'
/usr/bin/curl -fsS -X POST -H "Origin: $origin" -H "x-session-token: $token" http://127.0.0.1:43120/api/queue/start >/dev/null
for i in {1..40}; do state=$(/usr/bin/curl -fsS -H "Origin: $origin" -H "x-session-token: $token" http://127.0.0.1:43120/api/queue); print -r -- "$state" | grep -q '"status":"completed"' && break; sleep .25; done
print -r -- "$state" | grep -q '"status":"completed"'; probe_result=$("$ffprobe" -v error -show_entries format=duration,size -of json "$work/video/test output.mp4"); [[ "$probe_result" == *'"duration"'* ]]
/usr/bin/open "$app"; sleep 1; [[ "$(lsof -tiTCP:43120 -sTCP:LISTEN | wc -l | tr -d ' ')" == 1 ]]
/usr/bin/osascript -e 'tell application id "local.video.compressor.test" to quit'; for i in {1..20}; do kill -0 "$listener_pid" 2>/dev/null || break; sleep .25; done; ! kill -0 "$listener_pid" 2>/dev/null
agent_pid=''; listener_pid=''
print "DMG Finder/open launch, single instance, clean quit, bundled runtimes, secure production pairing, health, compression, and bundled FFprobe verified."
