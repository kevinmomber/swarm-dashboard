import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './settings.js';

const FILE = path.join(DATA_DIR, 'stacks.json');
let cache = null;

export async function loadStacks() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(list) {
  await mkdir(DATA_DIR, { recursive: true });
  cache = list;
  await writeFile(FILE, JSON.stringify(list, null, 2), 'utf8');
}

export async function getStack(name) {
  return (await loadStacks()).find((s) => s.name === name) || null;
}

export async function saveStack(name, compose) {
  const list = await loadStacks();
  const rec = { name, compose, savedAt: new Date().toISOString() };
  const i = list.findIndex((s) => s.name === name);
  if (i >= 0) list[i] = rec;
  else list.push(rec);
  await persist(list);
  return rec;
}

export async function deleteStack(name) {
  const list = (await loadStacks()).filter((s) => s.name !== name);
  await persist(list);
}
