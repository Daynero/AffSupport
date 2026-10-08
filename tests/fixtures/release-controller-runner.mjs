/** Fixed synthetic runner, used only in temporary test repositories. */
import process from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';
const command = process.argv[2];
const index = process.argv.indexOf('--intent');
const intent = JSON.parse(await readFile(process.argv[index + 1], 'utf8'));
if (command === 'start') {
  const binding = JSON.parse(await readFile(process.env.SOTY_RELEASE_BINDING, 'utf8'));
  await writeFile(
    process.env.CONTROLLER_TEST_CAPTURE,
    JSON.stringify({ intent, binding, owner: process.env.SOTY_RELEASE_HANDOFF_OWNER })
  );
}
process.stdout.write(JSON.stringify({ ok: true, data: { synthetic: true } }));
