#!/usr/bin/env node
/**
 * 057 T001: qualify the space bucket on a real R2 beta bucket.
 *
 *   node scripts/space-storage-qualify.mjs --env-file <path> [--bucket soty-spaces-beta] [--out file.json]
 *
 * Establishes with real S3 requests what research.md R3/R4 rest on: multipart
 * create/UploadPart/ListParts/Complete/Abort, `Content-MD5` enforcement on parts
 * (header-signed and presigned the way `SpaceR2.signPart` presigns), the exact
 * ETag shapes of parts and of the completed object, `x-amz-checksum-sha256`,
 * part size rules, CORS on preflight and on real PUT/GET responses, Range GET,
 * anonymous refusal and bucket configuration readback.
 *
 * Safety:
 * - refuses any bucket whose name does not end in `-beta`, before reading credentials;
 * - writes only under `qualify/<run>/` and deletes every object and aborts every
 *   multipart it finds under `qualify/` at the end (also after a failure);
 * - credentials are read from the env file (or the environment) and never printed:
 *   output carries statuses, error codes and selected response headers only, never
 *   a URL, a host, an account id, a signature or a provider error body.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  normalizePartEtag,
  spaceContentId,
  spacePartBytes,
  spacePartCount,
  spacePartRange
} from '../packages/shared/dist/team/space-storage.js';

const MIB = 1024 * 1024;
const BETA_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}-beta$/u;

export function assertBetaBucket(name) {
  if (typeof name !== 'string' || !BETA_BUCKET.test(name))
    throw new Error(`Refusing bucket "${String(name)}": only a *-beta bucket may be qualified`);
}

const { values: args } = parseArgs({
  options: {
    bucket: { type: 'string', default: 'soty-spaces-beta' },
    'env-file': { type: 'string' },
    out: { type: 'string' }
  }
});

try {
  assertBetaBucket(args.bucket);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

// Credentials ------------------------------------------------------------------------------

function readEnvFile(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match) continue;
    let value = match[2];
    if (/^(['"]).*\1$/u.test(value)) value = value.slice(1, -1);
    env[match[1]] = value;
  }
  return env;
}

const fileEnv = args['env-file'] ? readEnvFile(args['env-file']) : {};
const pick = (...names) => {
  for (const name of names) {
    const value = process.env[name] || fileEnv[name];
    if (value) return value;
  }
  return null;
};
const ACCOUNT = pick('R2_SPACE_ACCOUNT_ID', 'R2_CATALOG_ACCOUNT_ID');
const ACCESS_KEY = pick('R2_SPACE_ACCESS_KEY_ID', 'R2_CATALOG_VIDEO_ACCESS_KEY_ID');
const SECRET_KEY = pick('R2_SPACE_SECRET_ACCESS_KEY', 'R2_CATALOG_VIDEO_SECRET_ACCESS_KEY');
if (!ACCOUNT || !/^[a-f0-9]{32}$/u.test(ACCOUNT) || !ACCESS_KEY || !SECRET_KEY) {
  console.error('R2 credentials missing (R2_SPACE_* or R2_CATALOG_ACCOUNT_ID/R2_CATALOG_VIDEO_*)');
  process.exit(2);
}
const HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;
const BUCKET = args.bucket;
const RUN = `qualify/${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomBytes(3).toString('hex')}`;

// SigV4 (region auto, service s3) ----------------------------------------------------------

const sha256Hex = data => createHash('sha256').update(data).digest('hex');
const md5 = data => createHash('md5').update(data).digest();
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const rfc3986 = value =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
const canonicalPath = key => `/${BUCKET}${key ? `/${key.split('/').map(rfc3986).join('/')}` : ''}`;
const canonicalQuery = query =>
  Object.keys(query)
    .sort()
    .map(name => `${rfc3986(name)}=${rfc3986(query[name])}`)
    .join('&');

function signingKey(date) {
  return hmac(hmac(hmac(hmac(`AWS4${SECRET_KEY}`, date), 'auto'), 's3'), 'aws4_request');
}

function amzDate(now = new Date()) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}/u, '');
  return { stamp, date: stamp.slice(0, 8) };
}

function stringToSign(method, path, query, headers, signedNames, payloadHash, stamp, date) {
  const canonicalHeaders = signedNames
    .map(name => `${name}:${String(headers[name]).trim()}\n`)
    .join('');
  const request = [
    method,
    path,
    canonicalQuery(query),
    canonicalHeaders,
    signedNames.join(';'),
    payloadHash
  ].join('\n');
  return ['AWS4-HMAC-SHA256', stamp, `${date}/auto/s3/aws4_request`, sha256Hex(request)].join('\n');
}

/** Header-signed request; every given header is signed. */
function signed(method, key, { query = {}, headers = {}, body, host = HOST } = {}) {
  const { stamp, date } = amzDate();
  const payloadHash = body === undefined ? sha256Hex('') : sha256Hex(body);
  const all = { host, 'x-amz-date': stamp, 'x-amz-content-sha256': payloadHash };
  for (const [name, value] of Object.entries(headers)) all[name.toLowerCase()] = value;
  const names = Object.keys(all).sort();
  const signature = hmac(
    signingKey(date),
    stringToSign(method, canonicalPath(key), query, all, names, payloadHash, stamp, date)
  ).toString('hex');
  const sent = { ...all };
  delete sent.host;
  sent.authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${date}/auto/s3/aws4_request, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  const qs = canonicalQuery(query);
  return { url: `https://${host}${canonicalPath(key)}${qs ? `?${qs}` : ''}`, headers: sent };
}

/**
 * Presigned URL as `SpaceR2.signPart` produces it through aws4fetch `signQuery`:
 * `host` and `content-md5` signed, `UNSIGNED-PAYLOAD`.
 */
function presigned(method, key, query, signHeaders, expires = 600) {
  const { stamp, date } = amzDate();
  const all = { host: HOST };
  for (const [name, value] of Object.entries(signHeaders)) all[name.toLowerCase()] = value;
  const names = Object.keys(all).sort();
  const full = {
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${ACCESS_KEY}/${date}/auto/s3/aws4_request`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': names.join(';')
  };
  const signature = hmac(
    signingKey(date),
    stringToSign(method, canonicalPath(key), full, all, names, 'UNSIGNED-PAYLOAD', stamp, date)
  ).toString('hex');
  return `https://${HOST}${canonicalPath(key)}?${canonicalQuery(full)}&X-Amz-Signature=${signature}`;
}

// Transport ----------------------------------------------------------------------------------

const CAPTURED = [
  'etag',
  'content-length',
  'content-range',
  'accept-ranges',
  'content-type',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
  'vary'
];

async function send(url, init) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    // Never echo the error or attach it: it may name the host (the account id).
    // eslint-disable-next-line preserve-caught-error -- the cause is withheld on purpose
    throw new Error(`network failure (${error?.cause?.code ?? 'unknown'})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const headers = {};
  for (const name of CAPTURED) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const text = bytes.length < 64 * 1024 ? bytes.toString('utf8') : '';
  const code = /<Code>([^<]{1,80})<\/Code>/u.exec(text)?.[1] ?? null;
  return { status: response.status, headers, code, bytes, text };
}

const s3 = (method, key, options = {}) => {
  const { url, headers } = signed(method, key, options);
  return send(url, { method, headers, body: options.body });
};

const xmlAll = (body, tag) =>
  [...body.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gu'))].map(m => m[1]);
const xmlOne = (body, tag) => xmlAll(body, tag)[0] ?? null;
const unquote = value => value?.replace(/&quot;/gu, '"') ?? null;

// Report -----------------------------------------------------------------------------------

const report = {
  startedAt: new Date().toISOString(),
  bucket: BUCKET,
  prefix: 'qualify/',
  checks: []
};
function check(id, pass, observed, expected) {
  report.checks.push({ id, pass: Boolean(pass), expected, observed });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${JSON.stringify(observed)}`);
}
const brief = r => ({ status: r.status, code: r.code, ...r.headers });

const ORIGINS = [
  'https://next.soty.pp.ua',
  'https://soty.pp.ua',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
];

// Probes -------------------------------------------------------------------------------------

async function createMultipart(key) {
  const r = await s3('POST', key, {
    query: { uploads: '' },
    headers: { 'content-type': 'application/octet-stream' }
  });
  const uploadId = xmlOne(r.text, 'UploadId');
  if (r.status !== 200 || !uploadId) throw new Error(`create failed ${r.status} ${r.code}`);
  return uploadId;
}

const uploadPartSigned = (key, uploadId, partNumber, body, headers = {}) =>
  s3('PUT', key, { query: { partNumber: String(partNumber), uploadId }, headers, body });

function uploadPartPresigned(key, uploadId, partNumber, body, md5Signed, md5Sent, origin) {
  const url = presigned(
    'PUT',
    key,
    { partNumber: String(partNumber), uploadId },
    { 'content-md5': md5Signed }
  );
  const headers = { 'content-md5': md5Sent };
  if (origin) headers.origin = origin;
  return send(url, { method: 'PUT', headers, body });
}

async function listParts(key, uploadId) {
  const r = await s3('GET', key, { query: { uploadId } });
  const parts = xmlAll(r.text, 'Part').map(block => ({
    partNumber: Number(xmlOne(block, 'PartNumber')),
    etagRaw: unquote(xmlOne(block, 'ETag')),
    size: Number(xmlOne(block, 'Size'))
  }));
  return { response: r, parts };
}

function completeBody(parts) {
  return Buffer.from(
    '<CompleteMultipartUpload>' +
      parts
        .map(p => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag></Part>`)
        .join('') +
      '</CompleteMultipartUpload>'
  );
}

const complete = (key, uploadId, parts) => {
  const body = completeBody(parts);
  return s3('POST', key, {
    query: { uploadId },
    headers: { 'content-type': 'application/xml' },
    body
  });
};

const s3MultipartEtag = md5Hexes =>
  `${createHash('md5')
    .update(Buffer.concat(md5Hexes.map(h => Buffer.from(h, 'hex'))))
    .digest('hex')}-${md5Hexes.length}`;

async function preflights() {
  const key = `${RUN}/preflight`;
  const url = `https://${HOST}${canonicalPath(key)}`;
  for (const origin of ORIGINS) {
    const put = await send(url, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-md5,content-type'
      }
    });
    check(
      `cors.preflight.put ${origin}`,
      put.status < 300 && put.headers['access-control-allow-origin'] === origin,
      brief(put),
      'ACAO = origin, PUT allowed with content-md5'
    );
    const get = await send(url, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'range'
      }
    });
    check(
      `cors.preflight.get-range ${origin}`,
      get.status < 300 && get.headers['access-control-allow-origin'] === origin,
      brief(get),
      'ACAO = origin, GET with range allowed'
    );
  }
  const foreign = await send(url, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' }
  });
  check(
    'cors.preflight.foreign-origin',
    !foreign.headers['access-control-allow-origin'],
    brief(foreign),
    'no ACAO for an origin outside the list'
  );
}

async function mainUpload(created) {
  // Our client's real part size: 16 MiB below 50 GiB, so a 16 MiB part and a short last one.
  const total = 16 * MIB + 1 * MIB + 123;
  const key = `${RUN}/main.bin`;
  const data = randomBytes(total);
  const partBytes = spacePartBytes(total);
  const count = spacePartCount(total);
  const slices = Array.from({ length: count }, (_, i) => {
    const { start, end } = spacePartRange(total, i + 1);
    return data.subarray(start, end + 1);
  });
  const md5s = slices.map(slice => md5(slice));
  check(
    'client.part-layout',
    partBytes === 16 * MIB && count === 2,
    { partBytes, count, total },
    '16 MiB parts, 2 parts'
  );

  const uploadId = await createMultipart(key);
  created.uploads.push({ key, uploadId });
  check('multipart.create', true, { uploadIdLength: uploadId.length }, 'UploadId returned');

  // Part 1, exactly as the browser sends it: presigned with Content-MD5 signed, from next.
  const p1 = await uploadPartPresigned(
    key,
    uploadId,
    1,
    slices[0],
    md5s[0].toString('base64'),
    md5s[0].toString('base64'),
    ORIGINS[0]
  );
  check('uploadPart.presigned.right-md5', p1.status === 200, brief(p1), '200');
  check(
    'uploadPart.etag-format',
    p1.headers.etag === `"${md5s[0].toString('hex')}"`,
    { etag: p1.headers.etag, md5: md5s[0].toString('hex') },
    'ETag header = quoted lowercase hex MD5 of the part'
  );
  check(
    'uploadPart.normalizePartEtag',
    normalizePartEtag(p1.headers.etag) === md5s[0].toString('hex'),
    { normalized: normalizePartEtag(p1.headers.etag) },
    'shared normalizer yields the MD5'
  );
  check(
    'cors.put-response.exposes-etag',
    p1.headers['access-control-allow-origin'] === ORIGINS[0] &&
      /(^|,\s*)etag(\s*,|$)/iu.test(p1.headers['access-control-expose-headers'] ?? ''),
    {
      acao: p1.headers['access-control-allow-origin'],
      aceh: p1.headers['access-control-expose-headers']
    },
    'real PUT response: ACAO = origin, Access-Control-Expose-Headers contains ETag'
  );

  // Negative probes on part 2.
  const wrong = md5(Buffer.from('not these bytes')).toString('base64');
  const badSigned = await uploadPartSigned(key, uploadId, 2, slices[1], { 'content-md5': wrong });
  check(
    'uploadPart.signed.wrong-md5',
    badSigned.status === 400 && badSigned.code === 'BadDigest',
    brief(badSigned),
    '400 BadDigest'
  );

  const tampered = Buffer.from(slices[1]);
  tampered[0] ^= 0xff;
  const badBody = await uploadPartPresigned(
    key,
    uploadId,
    2,
    tampered,
    md5s[1].toString('base64'),
    md5s[1].toString('base64'),
    ORIGINS[0]
  );
  check(
    'uploadPart.presigned.damaged-body',
    badBody.status === 400 && badBody.code === 'BadDigest',
    brief(badBody),
    '400 BadDigest (signed MD5, other bytes)'
  );

  const swapped = await uploadPartPresigned(
    key,
    uploadId,
    2,
    tampered,
    md5s[1].toString('base64'),
    md5(tampered).toString('base64'),
    ORIGINS[0]
  );
  check(
    'uploadPart.presigned.md5-header-swapped',
    swapped.status === 403,
    brief(swapped),
    '403 (Content-MD5 is inside the signature)'
  );

  const sha = await uploadPartSigned(key, uploadId, 2, slices[1], {
    'x-amz-checksum-sha256': createHash('sha256').update(slices[1]).digest('base64')
  });
  check('uploadPart.checksum-sha256', sha.status === 501, brief(sha), '501 NotImplemented (050)');

  const noMd5 = await uploadPartSigned(key, uploadId, 2, tampered);
  check(
    'uploadPart.no-md5.etag-is-md5',
    noMd5.status === 200 && noMd5.headers.etag === `"${md5(tampered).toString('hex')}"`,
    { status: noMd5.status, etag: noMd5.headers.etag },
    'without Content-MD5 the part is accepted and its ETag is still the MD5 of what arrived'
  );

  const p2 = await uploadPartPresigned(
    key,
    uploadId,
    2,
    slices[1],
    md5s[1].toString('base64'),
    md5s[1].toString('base64'),
    ORIGINS[0]
  );
  check(
    'uploadPart.overwrite-part',
    p2.status === 200 && p2.headers.etag === `"${md5s[1].toString('hex')}"`,
    brief(p2),
    'same part number again replaces it'
  );

  const listed = await listParts(key, uploadId);
  check(
    'listParts.etag-format',
    listed.response.status === 200 &&
      listed.parts.length === 2 &&
      listed.parts.every(
        (p, i) => p.etagRaw === `"${md5s[i].toString('hex')}"` && p.size === slices[i].length
      ),
    { status: listed.response.status, parts: listed.parts },
    'two parts, ETag = quoted MD5 of the accepted bytes, Size = part length (rejected/replaced parts absent)'
  );
  const fromClient = await spaceContentId(
    total,
    md5s.map(m => m.toString('hex'))
  );
  const fromR2 = await spaceContentId(
    total,
    listed.parts.map(p => p.etagRaw)
  );
  check(
    'contentId.client-equals-listParts',
    fromClient.ok && fromR2.ok && fromClient.contentId === fromR2.contentId,
    {
      client: fromClient.ok ? fromClient.contentId.slice(0, 12) : fromClient,
      r2: fromR2.ok ? fromR2.contentId.slice(0, 12) : fromR2
    },
    'spaceContentId from client MD5s = from ListParts ETags'
  );

  const done = await complete(
    key,
    uploadId,
    listed.parts.map(p => ({ partNumber: p.partNumber, etag: normalizePartEtag(p.etagRaw) }))
  );
  const objectEtag = unquote(xmlOne(done.text, 'ETag'));
  created.uploads = created.uploads.filter(u => u.uploadId !== uploadId);
  created.objects.push(key);
  const expectedObjectEtag = s3MultipartEtag(md5s.map(m => m.toString('hex')));
  check(
    'multipart.complete',
    done.status === 200 && done.text.includes('<CompleteMultipartUploadResult'),
    brief(done),
    '200 CompleteMultipartUploadResult'
  );
  check(
    'complete.object-etag-format',
    objectEtag === `"${expectedObjectEtag}"`,
    { etag: objectEtag, md5OfMd5sN: expectedObjectEtag },
    'quoted MD5 of concatenated binary part MD5s + "-N" (= multipartObjectEtag)'
  );
  check(
    'complete.etag-is-not-part-etag',
    normalizePartEtag(objectEtag) === null,
    { normalized: normalizePartEtag(objectEtag) },
    'normalizePartEtag refuses an object ETag'
  );

  const head = await s3('HEAD', key);
  check(
    'head.object',
    head.status === 200 &&
      Number(head.headers['content-length']) === total &&
      head.headers.etag === `"${expectedObjectEtag}"`,
    brief(head),
    '200, Content-Length = total, ETag = completed ETag'
  );

  // Range across the part boundary, with the browser origin.
  const start = 16 * MIB - 500;
  const end = 16 * MIB + 499;
  const range = await s3('GET', key, {
    headers: { range: `bytes=${start}-${end}`, origin: ORIGINS[0] }
  });
  check(
    'range.get',
    range.status === 206 &&
      range.headers['content-range'] === `bytes ${start}-${end}/${total}` &&
      range.bytes.equals(data.subarray(start, end + 1)),
    { ...brief(range), bytesEqual: range.bytes.equals(data.subarray(start, end + 1)) },
    '206, Content-Range exact, bytes equal across the part boundary'
  );
  check(
    'cors.get-response.exposes',
    range.headers['access-control-allow-origin'] === ORIGINS[0] &&
      ['etag', 'content-range', 'content-length', 'accept-ranges'].every(h =>
        (range.headers['access-control-expose-headers'] ?? '').toLowerCase().includes(h)
      ),
    {
      acao: range.headers['access-control-allow-origin'],
      aceh: range.headers['access-control-expose-headers']
    },
    'GET response exposes ETag, Content-Range, Content-Length, Accept-Ranges'
  );
  const suffix = await s3('GET', key, { headers: { range: 'bytes=-100' } });
  check(
    'range.suffix',
    suffix.status === 206 &&
      suffix.headers['content-range'] === `bytes ${total - 100}-${total - 1}/${total}` &&
      suffix.bytes.equals(data.subarray(total - 100)),
    brief(suffix),
    '206 last 100 bytes'
  );

  const anonymous = await send(`https://${HOST}${canonicalPath(key)}`, { method: 'GET' });
  check(
    'anonymous.get',
    anonymous.status >= 400 && anonymous.status < 500 && anonymous.bytes.length < 4096,
    { status: anonymous.status, code: anonymous.code },
    '4xx without bytes'
  );

  const listing = await s3('GET', '', { query: { 'list-type': '2', prefix: `${RUN}/` } });
  const listedEtag = unquote(xmlOne(xmlOne(listing.text, 'Contents') ?? '', 'ETag'));
  check(
    'listObjects.etag-format',
    listing.status === 200 && listedEtag === `"${expectedObjectEtag}"`,
    { status: listing.status, etag: listedEtag },
    'ListObjectsV2 ETag = completed ETag, quoted'
  );
}

async function sizeRules(created) {
  // Non-uniform non-last parts (5 MiB, 6 MiB, small).
  const key = `${RUN}/uneven.bin`;
  const parts = [randomBytes(5 * MIB), randomBytes(6 * MIB), randomBytes(1024)];
  const uploadId = await createMultipart(key);
  created.uploads.push({ key, uploadId });
  const etags = [];
  for (const [i, part] of parts.entries()) {
    const r = await uploadPartSigned(key, uploadId, i + 1, part, {
      'content-md5': md5(part).toString('base64')
    });
    etags.push(normalizePartEtag(r.headers.etag));
  }
  const uneven = await complete(
    key,
    uploadId,
    etags.map((etag, i) => ({ partNumber: i + 1, etag }))
  );
  const unevenOk = uneven.status === 200 && uneven.text.includes('<CompleteMultipartUploadResult');
  if (unevenOk) {
    created.uploads = created.uploads.filter(u => u.uploadId !== uploadId);
    created.objects.push(key);
  }
  check(
    'parts.non-uniform-rejected',
    !unevenOk,
    { ...brief(uneven), completed: unevenOk },
    'refused: all parts except the last must be the same size'
  );

  // A non-last part below 5 MiB.
  const smallKey = `${RUN}/small.bin`;
  const small = [randomBytes(1 * MIB), randomBytes(1024)];
  const smallId = await createMultipart(smallKey);
  created.uploads.push({ key: smallKey, uploadId: smallId });
  const smallEtags = [];
  for (const [i, part] of small.entries()) {
    const r = await uploadPartSigned(smallKey, smallId, i + 1, part, {
      'content-md5': md5(part).toString('base64')
    });
    smallEtags.push(normalizePartEtag(r.headers.etag));
  }
  const tooSmall = await complete(
    smallKey,
    smallId,
    smallEtags.map((etag, i) => ({ partNumber: i + 1, etag }))
  );
  const tooSmallOk =
    tooSmall.status === 200 && tooSmall.text.includes('<CompleteMultipartUploadResult');
  if (tooSmallOk) {
    created.uploads = created.uploads.filter(u => u.uploadId !== smallId);
    created.objects.push(smallKey);
  }
  check(
    'parts.below-5MiB-rejected',
    !tooSmallOk,
    { ...brief(tooSmall), completed: tooSmallOk },
    'EntityTooSmall'
  );

  // An empty file is one empty part (spacePartCount(0) = 1).
  const emptyKey = `${RUN}/empty.bin`;
  const emptyId = await createMultipart(emptyKey);
  created.uploads.push({ key: emptyKey, uploadId: emptyId });
  const emptyPart = await uploadPartSigned(emptyKey, emptyId, 1, Buffer.alloc(0), {
    'content-md5': md5(Buffer.alloc(0)).toString('base64')
  });
  check(
    'parts.empty-part',
    emptyPart.status === 200 && emptyPart.headers.etag === '"d41d8cd98f00b204e9800998ecf8427e"',
    brief(emptyPart),
    '200, ETag = MD5 of nothing'
  );
  const emptyListed = await listParts(emptyKey, emptyId);
  const emptyContent = await spaceContentId(
    0,
    emptyListed.parts.map(p => p.etagRaw)
  );
  check(
    'contentId.empty-file',
    emptyContent.ok && emptyListed.parts.length === 1 && emptyListed.parts[0].size === 0,
    { parts: emptyListed.parts, ok: emptyContent.ok },
    'one listed part of 0 bytes, content id computable'
  );
  const emptyDone = await complete(emptyKey, emptyId, [
    { partNumber: 1, etag: normalizePartEtag(emptyPart.headers.etag) }
  ]);
  const emptyOk =
    emptyDone.status === 200 && emptyDone.text.includes('<CompleteMultipartUploadResult');
  if (emptyOk) {
    created.uploads = created.uploads.filter(u => u.uploadId !== emptyId);
    created.objects.push(emptyKey);
  }
  const emptyHead = emptyOk ? await s3('HEAD', emptyKey) : null;
  check(
    'multipart.complete-empty',
    emptyOk && emptyHead?.status === 200 && emptyHead.headers['content-length'] === '0',
    {
      complete: brief(emptyDone),
      etag: unquote(xmlOne(emptyDone.text, 'ETag')),
      head: emptyHead && brief(emptyHead)
    },
    'a 0-byte multipart completes into a 0-byte object'
  );
}

async function abortFlow(created) {
  const key = `${RUN}/abort.bin`;
  const uploadId = await createMultipart(key);
  created.uploads.push({ key, uploadId });
  const part = randomBytes(1024);
  await uploadPartSigned(key, uploadId, 1, part, { 'content-md5': md5(part).toString('base64') });
  const abort = await s3('DELETE', key, { query: { uploadId } });
  check('multipart.abort', abort.status === 204, brief(abort), '204');
  created.uploads = created.uploads.filter(u => u.uploadId !== uploadId);
  const after = await listParts(key, uploadId);
  check(
    'abort.listParts',
    after.response.status === 404 && after.response.code === 'NoSuchUpload',
    brief(after.response),
    '404 NoSuchUpload (SpaceR2.listParts → NOT_FOUND)'
  );
  const again = await s3('DELETE', key, { query: { uploadId } });
  check(
    'abort.repeat',
    again.status === 204 || again.status === 404,
    brief(again),
    '204 or 404 (both tolerated by abortMultipart)'
  );
  const late = await complete(key, uploadId, [{ partNumber: 1, etag: md5(part).toString('hex') }]);
  check(
    'abort.complete-after',
    late.status === 404,
    brief(late),
    '404 NoSuchUpload (completeMultipart → NOT_FOUND)'
  );
  const head = await s3('HEAD', key);
  check('abort.no-object', head.status === 404, { status: head.status }, 'nothing at the key');
}

async function readbacks() {
  // Jurisdiction: an EU-jurisdiction bucket answers only on the `.eu.` endpoint, a
  // default-jurisdiction one only on the plain endpoint.
  const plain = await s3('HEAD', '');
  const eu = await s3('HEAD', '', { host: `${ACCOUNT}.eu.r2.cloudflarestorage.com` });
  report.jurisdiction = {
    defaultEndpoint: plain.status,
    euEndpoint: eu.status,
    // A jurisdiction endpoint cannot reach resources outside its jurisdiction (R2 data
    // location docs), so a bucket answering only on the plain endpoint is not an EU one.
    verdict: eu.status === 200 ? 'eu' : plain.status === 200 ? 'default' : 'unknown'
  };
  console.log(`INFO jurisdiction: ${JSON.stringify(report.jurisdiction)}`);
  for (const sub of ['cors', 'lifecycle', 'location']) {
    const r = await s3('GET', '', { query: { [sub]: '' } });
    const entry = { status: r.status, code: r.code };
    if (r.status === 200) entry.body = r.text.replace(/\s+/gu, ' ').slice(0, 4000);
    report[`readback_${sub}`] = entry;
    console.log(`INFO readback.${sub}: ${JSON.stringify(entry)}`);
  }
}

async function cleanup() {
  let aborted = 0;
  let deleted = 0;
  const uploads = await s3('GET', '', { query: { uploads: '', prefix: 'qualify/' } });
  for (const block of xmlAll(uploads.text, 'Upload')) {
    const key = xmlOne(block, 'Key');
    const uploadId = xmlOne(block, 'UploadId');
    if (key?.startsWith('qualify/') && uploadId) {
      const r = await s3('DELETE', key, { query: { uploadId } });
      if (r.status === 204 || r.status === 404) aborted += 1;
    }
  }
  for (let page = 0; page < 20; page += 1) {
    const list = await s3('GET', '', { query: { 'list-type': '2', prefix: 'qualify/' } });
    const keys = xmlAll(list.text, 'Key').filter(k => k.startsWith('qualify/'));
    if (keys.length === 0) break;
    for (const key of keys) {
      const r = await s3('DELETE', key);
      if (r.status === 204 || r.status === 404) deleted += 1;
    }
  }
  const finalObjects = await s3('GET', '', { query: { 'list-type': '2', prefix: 'qualify/' } });
  const finalUploads = await s3('GET', '', { query: { uploads: '', prefix: 'qualify/' } });
  const left = {
    objects: xmlAll(finalObjects.text, 'Key').length,
    uploads: xmlAll(finalUploads.text, 'Upload').length,
    listStatus: [finalObjects.status, finalUploads.status]
  };
  check(
    'cleanup.prefix-empty',
    left.objects === 0 &&
      left.uploads === 0 &&
      finalObjects.status === 200 &&
      finalUploads.status === 200,
    { aborted, deleted, ...left },
    'no object and no open multipart under qualify/'
  );
}

const created = { uploads: [], objects: [] };
let fatal = null;
try {
  await preflights();
  await mainUpload(created);
  await sizeRules(created);
  await abortFlow(created);
  await readbacks();
} catch (error) {
  fatal = error.message;
  console.error(`FATAL ${fatal}`);
} finally {
  await cleanup();
}
report.finishedAt = new Date().toISOString();
report.fatal = fatal;
report.passed = report.checks.filter(c => c.pass).length;
report.failed = report.checks.filter(c => !c.pass).map(c => c.id);
if (args.out) writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${report.passed}/${report.checks.length} passed${fatal ? `, fatal: ${fatal}` : ''}`);
process.exit(fatal || report.failed.length ? 1 : 0);
