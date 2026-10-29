import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig(repo) {
  const base = JSON.parse(fs.readFileSync(path.join(HERE, 'blueprint.config.json'), 'utf8'));
  const local = path.join(repo, '.blueprint.json');
  if (!fs.existsSync(local)) return base;
  const o = JSON.parse(fs.readFileSync(local, 'utf8'));
  return { ...base, ...o, messaging: { ...base.messaging, ...o.messaging }, externalSystems: { ...base.externalSystems, ...o.externalSystems } };
}
