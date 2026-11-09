const [version, bundleVersion, buildNumber, buildId, apiVersion, sourceRevision, artifact] =
  process.argv.slice(2);
const target = process.argv[9] ?? 'arm64';
if (!['arm64', 'x64'].includes(target)) throw new Error('MACOS_TARGET_INVALID');

if (
  ![version, bundleVersion, buildNumber, buildId, apiVersion, sourceRevision, artifact].every(
    Boolean
  )
) {
  process.stderr.write('Missing dev release metadata.\n');
  process.exit(2);
}

process.stdout.write(
  `${JSON.stringify(
    {
      productVersion: version,
      bundleVersion,
      buildNumber,
      buildId,
      apiVersion: Number(apiVersion),
      supportedAgentApi: { min: Number(apiVersion), max: Number(apiVersion) },
      channel: 'development',
      target: `macos-${target}`,
      architecture: target,
      tag: null,
      artifact,
      downloadUrl: null,
      sourceRevision
    },
    null,
    2
  )}\n`
);
