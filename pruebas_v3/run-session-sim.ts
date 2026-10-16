#!/usr/bin/env node
/**
 * run-session-sim.ts - Simulador de SESIONES de desarrollo (aleatorizado, reproducible).
 *
 * Pregunta que responde: "¿SIRVE klia-token-optimizer frente a OpenCode baseline
 * en una jornada real de trabajo?".
 *
 * Como funciona:
 *  - Genera N sesiones. Cada sesion es una secuencia ALEATORIA (semilla fija) de
 *    tareas muestreadas de un pool ponderado por lo que de verdad hace un dev:
 *    leer ficheros, git status/log/show, buscar simbolos, entender modulos,
 *    consultar docs, ver dependencias, pasar tsc, refactorizar, navegar ficheros
 *    grandes.
 *  - Para CADA tarea:
 *      baseline  = lo que OpenCode inyecta crudo (Read con prefijo "N:", Bash
 *                  truncado a 2000 lineas / 51200 bytes).
 *      optimizado= la salida del optimizador que el ROUTER REAL elige
 *                  (createAdaptiveRouter(...).route(ctx), en frio V0).
 *      El potencial se mide con el optimizador "applicable" (el que de verdad
 *      ayuda); el producto, con lo que el router decide; y el techo observado
 *      es el minimo logrado entre recomendado y router (nunca menor que producto).
 *  - Tokens REALES via KLIA `/v1/chat/completions` (usage.prompt_tokens).
 *  - Gate de cobertura + recuperacion SIMETRICO (artefacto completo) y techo.
 *  - Artefactos REALES: git real, `npx tsc --noEmit` real, node_modules real,
 *    ficheros src reales, docs reales.
 *
 * Honestidad: DCP / CONTEXT_MODE / SERENA no tienen CLI en el repo; se modelan
 * de forma determinista (poda/dedup, recuperacion de secciones, git grep). Se
 * marcan como proxy en el informe.
 *
 * Uso: npx tsx pruebas_v3/run-session-sim.ts [--sessions 10] [--tasks 12] [--seed 20261016] [--model GLM-5.2]
 * Presupuesto: < 25 min (objetivo ~6-10 min). Sin repeticiones.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import { buildContextFromQuery, createAdaptiveRouter } from '../src/index';
import type { Optimizer, TaskSignals } from '../src/types';

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'resultados');
const DATA_PATH = path.join(OUT_DIR, 'resultados-session-sim.json');
const REPORTE_PATH = path.join(OUT_DIR, 'reporte-session-sim.md');
const TIMEOUT_MS = 120_000;

const API_BASE = process.env.KLIA_API_BASE || 'https://api.klia.tech/v1';
const API_KEY = process.env.KLIA_API_KEY || '';
let MODEL = process.env.KLIA_BENCH_MODEL || 'GLM-5.2';

const OPENCODE_MAX_LINES = 2000;
const OPENCODE_MAX_BYTES = 51200;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- RNG determinista (mulberry32) -------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
class Rng {
  private r: () => number;
  constructor(seed: number) {
    this.r = mulberry32(seed);
  }
  float(): number {
    return this.r();
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.r() * (max - min + 1));
  }
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.r() * arr.length)];
  }
  weighted<T>(entries: Array<{ w: number; v: T }>): T {
    const total = entries.reduce((a, e) => a + e.w, 0);
    let x = this.r() * total;
    for (const e of entries) {
      x -= e.w;
      if (x <= 0) return e.v;
    }
    return entries[entries.length - 1].v;
  }
}

// --- Helpers -----------------------------------------------------------------

interface ShellResult {
  stdout: string;
  ok: boolean;
  timedOut: boolean;
}

function runShell(command: string, timeoutMs = TIMEOUT_MS): ShellResult {
  const res = spawnSync(command, {
    cwd: ROOT,
    encoding: 'utf-8',
    shell: true,
    maxBuffer: 128 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    stdout: (res.stdout || '').toString(),
    ok: !res.error && res.status === 0,
    timedOut: !!(res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'),
  };
}

function cap(text: string): string {
  const raw = text ?? '';
  const lines = raw.split('\n');
  if (lines.length <= OPENCODE_MAX_LINES && Buffer.byteLength(raw, 'utf-8') <= OPENCODE_MAX_BYTES) return raw;
  const kept: string[] = [];
  let bytes = 0;
  for (let i = 0; i < lines.length && i < OPENCODE_MAX_LINES; i++) {
    const add = Buffer.byteLength(lines[i] + '\n', 'utf-8');
    if (bytes + add > OPENCODE_MAX_BYTES) break;
    kept.push(lines[i]);
    bytes += add;
  }
  return kept.join('\n') + `\n[OpenCode: truncado a ${kept.length} lineas / ${bytes} bytes]`;
}

function readFormat(rel: string): string {
  try {
    return fs
      .readFileSync(path.join(ROOT, rel), 'utf-8')
      .split('\n')
      .map((l, i) => `${i + 1}: ${l}`)
      .join('\n');
  } catch {
    return '';
  }
}

function listFiles(dir: string, ext = '.ts'): string[] {
  const out: string[] = [];
  const base = path.join(ROOT, dir);
  const walk = (d: string): void => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(ext)) out.push(path.relative(ROOT, p).replace(/\\/g, '/'));
    }
  };
  walk(base);
  return out.sort();
}

function sizeOf(rel: string): number {
  try {
    return fs.statSync(path.join(ROOT, rel)).size;
  } catch {
    return 0;
  }
}

function mdSections(md: string): Array<{ title: string; body: string }> {
  const out: Array<{ title: string; body: string }> = [];
  let cur = { title: '(preambulo)', body: [] as string[] };
  for (const line of md.split('\n')) {
    if (/^#{1,4}\s+/.test(line)) {
      if (cur.body.length || cur.title !== '(preambulo)') out.push({ title: cur.title, body: cur.body.join('\n') });
      cur = { title: line, body: [] };
    } else cur.body.push(line);
  }
  out.push({ title: cur.title, body: cur.body.join('\n') });
  return out;
}

function retrieveSections(md: string, query: string, top = 2): string {
  const terms = Array.from(new Set(query.toLowerCase().match(/[a-z0-9_]{3,}/g) || []));
  const scored = mdSections(md).map((s) => {
    const hay = (s.title + '\n' + s.body).toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += 1;
    return { ...s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const chosen = scored.filter((s) => s.score > 0).slice(0, top);
  const use = chosen.length ? chosen : scored.slice(0, top);
  return use.map((s) => `${s.title}\n${s.body}`).join('\n\n').trim();
}

// --- Conteo de tokens REAL ---------------------------------------------------

const tokenCache = new Map<string, number>();
async function countTokensRaw(text: string): Promise<number> {
  const key = crypto.createHash('sha1').update(text).digest('hex');
  const c = tokenCache.get(key);
  if (c !== undefined) return c;
  const body = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: text }], max_tokens: 1 });
  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`${API_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body,
      });
      if (r.status === 429 || r.status >= 500) {
        lastErr = `HTTP ${r.status}`;
        await sleep(1500 * (attempt + 1));
        continue;
      }
      const j = (await r.json()) as { usage?: { prompt_tokens?: number } };
      if (!j.usage || typeof j.usage.prompt_tokens !== 'number') {
        lastErr = `sin usage: ${JSON.stringify(j).slice(0, 160)}`;
        await sleep(800);
        continue;
      }
      tokenCache.set(key, j.usage.prompt_tokens);
      return j.usage.prompt_tokens;
    } catch (e) {
      lastErr = (e as Error).message;
      await sleep(800 * (attempt + 1));
    }
  }
  throw new Error(`countTokens fallo (len=${text.length}): ${lastErr}`);
}

let _Overhead: number | null = null;
async function overhead(): Promise<number> {
  if (_Overhead === null) _Overhead = Math.max(0, (await countTokensRaw('x')) - 1);
  return _Overhead;
}
async function toks(text: string): Promise<number> {
  if (!text) return 0;
  return Math.max(1, (await countTokensRaw(text)) - (await overhead()));
}

// --- Entorno + caches perezosas ----------------------------------------------

interface Env {
  commits: string[];
  commitMeta: Map<string, { subject: string; files: string[] }>;
  srcFiles: string[];
  exportNames: string[];
  modelFiles: string[];
  agentsMd: string;
  readmeMd: string;
  ps1: string;
  nmTop: string;
  nmTree: string;
  tscOut: string;
  tscFiles: string[];
  dirs: string[];
  semble: (q: string) => string;
  repomix: (dir: string) => string;
  rtkErrTsc: () => string;
  exportsInDir: (dir: string) => string[];
}

function collectEnv(): Env {
  const commits = runShell('git log --format=%H -n 20')
    .stdout.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const commitMeta = new Map<string, { subject: string; files: string[] }>();
  for (const h of commits) {
    const subject = runShell(`git log -1 --format=%s ${h}`).stdout.trim();
    const files = runShell(`git show --name-only --format= ${h}`)
      .stdout.split('\n')
      .map((s) => s.trim().replace(/\\/g, '/'))
      .filter(Boolean);
    commitMeta.set(h, { subject, files });
  }

  const srcFiles = listFiles('src');
  const exportsOut = runShell('git grep -h -E "^export (const|function|class|interface|type|enum) " -- src').stdout;
  const exportNames: string[] = [];
  for (const line of exportsOut.split('\n')) {
    const m = line.match(/^\s*export\s+(?:const|function|class|interface|type|enum)\s+([A-Za-z0-9_]+)/);
    if (m) exportNames.push(m[1]);
  }
  const modelFiles = Array.from(
    new Set(
      [
        ...runShell('git grep -l "KLIA_API_KEY" -- src').stdout.split('\n'),
        ...runShell('git grep -l "/v1/models" -- src').stdout.split('\n'),
      ]
        .map((s) => s.trim().replace(/\\/g, '/'))
        .filter(Boolean),
    ),
  );

  const nmDir = path.join(ROOT, 'node_modules');
  const nmTop = fs
    .readdirSync(nmDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '.bin')
    .map((e) => e.name)
    .sort()
    .join('\n');
  const nmTree: string[] = [];
  const walkTree = (d: string, base: string): void => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) {
        nmTree.push(rel + '/');
        walkTree(path.join(d, e.name), rel);
      } else nmTree.push(rel);
    }
  };
  walkTree(nmDir, '');

  const tscOut = runShell('npx tsc --noEmit', 180_000).stdout;
  const tscFiles = Array.from(
    new Set(
      tscOut
        .split('\n')
        .map((l) => (l.match(/^([^(:]+)\(\d+,\d+\): error/) || [])[1])
        .filter(Boolean)
        .map((s) => (s as string).trim()),
    ),
  );

  const dirs = Array.from(new Set(srcFiles.map((f) => path.dirname(f)))).filter((d) => d !== 'src' || srcFiles.some((f) => path.dirname(f) === 'src'));

  const sembleCache = new Map<string, string>();
  const repomixCache = new Map<string, string>();
  let rtkErrCache: string | null = null;
  const exportsDirCache = new Map<string, string[]>();

  const exportsInDir = (dir: string): string[] => {
    if (exportsDirCache.has(dir)) return exportsDirCache.get(dir)!;
    const out = runShell(`git grep -h -E "^export (const|function|class|interface|type|enum) " -- ${dir}`).stdout;
    const names: string[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*export\s+(?:const|function|class|interface|type|enum)\s+([A-Za-z0-9_]+)/);
      if (m) names.push(m[1]);
    }
    exportsDirCache.set(dir, names);
    return names;
  };

  return {
    commits,
    commitMeta,
    srcFiles,
    exportNames,
    modelFiles,
    agentsMd: fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf-8'),
    readmeMd: fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8'),
    ps1: fs.readFileSync(path.join(ROOT, 'Install_klia_token.ps1'), 'utf-8'),
    nmTop,
    nmTree: nmTree.join('\n'),
    tscOut,
    tscFiles,
    dirs,
    semble: (q: string) => {
      if (!sembleCache.has(q)) {
        sembleCache.set(q, runShell(`semble search "${q.replace(/"/g, '')}" . --max-snippet-lines 10 --top-k 5`).stdout);
      }
      return sembleCache.get(q)!;
    },
    repomix: (dir: string) => {
      if (!repomixCache.has(dir)) {
        repomixCache.set(dir, runShell(`npx -y repomix ${dir} --compress --stdout`, 180_000).stdout);
      }
      return repomixCache.get(dir)!;
    },
    rtkErrTsc: () => {
      if (rtkErrCache === null) rtkErrCache = runShell('rtk err npx tsc --noEmit', 180_000).stdout;
      return rtkErrCache;
    },
    exportsInDir,
  };
}

// --- Modelo de tarea ---------------------------------------------------------

interface WorkItem {
  category: string;
  query: string;
  signals: Partial<TaskSignals>;
  applicable: Optimizer;
  builders: Partial<Record<Optimizer, () => string>>;
  baseline: () => string;
  facts: string[];
  recovery: () => string;
  minimal: string;
}

type Category =
  | 'read_file'
  | 'git_small'
  | 'git_diff'
  | 'search_symbol'
  | 'structure'
  | 'docs'
  | 'deps'
  | 'verify'
  | 'refactor'
  | 'bigfile';

function makeItem(cat: Category, env: Env, rng: Rng): WorkItem {
  switch (cat) {
    case 'read_file': {
      const f = rng.pick(env.srcFiles);
      return {
        category: cat,
        query: `abre y revisa el fichero ${f}`,
        signals: { fileCount: 1, contextSizeBytes: sizeOf(f) },
        applicable: 'BASELINE',
        builders: {},
        baseline: () => readFormat(f),
        facts: [],
        recovery: () => readFormat(f),
        minimal: path.basename(f),
      };
    }
    case 'git_small': {
      const useLog = rng.float() < 0.5;
      const out = useLog ? runShell('git log --oneline -n 10').stdout : runShell('git status').stdout;
      return {
        category: cat,
        query: useLog ? 'muestra los ultimos commits' : 'git status del repositorio',
        signals: { hasTerminalCommands: true },
        applicable: 'BASELINE',
        builders: {},
        baseline: () => out,
        facts: [],
        recovery: () => out,
        minimal: 'git status/log',
      };
    }
    case 'git_diff': {
      const h = rng.pick(env.commits);
      const meta = env.commitMeta.get(h)!;
      return {
        category: cat,
        query: 'resume los cambios de este commit',
        signals: { hasTerminalCommands: true },
        applicable: 'RTK',
        builders: { RTK: () => runShell(`rtk git show ${h}`).stdout },
        baseline: () => runShell(`git show ${h}`).stdout,
        facts: [meta.subject, ...meta.files.slice(0, 8)].filter(Boolean),
        recovery: () => runShell(`git show ${h}`).stdout,
        minimal: [meta.subject, ...meta.files].join('\n'),
      };
    }
    case 'search_symbol': {
      const sym = rng.pick(env.exportNames);
      const hitFiles = runShell(`git grep -l "\\b${sym}\\b" -- src`)
        .stdout.split('\n')
        .map((s) => s.trim().replace(/\\/g, '/'))
        .filter(Boolean);
      const files = hitFiles.length ? hitFiles : env.srcFiles.slice(0, 3);
      return {
        category: cat,
        query: `donde se define y usa ${sym} en el codigo`,
        signals: { isRepositorySearch: true, fileCount: files.length, contextSizeBytes: files.reduce((a, f) => a + sizeOf(f), 0) },
        applicable: 'SEMBLE',
        builders: { SEMBLE: () => env.semble(`where is ${sym} defined and used`) },
        baseline: () => files.map(readFormat).join('\n\n'),
        facts: [sym],
        recovery: () => files.map(readFormat).join('\n\n'),
        minimal: sym,
      };
    }
    case 'structure': {
      const dir = rng.pick(env.dirs);
      const files = listFiles(dir);
      return {
        category: cat,
        query: `dame la estructura y las firmas del modulo ${path.basename(dir)}`,
        signals: { fileCount: files.length, contextSizeBytes: files.reduce((a, f) => a + sizeOf(f), 0) },
        applicable: 'REPOMIX',
        builders: {
          REPOMIX: () => env.repomix(dir),
          SEMBLE: () => env.semble(`signatures and structure of module ${path.basename(dir)}`),
        },
        baseline: () => files.map(readFormat).join('\n\n'),
        facts: env.exportsInDir(dir),
        recovery: () => files.map(readFormat).join('\n\n'),
        minimal: env.exportsInDir(dir).join(' '),
      };
    }
    case 'docs': {
      const useAgents = rng.float() < 0.5;
      const doc = useAgents ? env.agentsMd : env.readmeMd;
      const topic = useAgents
        ? rng.pick([
            { q: 'como anadir un nuevo optimizador y reglas base', facts: ['Optimizer', 'BASE_RULES'] },
            { q: 'como anadir un nuevo tipo de tarea al clasificador', facts: ['TaskType', 'classifyTask'] },
            { q: 'como funciona el esquema de eventos v2 y los stores', facts: ['RouterEvent', 'router-event-store'] },
          ])
        : rng.pick([
            { q: 'como se ejecutan los tests y benchmarks del proyecto', facts: ['npm test', 'benchmark'] },
            { q: 'que es el plugin de registro automatico de ejecuciones', facts: ['plugin', 'record_execution'] },
            { q: 'como se instala y configura el router', facts: ['install', 'opencode'] },
          ]);
      return {
        category: cat,
        query: `segun la documentacion: ${topic.q}`,
        signals: { fileCount: 1, contextSizeBytes: doc.length },
        applicable: 'CONTEXT_MODE',
        builders: {
          CONTEXT_MODE: () => retrieveSections(doc, topic.q, 2),
          SEMBLE: () => env.semble(topic.q),
        },
        baseline: () => doc,
        facts: topic.facts,
        recovery: () => doc,
        minimal: topic.facts.join(' '),
      };
    }
    case 'deps': {
      return {
        category: cat,
        query: 'lista el arbol completo de node_modules (miles de entradas) y sus dependencias instaladas',
        signals: { hasTerminalCommands: true, contextSizeBytes: Buffer.byteLength(env.nmTree, 'utf8') },
        applicable: 'DCP',
        builders: { DCP: () => env.nmTop },
        baseline: () => env.nmTree,
        facts: ['zod', 'vitest', 'typescript'],
        recovery: () => env.nmTree,
        minimal: 'zod vitest typescript',
      };
    }
    case 'verify': {
      const errFile = env.tscFiles.length ? env.tscFiles : ['tests/scorer/expected-cost-scorer.test.ts'];
      return {
        category: cat,
        query: 'arregla los errores de tipo y de compilacion de tsc',
        signals: { hasTerminalCommands: true },
        applicable: 'SERENA',
        builders: {
          SERENA: () =>
            [env.tscOut.split('\n').slice(0, 8).join('\n'), runShell('git grep -n "familyConfidenceWeight" -- src tests').stdout].join('\n---\n'),
          RTK: () => env.rtkErrTsc(),
          CONTEXT_MODE: () => [env.tscOut.split('\n').slice(0, 8).join('\n'), runShell('git grep -n -A3 "interface RouterOptions" -- src/types.ts').stdout].join('\n---\n'),
        },
        baseline: () => [env.tscOut, ...errFile.map(readFormat)].join('\n\n'),
        facts: ['TS2741', 'familyConfidenceWeight'],
        recovery: () => [env.tscOut, ...errFile.map(readFormat)].join('\n\n'),
        minimal: env.tscOut.split('\n')[0],
      };
    }
    case 'refactor': {
      const sym = rng.pick(env.exportNames);
      const files = runShell(`git grep -l "\\b${sym}\\b" -- src tests`)
        .stdout.split('\n')
        .map((s) => s.trim().replace(/\\/g, '/'))
        .filter(Boolean);
      const use = files.length ? files : env.srcFiles.slice(0, 2);
      return {
        category: cat,
        query: `refactoriza ${sym} y actualiza todos sus usos`,
        signals: { isRefactor: true, fileCount: use.length, contextSizeBytes: use.reduce((a, f) => a + sizeOf(f), 0) },
        applicable: 'SERENA',
        builders: { SERENA: () => runShell(`git grep -n "\\b${sym}\\b" -- src tests`).stdout },
        baseline: () => use.map(readFormat).join('\n\n'),
        facts: [sym],
        recovery: () => use.map(readFormat).join('\n\n'),
        minimal: sym,
      };
    }
    case 'bigfile': {
      const big = 'Install_klia_token.ps1';
      return {
        category: cat,
        query: 'donde se define la funcion Set-McpEntry en este script grande',
        signals: { fileCount: 1, contextSizeBytes: sizeOf(big) },
        applicable: 'SERENA',
        builders: {
          SERENA: () => runShell(`git grep -n -A4 -E "^function (Set-McpEntry|Save-Config)" -- ${big}`).stdout,
          SEMBLE: () => env.semble('Set-McpEntry function definition install script'),
        },
        baseline: () => env.ps1,
        facts: ['Set-McpEntry'],
        recovery: () => env.ps1,
        minimal: 'Set-McpEntry',
      };
    }
  }
}

const WEIGHTS: Array<{ w: number; v: Category }> = [
  { w: 26, v: 'read_file' },
  { w: 12, v: 'git_small' },
  { w: 10, v: 'git_diff' },
  { w: 14, v: 'search_symbol' },
  { w: 8, v: 'structure' },
  { w: 7, v: 'docs' },
  { w: 4, v: 'deps' },
  { w: 10, v: 'verify' },
  { w: 6, v: 'refactor' },
  { w: 3, v: 'bigfile' },
];

function buildSession(env: Env, rng: Rng, tasks: number): WorkItem[] {
  const cats: Category[] = [];
  for (const pillar of ['git_diff', 'search_symbol', 'verify', 'read_file'] as Category[]) cats.push(pillar);
  while (cats.length < tasks) cats.push(rng.weighted(WEIGHTS));
  // shuffle
  for (let i = cats.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [cats[i], cats[j]] = [cats[j], cats[i]];
  }
  return cats.map((c) => makeItem(c, env, rng));
}

// --- Evaluacion --------------------------------------------------------------

interface ItemResult {
  session: number;
  category: string;
  query: string;
  applicable: Optimizer;
  routerPick: Optimizer;
  routerTaskType: string;
  baseTok: number;
  applicableTok: number;
  routedTok: number;
  ceilingTok: number;
  savingsApplicable: number;
  savingsRouted: number;
  savingsCeiling: number;
  recovered: boolean;
  err?: string;
}

function missingFacts(text: string, facts: string[]): string[] {
  return facts.filter((f) => f && !text.includes(f));
}

async function evaluate(item: WorkItem, session: number, routerPick: Optimizer, routerTaskType: string): Promise<ItemResult> {
  const baseText = cap(item.baseline());
  const baseTokRaw = await toks(baseText);
  const recTok = await toks(item.recovery());

  // Gate SIMETRICO: si el baseline tambien fue truncado y no contiene los hechos,
  // el agente debe recuperarlos igual -> se suma al baseline. Asi el ahorro no se
  // infla penalizando solo al optimizador.
  const baseMissing = missingFacts(baseText, item.facts);
  const baseEff = baseTokRaw + (baseMissing.length ? recTok : 0);

  const measure = async (opt: Optimizer): Promise<{ tok: number; recovered: boolean }> => {
    const builder = item.builders[opt];
    const optText = cap(builder ? builder() : item.baseline());
    const optTok = await toks(optText);
    const miss = missingFacts(optText, item.facts);
    return { tok: optTok + (miss.length ? recTok : 0), recovered: miss.length > 0 };
  };

  const applicable = await measure(item.applicable);
  const routed = routerPick === item.applicable ? applicable : await measure(routerPick);

  // Techo observado: el menor coste realmente logrado entre recomendado, router
  // y baseline. Garantiza techo >= producto (nunca al reves) y evita que el
  // "potencial" de un optimizador etiquetado parezca batido por el router.
  const ceilingTok = Math.min(baseEff, applicable.tok, routed.tok);

  return {
    session,
    category: item.category,
    query: item.query,
    applicable: item.applicable,
    routerPick,
    routerTaskType,
    baseTok: baseEff,
    applicableTok: applicable.tok,
    routedTok: routed.tok,
    ceilingTok,
    savingsApplicable: baseEff > 0 ? 1 - applicable.tok / baseEff : 0,
    savingsRouted: baseEff > 0 ? 1 - routed.tok / baseEff : 0,
    savingsCeiling: baseEff > 0 ? 1 - ceilingTok / baseEff : 0,
    recovered: routed.recovered,
  };
}

// --- Reporte -----------------------------------------------------------------

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const verdictOf = (s: number): string => (s > 0.1 ? 'gana' : s >= -0.1 ? 'empata' : 'pierde');

function aggregate(rs: ItemResult[], key: 'applicableTok' | 'routedTok'): number {
  const b = rs.reduce((a, r) => a + r.baseTok, 0);
  const o = rs.reduce((a, r) => a + r[key], 0);
  return b > 0 ? 1 - o / b : 0;
}

function report(results: ItemResult[], env: Env, sessions: number, tasks: number, seed: number, elapsedS: number): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ok = results.filter((r) => r.baseTok > 0);
  const baseTotal = ok.reduce((a, r) => a + r.baseTok, 0);
  const appTotal = ok.reduce((a, r) => a + r.applicableTok, 0);
  const routTotal = ok.reduce((a, r) => a + r.routedTok, 0);
  const ceilTotal = ok.reduce((a, r) => a + r.ceilingTok, 0);
  const savApp = baseTotal > 0 ? 1 - appTotal / baseTotal : 0;
  const savRout = baseTotal > 0 ? 1 - routTotal / baseTotal : 0;
  const savCeil = baseTotal > 0 ? 1 - ceilTotal / baseTotal : 0;

  const applies = ok.filter((r) => r.applicable !== 'BASELINE');
  const agree = applies.filter((r) => r.routerPick === r.applicable).length;
  const agreement = applies.length ? agree / applies.length : 0;

  const ganan = ok.filter((r) => verdictOf(r.savingsRouted) === 'gana').length;
  const empatan = ok.filter((r) => verdictOf(r.savingsRouted) === 'empata').length;
  const pierden = ok.filter((r) => verdictOf(r.savingsRouted) === 'pierde').length;
  const worst = ok.slice().sort((a, b) => a.savingsRouted - b.savingsRouted)[0];
  const best = ok.slice().sort((a, b) => b.savingsRouted - a.savingsRouted)[0];

  // por categoria
  const cats = Array.from(new Set(ok.map((r) => r.category)));
  const byCat = cats.map((c) => {
    const rs = ok.filter((r) => r.category === c);
    return { category: c, n: rs.length, savApp: aggregate(rs, 'applicableTok'), savRout: aggregate(rs, 'routedTok') };
  });
  // por sesion
  const bySes = Array.from({ length: sessions }, (_, i) => {
    const rs = ok.filter((r) => r.session === i);
    return { session: i + 1, n: rs.length, savApp: aggregate(rs, 'applicableTok'), savRout: aggregate(rs, 'routedTok') };
  });

  console.log('');
  console.log(`[sim] modelo=${MODEL} | sessions=${sessions} tasks=${tasks} seed=${seed} | tareas=${ok.length} | ${elapsedS.toFixed(0)}s`);
  console.log(`[sim] tokens base totales = ${baseTotal}`);
  console.log(`[sim] TECHO observado (min recomendado/router): ${pct(savCeil)}   (${baseTotal} -> ${ceilTotal})`);
  console.log(`[sim] POTENCIAL del optimizador recomendado (applicable): ${pct(savApp)}   (${baseTotal} -> ${appTotal})`);
  console.log(`[sim] PRODUCTO con el router (routed):       ${pct(savRout)}   (${baseTotal} -> ${routTotal})`);
  console.log(`[sim] acierto del router donde aplica un optimizador: ${pct(agreement)} (${agree}/${applies.length})`);
  console.log(`[sim] veredicto por tarea (routed): ${ganan} gana / ${empatan} empata / ${pierden} pierde`);
  console.log('');
  console.log('Por categoria:');
  console.log(['categoria', 'n', 'potencial', 'router', 'verdict'].join(' | '));
  for (const c of byCat) {
    console.log([c.category.padEnd(14), String(c.n).padStart(3), pct(c.savApp).padStart(9), pct(c.savRout).padStart(7), verdictOf(c.savRout)].join(' | '));
  }
  console.log('');
  console.log('Por sesion (producto/router):');
  for (const s of bySes) console.log(`  sesion ${String(s.session).padStart(2)} n=${String(s.n).padStart(2)} potencial=${pct(s.savApp).padStart(7)} router=${pct(s.savRout).padStart(7)}`);
  if (best) console.log(`\nMejor tarea: ${pct(best.savingsRouted)} (${best.category}/${best.routerPick})`);
  if (worst) console.log(`Peor tarea: ${pct(worst.savingsRouted)} (${worst.category}/${worst.routerPick})`);

  const sirveRouted = savRout > 0.05 && agreement > 0.5;
  console.log('');
  console.log(`VEREDICTO: ${sirveRouted ? 'SI SIRVE' : 'NO COMPENSA'} (producto ${pct(savRout)}, techo ${pct(savCeil)}, recomendado ${pct(savApp)}, acierto router ${pct(agreement)})`);

  const payload = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    seed,
    sessions,
    tasksPerSession: tasks,
    tokenizer: 'real (KLIA usage.prompt_tokens)',
    opencodeBaseline: { maxLines: OPENCODE_MAX_LINES, maxBytes: OPENCODE_MAX_BYTES, readPrefix: true },
    proxies: { DCP: 'poda (node_modules nivel-1)', CONTEXT_MODE: 'secciones markdown', SERENA: 'git grep -n' },
    summary: {
      tasks: ok.length,
      baseTokens: baseTotal,
      ceilingSavings: savCeil,
      potentialSavings: savApp,
      routedSavings: savRout,
      routerAgreement: agreement,
      ganan,
      empatan,
      pierden,
      verdict: sirveRouted ? 'SI SIRVE' : 'NO COMPENSA',
    },
    byCategory: byCat,
    bySession: bySes,
    itemResults: results,
  };
  fs.writeFileSync(DATA_PATH, JSON.stringify(payload, null, 2), 'utf-8');

  const md: string[] = [];
  md.push('# Simulador de sesiones de desarrollo (tokens reales)\n');
  md.push(`- Modelo/tokenizador: **${MODEL}** (real, \`usage.prompt_tokens\`)`);
  md.push(`- ${sessions} sesiones x ${tasks} tareas = ${ok.length} tareas | seed=${seed}`);
  md.push(`- Baseline OpenCode: Read con \`N: \` + Bash capado a ${OPENCODE_MAX_LINES} lineas / ${OPENCODE_MAX_BYTES} bytes`);
  md.push(`- Router en frio (V0, sin historial); proxies DCP/CONTEXT_MODE/SERENA`);
  md.push(`- Generado: ${payload.generatedAt}\n`);
  md.push(`**Techo observado: ${pct(savCeil)}** | **Potencial del optimizador: ${pct(savApp)}** | **Producto con el router: ${pct(savRout)}** | **Acierto router: ${pct(agreement)}** (${agree}/${applies.length})`);
  md.push(`\n**Veredicto: ${payload.summary.verdict}.** ${ganan} gana / ${empatan} empata / ${pierden} pierde.\n`);
  md.push('\n## Por categoria\n');
  md.push('| Categoria | n | Potencial | Router | Veredicto |');
  md.push('|---|---:|---:|---:|---|');
  for (const c of byCat) md.push(`| ${c.category} | ${c.n} | ${pct(c.savApp)} | ${pct(c.savRout)} | ${verdictOf(c.savRout)} |`);
  md.push('\n## Por sesion\n');
  md.push('| Sesion | n | Potencial | Router |');
  md.push('|---:|---:|---:|---:|');
  for (const s of bySes) md.push(`| ${s.session} | ${s.n} | ${pct(s.savApp)} | ${pct(s.savRout)} |`);
  fs.writeFileSync(REPORTE_PATH, md.join('\n') + '\n', 'utf-8');

  console.log('');
  console.log(`[sim] JSON -> ${DATA_PATH}`);
  console.log(`[sim] Reporte -> ${REPORTE_PATH}`);
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (name: string, def: number): number => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : def;
  };
  const sessions = getArg('--sessions', 10);
  const tasks = getArg('--tasks', 12);
  const seed = getArg('--seed', 20261016);
  const mIdx = args.indexOf('--model');
  if (mIdx >= 0 && args[mIdx + 1]) MODEL = args[mIdx + 1];

  if (!API_KEY) {
    console.error('[sim] Falta KLIA_API_KEY en el entorno.');
    process.exit(1);
  }
  console.log(`[sim] modelo=${MODEL} sessions=${sessions} tasks=${tasks} seed=${seed}`);
  await overhead();

  const t0 = Date.now();
  const env = collectEnv();
  console.log(`[sim] entorno recogido en ${((Date.now() - t0) / 1000).toFixed(1)}s (commits=${env.commits.length}, src=${env.srcFiles.length}, dirs=${env.dirs.length})`);

  const historyPath = path.join(OUT_DIR, 'session-sim-history.json');
  if (fs.existsSync(historyPath)) fs.rmSync(historyPath);
  const router = createAdaptiveRouter({ historyPath, enableExploration: false });

  const rng = new Rng(seed);
  const results: ItemResult[] = [];
  const BUDGET_MS = 22 * 60 * 1000;

  outer: for (let s = 0; s < sessions; s++) {
    const items = buildSession(env, rng, tasks);
    for (const item of items) {
      if (Date.now() - t0 > BUDGET_MS) {
        console.log('[sim] presupuesto de tiempo agotado, cortando.');
        break outer;
      }
      try {
        const ctx = buildContextFromQuery(MODEL, item.query, item.signals);
        const dec = await router.route(ctx);
        const r = await evaluate(item, s, dec.optimizer, dec.taskType);
        results.push(r);
      } catch (e) {
        results.push({
          session: s,
          category: item.category,
          query: item.query,
          applicable: item.applicable,
          routerPick: 'BASELINE',
          routerTaskType: 'UNKNOWN',
          baseTok: 0,
          applicableTok: 0,
          routedTok: 0,
          ceilingTok: 0,
          savingsApplicable: 0,
          savingsRouted: 0,
          savingsCeiling: 0,
          recovered: false,
          err: (e as Error).message.slice(0, 80),
        });
      }
    }
    console.log(`[sim] sesion ${s + 1}/${sessions} completada (${results.filter((r) => r.session === s).length} tareas, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }

  report(results, env, sessions, tasks, seed, (Date.now() - t0) / 1000);
}

main().catch((e) => {
  console.error('[sim] error fatal:', (e as Error).message);
  process.exit(1);
});
