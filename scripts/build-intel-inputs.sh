#!/bin/bash
# Build recipe shipped with the corresponding GPL sources. No product auth or release writes.
set -euo pipefail
intel_cache="${SOTY_INTEL_BUILD_CACHE:?Set an isolated absolute cache on a volume with at least 4 GiB free}"
[[ "$intel_cache" =~ ^/[A-Za-z0-9_./-]+$ ]] || { echo 'Use an absolute build cache without shell metacharacters or spaces.' >&2; exit 2; }
intel_repo="$PWD"
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS SDK is required.' >&2; exit 2; }
mkdir -p "$intel_cache"/{downloads,logs}
# One compiler child at a time, inherited nice priority; no app or database is stopped.
export CMAKE_BUILD_PARALLEL_LEVEL=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
python3 - "$intel_cache" <<'PY'
import os,sys,subprocess
v=os.statvfs(sys.argv[1]); assert v.f_bavail*v.f_frsize>=4*1024**3, 'At least 4 GiB disk headroom required'
mem=subprocess.check_output(['vm_stat'],text=True); pages={}
for line in mem.splitlines()[1:]:
 if ':' in line:
  k,val=line.split(':',1)
  try: pages[k]=int(val.strip().rstrip('.'))
  except ValueError: pass
page=int(subprocess.check_output(['sysctl','-n','hw.pagesize'],text=True))
assert sum(pages.get(k,0) for k in ['Pages free','Pages inactive','Pages speculative'])*page>=2*1024**3, 'At least 2 GiB memory headroom required'
PY
python3 - "$intel_cache" <<'PY'
import json,sys,hashlib,pathlib,urllib.request
cache=pathlib.Path(sys.argv[1]); pins=json.load(open('packaging/macos/inputs.json'))
for key,name in [('node','node-22.23.4.tar.gz'),('ffmpeg','ffmpeg.tar.xz'),('vad','vad.bin'),('vadLicense','silero-license.txt')]:
 p=cache/'downloads'/name; item=pins[key]
 if not p.exists():
  print('Downloading pinned '+key,flush=True); urllib.request.urlretrieve(item['url'],p)
 assert hashlib.sha256(p.read_bytes()).hexdigest()==item['sha256'], 'Input digest mismatch: '+key
PY
for intel_source in x264 whisper; do
 intel_remote=$(node -p "JSON.parse(require('fs').readFileSync('packaging/macos/inputs.json')).$intel_source.repository")
 intel_revision=$(node -p "JSON.parse(require('fs').readFileSync('packaging/macos/inputs.json')).$intel_source.revision")
 if [[ ! -d "$intel_cache/$intel_source-src/.git" ]]; then
  git init -q "$intel_cache/$intel_source-src"
  git -C "$intel_cache/$intel_source-src" config core.hooksPath "$intel_cache/no-hooks"
  git -C "$intel_cache/$intel_source-src" remote add origin "$intel_remote"
  git -C "$intel_cache/$intel_source-src" fetch -q --depth=1 origin "$intel_revision"
  git -C "$intel_cache/$intel_source-src" checkout -q --detach FETCH_HEAD
 fi
 [[ "$(git -C "$intel_cache/$intel_source-src" rev-parse HEAD)" == "$intel_revision" ]]
 git -C "$intel_cache/$intel_source-src" archive --format=tar.gz --prefix="$intel_source/" -o "$intel_cache/downloads/$intel_source-source.tar.gz" HEAD
 [[ -z "$(git -C "$intel_cache/$intel_source-src" status --porcelain --untracked-files=no)" ]] || { echo 'Source tree modified; refusing a provenance claim.' >&2; exit 1; }
done
[[ -d "$intel_cache/node-v22.23.4-darwin-x64" ]] || tar -xzf "$intel_cache/downloads/node-22.23.4.tar.gz" -C "$intel_cache"
[[ -d "$intel_cache/ffmpeg-7.1.1" ]] || tar -xJf "$intel_cache/downloads/ffmpeg.tar.xz" -C "$intel_cache"
cat > "$intel_cache/clang-x64" <<'CC'
#!/bin/sh
exec /usr/bin/xcrun clang -arch x86_64 -mmacosx-version-min=13.0 "$@"
CC
chmod +x "$intel_cache/clang-x64"
if [[ ! -f "$intel_cache/x264-prefix/lib/libx264.a" ]]; then
 echo 'Building portable x264 (one worker)'
 (cd "$intel_cache/x264-src"; CC="$intel_cache/clang-x64" ./configure --host=x86_64-apple-darwin --prefix="$intel_cache/x264-prefix" --enable-static --disable-shared --disable-cli --disable-asm; make -j1; make install) > "$intel_cache/logs/x264.log" 2>&1
fi
if [[ ! -x "$intel_cache/ffmpeg-7.1.1/ffprobe" ]]; then
 echo 'Building portable FFmpeg/FFprobe (one worker)'
 (cd "$intel_cache/ffmpeg-7.1.1"; PKG_CONFIG_PATH="$intel_cache/x264-prefix/lib/pkgconfig" ./configure --arch=x86_64 --cpu=generic --target-os=darwin --enable-cross-compile --cc="$intel_cache/clang-x64" --enable-gpl --enable-libx264 --disable-shared --enable-static --disable-ffplay --disable-sdl2 --disable-x86asm --disable-debug --extra-cflags="-I$intel_cache/x264-prefix/include" --extra-ldflags="-L$intel_cache/x264-prefix/lib"; make -j1 ffmpeg ffprobe) > "$intel_cache/logs/ffmpeg.log" 2>&1
fi
if [[ ! -x "$intel_cache/whisper-build/bin/whisper-cli" ]]; then
 if [[ ! -x "$intel_cache/tools/bin/cmake" ]]; then
  python3 -m venv "$intel_cache/tools"
  "$intel_cache/tools/bin/python" -m pip install --disable-pip-version-check 'cmake==3.31.6' > "$intel_cache/logs/cmake-install.log" 2>&1
 fi
 echo 'Building portable CPU Whisper (one worker, no native CPU tuning / OpenMP / Metal)'
 "$intel_cache/tools/bin/cmake" -S "$intel_cache/whisper-src" -B "$intel_cache/whisper-build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_SYSTEM_NAME=Darwin -DCMAKE_SYSTEM_PROCESSOR=x86_64 -DCMAKE_OSX_ARCHITECTURES=x86_64 -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 -DBUILD_SHARED_LIBS=OFF -DGGML_BACKEND_DL=OFF -DGGML_NATIVE=OFF -DGGML_METAL=OFF -DGGML_OPENMP=OFF -DGGML_BLAS=OFF -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_AVX512=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF -DGGML_BMI2=OFF -DWHISPER_BUILD_TESTS=OFF > "$intel_cache/logs/whisper.log" 2>&1
 "$intel_cache/tools/bin/cmake" --build "$intel_cache/whisper-build" --target whisper-cli --parallel 1 >> "$intel_cache/logs/whisper.log" 2>&1
fi
python3 - "$intel_cache" "$intel_repo" <<'PY'
import json,pathlib,hashlib,sys
c=pathlib.Path(sys.argv[1]); repo=pathlib.Path(sys.argv[2]); pins=json.load(open(repo/'packaging/macos/inputs.json'))
items={
 'node':(c/'node-v22.23.4-darwin-x64/bin/node',pins['node']['url'],'22.23.4','MIT'),
 'ffmpeg':(c/'ffmpeg-7.1.1/ffmpeg',pins['ffmpeg']['url'],'7.1.1','GPL-2.0-or-later'),
 'ffprobe':(c/'ffmpeg-7.1.1/ffprobe',pins['ffmpeg']['url'],'7.1.1','GPL-2.0-or-later'),
 'whisper':(c/'whisper-build/bin/whisper-cli',pins['whisper']['repository'],'1.9.1','MIT'),
 'vad':(c/'downloads/vad.bin',pins['vad']['url'],'5.1.2','MIT'),
 'ffmpegSource':(c/'downloads/ffmpeg.tar.xz',pins['ffmpeg']['url'],'7.1.1','GPL-2.0-or-later'),
 'x264Source':(c/'downloads/x264-source.tar.gz',pins['x264']['repository'],pins['x264']['revision'],'GPL-2.0-or-later')}
files={k:{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'source':url,'version':version,'license':license} for k,(p,url,version,license) in items.items()}
(c/'inputs.json').write_text(json.dumps({'schemaVersion':1,'architecture':'x64','cpuBaseline':'x86-64-v2','files':files},indent=2)+'\n')
PY
node scripts/stage-macos-inputs.mjs --arch=x64 --inputs="$intel_cache/inputs.json"
# Preserve complete license texts and this exact build recipe with source offers.
mkdir -p release/inputs/x64/Contents/Resources/licenses/sources
cp "$intel_cache/node-v22.23.4-darwin-x64/LICENSE" release/inputs/x64/Contents/Resources/licenses/Node-LICENSE.txt
cp "$intel_cache/downloads/silero-license.txt" release/inputs/x64/Contents/Resources/licenses/Silero-LICENSE.txt
cp "$intel_cache/ffmpeg-7.1.1/COPYING.GPLv2" release/inputs/x64/Contents/Resources/licenses/FFmpeg-GPLv2.txt
cp "$intel_cache/x264-src/COPYING" release/inputs/x64/Contents/Resources/licenses/x264-COPYING.txt
cp "$intel_cache/whisper-src/LICENSE" release/inputs/x64/Contents/Resources/licenses/Whisper-LICENSE.txt
cp "$intel_cache/downloads/whisper-source.tar.gz" release/inputs/x64/Contents/Resources/licenses/sources/
cp "$0" release/inputs/x64/Contents/Resources/licenses/sources/build-intel-inputs.sh
echo 'Intel runtime staged. This is a static cross-build, not physical Intel acceptance.'
