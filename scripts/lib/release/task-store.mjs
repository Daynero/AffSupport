import { mkdir, open, readFile, rename, readdir, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function validTaskId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new Error('INVALID_TASK_ID');
  return id;
}

export async function atomicRecord(file, value, exclusive = false) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = await open(temporary, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); } finally { await fd.close(); }
  try {
    if (exclusive) await link(temporary, file);
    else await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
  const directory = await open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  return value;
}

export class TaskStore {
  constructor(root) { this.root = path.resolve(root, 'tasks'); this.writers = new Map(); }
  file(id) { return path.join(this.root, validTaskId(id), 'task.json'); }
  async read(id) { return JSON.parse(await readFile(this.file(id), 'utf8')); }
  async create(value) {
    return atomicRecord(this.file(value.taskId), { ...value, schemaVersion: 1, revision: 1, updatedAt: new Date().toISOString() }, true);
  }
  async update(id, expectedRevision, patch) {
    const previous = this.writers.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const current = await this.read(id);
      if (current.revision !== expectedRevision) throw new Error('TASK_REVISION_CONFLICT');
      return atomicRecord(this.file(id), { ...current, ...patch, taskId: id, schemaVersion: 1,
        revision: current.revision + 1, updatedAt: new Date().toISOString() });
    });
    this.writers.set(id, next);
    try { return await next; } finally { if (this.writers.get(id) === next) this.writers.delete(id); }
  }
  async list() {
    const names = await readdir(this.root).catch((error) => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    if (names.length > 10000) throw new Error('TASK_HISTORY_TOO_LARGE');
    const tasks = await Promise.all(names.filter((id) => /^[a-f0-9-]{36}$/i.test(id)).map((id) => this.read(id)));
    return tasks.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }
}
