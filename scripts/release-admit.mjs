#!/usr/bin/env node
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';

export async function requestLease(socketPath, message, capability) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let reply = '';
    socket.setEncoding('utf8');
    socket.once('error', error => reject(new Error(`LEASE_SOCKET_UNAVAILABLE: ${error.message}`)));
    socket.on('data', chunk => {
      reply += chunk;
    });
    socket.once('end', () => {
      try {
        resolve(JSON.parse(reply));
      } catch {
        reject(new Error('LEASE_REPLY_INVALID'));
      }
    });
    socket.once('connect', () => socket.end(`${JSON.stringify({ ...message, capability })}\n`));
  });
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [socketPath, messagePath] = process.argv.slice(2);
  const capabilityFd = process.env.SOTY_RELEASE_CAPABILITY_FD;
  if (!socketPath || !messagePath || !capabilityFd)
    throw new Error(
      'Usage: release-admit <socket> <message.json> (requires inherited SOTY_RELEASE_CAPABILITY_FD)'
    );
  const capability = (await readFile(`/dev/fd/${capabilityFd}`, 'utf8')).trim();
  const message = JSON.parse(await readFile(messagePath, 'utf8'));
  process.stdout.write(`${JSON.stringify(await requestLease(socketPath, message, capability))}\n`);
}
