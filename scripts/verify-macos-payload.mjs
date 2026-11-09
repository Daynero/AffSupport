import { parseMacosTarget } from './lib/macos-target.mjs';
import { verifyMacosPayload } from './lib/macos-payload.mjs';
const [root, ...args] = process.argv.slice(2);
const target = parseMacosTarget(args);
if (!root) throw new Error('MACOS_PAYLOAD_PATH_REQUIRED');
process.stdout.write(`${JSON.stringify(await verifyMacosPayload(root, target.arch))}\n`);
