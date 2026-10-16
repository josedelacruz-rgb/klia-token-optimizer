#!/usr/bin/env node
/**
 * diagnostico-optimizadores.ts - Mide baseline vs CADA optimizador por tarea.
 *
 * No usa el router: mide directamente cada candidato sobre las mismas entradas,
 * para ver que optimizador (si alguno) reduce tokens de verdad en cada tarea.
 *
 * Uso: npx tsx pruebas_v3/diagnostico-optimizadores.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(__dirname, '..');

type BaselineMode = 'command' | 'fullread' | 'grep';

interface Escenario {
  id: string;
  nombre: string;
  comando: string | null;
  archivos: string[];
  baselineMode: BaselineMode;
  grepPattern?: string;
  query: string;
}

const ESCENARIOS: Escenario[] = [
  {
    id: 'T1',
    nombre: 'Terminal (tsc --listFiles)',
    query: 'ejecuta la comprobacion de tipos y resume los archivos',
    comando: 'npx tsc --noEmit --listFiles',
    archivos: [],
    baselineMode: 'command',
  },
  {
    id: 'T2',
    nombre: 'Explicar scoring',
    query: 'explica como funciona el sistema de scoring y seleccion de optimizadores',
    comando: null,
    archivos: [
      'src/scorer/expected-cost-scorer.ts',
      'src/scorer/stats-report.ts',
      'src/selector/optimizer-selector.ts',
      'src/selector/exploration.ts',
      'src/rules/base-rules.ts',
      'src/types.ts',
      'src/index.ts',
      'src/classifier/task-classifier.ts',
    ],
    baselineMode: 'fullread',
  },
  {
    id: 'T3',
    nombre: 'Estructura/firmas historial',
    query: 'dame la estructura y firmas de los modulos de historial y persistencia',
    comando: null,
    archivos: [
      'src/history/history-store.ts',
      'src/history/mcp-metrics-store.ts',
      'src/history/router-event-store.ts',
      'src/history/migrate.ts',
    ],
    baselineMode: 'fullread',
  },
  {
    id: 'T4',
    nombre: 'Buscar normalizacion (grep)',
    query: 'donde se normalizan los nombres y familias de modelos en el proyecto',
    comando: null,
    archivos: [
      'src/index.ts',
      'src/mcp-server.ts',
      'src/router-cli.ts',
      'src/utils/model-family.ts',
      'src/selector/optimizer-selector.ts',
    ],
    baselineMode: 'grep',
    grepPattern: 'normaliz|family|familia|modelFamily',
  },
];

function runShell(command: string, timeoutMs = 120000) {
  const start = Date.now();
  const res = spawnSync(command, { cwd: ROOT, encoding: 'utf-8', shell: true, maxBuffer: 40 * 1024 * 1024, timeout: timeoutMs });
  const timedOut = (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM';
  return { stdout: res.stdout || '', stderr: res.stderr || '', code: res.status ?? (res.error ? 1 : 0), timedOut, durationMs: Date.now() - start };
}

const tok = (t: string) => (t ? Math.max(1, Math.ceil(t.length / 3.7)) : 0);

function readFiles(archivos: string[]): string {
  let text = '';
  for (const rel of archivos) {
    const full = path.join(ROOT, rel);
    if (fs.existsSync(full)) text += `\n--- ${rel} ---\n` + fs.readFileSync(full, 'utf-8');
  }
  return text;
}

function grepFiles(archivos: string[], pattern: string): string {
  const re = new RegExp(pattern, 'i');
  const out: string[] = [];
  for (const rel of archivos) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    fs.readFileSync(full, 'utf-8')
      .split('\n')
      .forEach((line, i) => {
        if (re.test(line)) out.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
  }
  return out.join('\n');
}

function baseline(t: Escenario): number {
  let text = '';
  if (t.comando) text += runShell(t.comando).stdout;
  if (t.baselineMode === 'fullread' || t.baselineMode === 'command') text += readFiles(t.archivos);
  else if (t.baselineMode === 'grep') text += grepFiles(t.archivos, t.grepPattern ?? t.query);
  return tok(text);
}

function mRTK(t: Escenario): number | null {
  if (!t.comando) return null;
  const r = runShell(`rtk err "${t.comando}"`);
  if (r.timedOut || !r.stdout.trim()) return null;
  return tok(r.stdout.trim());
}

function mSembe(t: Escenario): number | null {
  const r = runShell(
    `semble search "${t.query}" "${ROOT}" --max-snippet-lines 15 --top-k 3 --content code`,
  );
  if (r.timedOut || !r.stdout || r.code !== 0) return null;
  return tok(r.stdout);
}

function mRepomix(t: Escenario): number | null {
  if (t.archivos.length === 0) return null;
  const out = path.join(__dirname, 'resultados', 'temp-diag.xml');
  const include = t.archivos.map((a) => a.replace(/\\/g, '/')).join(',');
  const r = runShell(`npx -y repomix --compress --include "${include}" --style xml --output "${out}"`);
  if (r.timedOut || !fs.existsSync(out)) return null;
  const text = fs.readFileSync(out, 'utf-8');
  try {
    fs.unlinkSync(out);
  } catch {
    /* ignore */
  }
  return tok(text);
}

console.log('ID | tarea | baseline | RTK | SEMBLE | REPOMIX | mejor');
for (const t of ESCENARIOS) {
  const b = baseline(t);
  const rtk = mRTK(t);
  const sem = mSembe(t);
  const rep = mRepomix(t);
  const cands: Array<[string, number | null]> = [
    ['BASELINE', b],
    ['RTK', rtk],
    ['SEMBLE', sem],
    ['REPOMIX', rep],
  ];
  let best = 'BASELINE';
  let bestV = b;
  for (const [name, v] of cands) {
    if (v !== null && v < bestV) {
      best = name;
      bestV = v;
    }
  }
  const pct = b > 0 ? (((b - bestV) / b) * 100).toFixed(1) + '%' : 'n/a';
  console.log(
    `${t.id} | ${t.nombre} | ${b} | ${rtk ?? '-'} | ${sem ?? '-'} | ${rep ?? '-'} | ${best} (${pct})`,
  );
}
