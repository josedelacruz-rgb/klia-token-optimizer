// Carga de configuracion por defecto del servicio.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function loadDefaults() {
  const raw = readFileSync(join(here, 'defaults.json'), 'utf-8');
  return JSON.parse(raw);
}
