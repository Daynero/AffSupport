#!/usr/bin/env node
import { readFile, mkdir, unlink, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { atomicRecord } from './lib/release/task-store.mjs';
import { providerBoundaryDigest } from './lib/release/codex-provider.mjs';
const exec = promisify(execFile);
const root = path.resolve('release/automation');
const plist = path.join(homedir(), 'Library/LaunchAgents/com.soty.release-controller.plist');
const flag = name => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? null : process.argv[index + 1];
};
const escape = s =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
if (process.platform !== 'darwin' || process.getuid?.() == null)
  throw new Error('MACOS_USER_SESSION_REQUIRED');
const domain = `gui/${process.getuid()}`;
if (process.argv.includes('--uninstall')) {
  const info = await lstat(plist);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('CONTROLLER_INSTALL_TARGET_CONFLICT');
  const content = await readFile(plist, 'utf8');
  if (
    !content.includes('com.soty.release-controller') ||
    !content.includes(escape(path.resolve('scripts/release-controller.mjs')))
  )
    throw new Error('CONTROLLER_INSTALL_TARGET_CONFLICT');
  await exec('/bin/launchctl', ['bootout', `${domain}/com.soty.release-controller`]);
  await unlink(plist);
  console.log('Controller service removed. Task records and artifacts preserved.');
} else {
  const executable = flag('codex');
  const capabilityPath = flag('provider-receipt');
  const bindingsPath = flag('bindings');
  if (!executable || !capabilityPath || !bindingsPath)
    throw new Error('ABSOLUTE_INSTALL_INPUTS_REQUIRED');
  if (
    ![executable, capabilityPath, bindingsPath].every(
      p => typeof p === 'string' && path.isAbsolute(p)
    )
  )
    throw new Error('ABSOLUTE_INSTALL_INPUTS_REQUIRED');
  const receipt = JSON.parse(await readFile(capabilityPath, 'utf8'));
  const version = (await exec(executable, ['--version'], { timeout: 10000 })).stdout
    .trim()
    .replace(/^codex-cli\s+/, '');
  if (
    !receipt.ready ||
    receipt.checks?.untrustedPolicy !== true ||
    receipt.executable !== executable ||
    receipt.version !== version ||
    receipt.boundaryDigest !== (await providerBoundaryDigest())
  )
    throw new Error('PROVIDER_CAPABILITY_REQUIRED');
  await lstat(path.join(root, 'panel/release-panel.html'));
  await lstat(path.join(root, 'release-runner.env'));
  const config = {
    schemaVersion: 1,
    executable,
    capabilityPath: path.join(root, 'provider-capability.json'),
    bindingsPath,
    repositoryRoot: process.cwd(),
    assetsRoot: path.join(root, 'panel')
  };
  await atomicRecord(config.capabilityPath, receipt);
  await atomicRecord(path.join(root, 'controller-config.json'), config);
  let template = await readFile(
    new URL('../packaging/release/controller-launchagent.plist.template', import.meta.url),
    'utf8'
  );
  for (const [key, value] of Object.entries({
    NODE: process.execPath,
    SCRIPT: path.resolve('scripts/release-controller.mjs'),
    ROOT: process.cwd(),
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    CONFIG: path.join(root, 'controller-config.json')
  }))
    template = template.replaceAll(`{{${key}}}`, escape(value));
  await mkdir(path.dirname(plist), { recursive: true });
  const fd = await import('node:fs/promises').then(({ open }) => open(plist, 'wx', 0o600));
  try {
    await fd.writeFile(template);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await exec('/bin/launchctl', ['bootstrap', domain, plist]);
  console.log('Release controller installed. No release was started.');
}
