export function webDeployMarker({ binding, sourceSha, manifestSha, outputDigest }) {
  if (!binding || !/^[a-f0-9]{40}$/u.test(sourceSha) || !/^[a-f0-9]{40}$/u.test(manifestSha) || !/^[a-f0-9]{64}$/u.test(outputDigest)) throw new Error('WEB_DEPLOY_IDENTITY_INVALID');
  return Object.freeze({ bindingId: binding.bindingId, sourceSha, manifestSha, outputDigest });
}
