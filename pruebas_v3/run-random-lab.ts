#!/usr/bin/env node
/**
 * run-random-lab.ts - Pruebas ALEATORIAS de "programador tipico" sobre OTRO proyecto.
 *
 * A diferencia de run-session-sim (que simula sesiones sobre el propio repo del
 * router), este benchmark apunta a un proyecto EXTERNO y PYTHON (por defecto
 * C:\ProyectosV2\telemetria\opencode-benchmark-lab: una app FastAPI).
 *
 * Que hace:
 *  - Genera tareas TOTALMENTE ALEATORIAS (semilla configurable) de un pool de
 *    busquedas tipicas de programador: abrir ficheros, buscar simbolos, entender
 *    modulos, consultar docs/frontend, ver dependencias, navegar ficheros grandes.
 *  - Para CADA tarea mide DOS artefactos con tokens REALES de KLIA:
 *      1) BASELINE  = lo que OpenCode inyecta crudo (Read con prefijo "N:",
 *         Bash capado a 2000 lineas / 51200 bytes).
 *      2) OPTIMIZER = la salida del optimizador que el ROUTER REAL elige
 *         (createAdaptiveRouter(...).route(ctx), en frio V0).
 *  - Gate de cobertura + recuperacion SIMETRICA (si el baseline tambien esta
 *    truncado, paga la recuperacion) para no inflar el ahorro.
 *  - Corre durante un presupuesto de ~25 min (por defecto), acumulando tareas.
 *
 * Honestidad: DCP / CONTEXT_MODE / SERENA no tienen CLI; se modelan de forma
 * determinista (poda de uv.lock, recuperacion de secciones HTML, grep de lineas)
 * y se marcan como proxy.
 *
 * Uso:
 *   npx tsx pruebas_v3/run-random-lab.ts [--minutes 25] [--seed N]
 *       [--project C:\ruta\al\proyecto] [--model GLM-5.2]
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { buildContextFromQuery, createAdaptiveRouter } from '../src/index';
import type { Optimizer, TaskSignals } from '../src/types';

const OPT_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'resultados');
const DATA_PATH = path.join(OUT_DIR, 'resultados-random-lab.json');
const REPORTE_PATH = path.join(OUT_DIR, 'reporte-random-lab.md');
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

// --- Shell / formato OpenCode ------------------------------------------------

function runShell(command: string, cwd: string, timeoutMs = TIMEOUT_MS): string {
  const res = spawnSync(command, {
    cwd,
    encoding: 'utf-8',
    shell: true,
    maxBuffer: 128 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return (res.stdout || '').toString() + (res.stderr || '').toString();
}

function cap(text: string): string {
  const raw = text ?? '';
  const lines = raw.split('\n');
  if (lines.length <= OPENCODE_MAX_LINES && Buffer.byteLength(raw, 'utf-8') <= OPENCODE_MAX_BYTES)
    return raw;
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

function readFormat(abs: string): string {
  try {
    return fs
      .readFileSync(abs, 'utf-8')
      .split('\n')
      .map((l, i) => `${i + 1}: ${l}`)
      .join('\n');
  } catch {
    return '';
  }
}

// --- Secciones (HTML o Markdown) ---------------------------------------------

interface Section {
  title: string;
  body: string;
}

function sectionsOf(text: string): Section[] {
  const out: Section[] = [];
  if (/<h[1-4][\s>]/i.test(text)) {
    let cur: Section = { title: '(inicio)', body: '' };
    const parts = text.split(/(<h[1-4][^>]*>[\s\S]*?<\/h[1-4]>)/i);
    for (const p of parts) {
      const m = p.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i);
      if (m) {
        if (cur.body || cur.title !== '(inicio)') out.push(cur);
        cur = { title: m[1].replace(/<[^>]+>/g, '').trim(), body: '' };
      } else cur.body += p;
    }
    out.push(cur);
    return out;
  }
  let cur: Section = { title: '(preambulo)', body: '' };
  for (const line of text.split('\n')) {
    if (/^#{1,4}\s+/.test(line)) {
      if (cur.body || cur.title !== '(preambulo)') out.push(cur);
      cur = { title: line, body: '' };
    } else cur.body += line + '\n';
  }
  out.push(cur);
  return out;
}

function retrieveSections(text: string, query: string, top = 2): string {
  const terms = Array.from(new Set(query.toLowerCase().match(/[a-z0-9_]{3,}/g) || []));
  const scored = sectionsOf(text).map((s) => {
    const hay = (s.title + '\n' + s.body).toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += 1;
    return { ...s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const chosen = scored.filter((s) => s.score > 0).slice(0, top);
  const use = chosen.length ? chosen : scored.slice(0, top);
  return use
    .map((s) => `${s.title}\n${s.body}`)
    .join('\n\n')
    .trim();
}

// --- Conteo de tokens REAL ---------------------------------------------------

// Sin cache: cada medicion es una llamada REAL a la API. Asi el benchmark
// consume tiempo real de verdad (no repite miles de tareas instantaneas) y las
// cifras no dependen de un cache interno.
async function countTokensRaw(text: string): Promise<number> {
  const body = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: text }],
    max_tokens: 1,
  });
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

// --- Entorno del proyecto externo --------------------------------------------

interface LabEnv {
  root: string;
  pyFiles: string[];
  fileText: Map<string, string>;
  symbols: string[];
  symbolFiles: Map<string, string[]>;
  packages: string[];
  pkgFiles: Map<string, string[]>;
  pkgSymbols: Map<string, string[]>;
  bigFiles: string[];
  fileSymbols: Map<string, string[]>;
  uvLock: string;
  prunedDeps: string;
  depNames: string[];
  html: string;
  htmlSections: Section[];
  semble: (q: string) => string;
  repomix: (relDir: string) => string;
}

function sizesOf(env: LabEnv, files: string[]): number {
  return files.reduce((a, f) => a + (env.fileText.get(f)?.length ?? 0), 0);
}

function collectEnv(root: string): LabEnv {
  const srcRoot = path.join(root, 'src');
  const pyFiles: string[] = [];
  const rel = (p: string): string => path.relative(root, p).replace(/\\/g, '/');
  const walk = (d: string): void => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name === '__pycache__') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.py')) pyFiles.push(rel(p));
    }
  };
  walk(srcRoot);
  pyFiles.sort();

  const fileText = new Map<string, string>();
  for (const f of pyFiles) fileText.set(f, fs.readFileSync(path.join(root, f), 'utf-8'));

  const symbols: string[] = [];
  const fileSymbols = new Map<string, string[]>();
  for (const f of pyFiles) {
    const text = fileText.get(f)!;
    const names = [...text.matchAll(/^(?:class|def|async def)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map(
      (m) => m[1],
    );
    fileSymbols.set(f, names);
    for (const n of names) if (!symbols.includes(n)) symbols.push(n);
  }

  const symbolFiles = new Map<string, string[]>();
  for (const sym of symbols) {
    const re = new RegExp(`\\b${sym}\\b`);
    const hits = pyFiles.filter((f) => re.test(fileText.get(f)!));
    if (hits.length) symbolFiles.set(sym, hits);
  }

  const pkgFiles = new Map<string, string[]>();
  for (const f of pyFiles) {
    const dir = path.posix.dirname(f);
    if (!pkgFiles.has(dir)) pkgFiles.set(dir, []);
    pkgFiles.get(dir)!.push(f);
  }
  const packages = [...pkgFiles.keys()].sort();
  const pkgSymbols = new Map<string, string[]>();
  for (const [dir, files] of pkgFiles) {
    const syms = files.flatMap((f) => fileSymbols.get(f) ?? []);
    pkgSymbols.set(dir, syms);
  }

  const bigFiles = pyFiles.filter((f) => (fileText.get(f)?.length ?? 0) > 7000);

  const uvLock = fs.readFileSync(path.join(root, 'uv.lock'), 'utf-8');
  const depNames: string[] = [];
  const pruned: string[] = [];
  for (const m of uvLock.matchAll(
    /\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g,
  )) {
    depNames.push(m[1]);
    pruned.push(`${m[1]} == ${m[2]}`);
  }

  const html = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf-8');

  const sembleCache = new Map<string, string>();
  const repomixCache = new Map<string, string>();

  return {
    root,
    pyFiles,
    fileText,
    symbols,
    symbolFiles,
    packages,
    pkgFiles,
    pkgSymbols,
    bigFiles,
    fileSymbols,
    uvLock,
    prunedDeps: pruned.join('\n'),
    depNames,
    html,
    htmlSections: sectionsOf(html),
    semble: (q: string) => {
      if (!sembleCache.has(q)) {
        sembleCache.set(
          q,
          runShell(`semble search "${q.replace(/"/g, '')}" "${root}" --max-snippet-lines 10 --top-k 5`, OPT_ROOT),
        );
      }
      return sembleCache.get(q)!;
    },
    repomix: (relDir: string) => {
      if (!repomixCache.has(relDir)) {
        repomixCache.set(
          relDir,
          runShell(`npx -y repomix "${path.join(root, relDir)}" --compress --stdout`, OPT_ROOT, 180_000),
        );
      }
      return repomixCache.get(relDir)!;
    },
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
  | 'search_symbol'
  | 'structure'
  | 'docs'
  | 'deps'
  | 'bigfile';

const READ_TEMPLATES = (b: string): string[] => [
  `abre y revisa el fichero ${b}`,
  `que hace el fichero ${b}?`,
  `revisa ${b} y dime su responsabilidad`,
];
const SEARCH_TEMPLATES = (s: string): string[] => [
  `donde se define y usa ${s} en el codigo`,
  `busca todas las referencias a ${s}`,
  `quien llama a ${s}?`,
];
const STRUCT_TEMPLATES = (n: string): string[] => [
  `dame la estructura y las firmas del modulo ${n}`,
  `resume la arquitectura del paquete ${n}`,
  `explicame los modulos y clases de ${n}`,
];

function makeItem(env: LabEnv, rng: Rng, cat: Category): WorkItem {
  switch (cat) {
    case 'read_file': {
      const f = rng.pick(env.pyFiles);
      const b = path.posix.basename(f);
      const query = rng.pick(READ_TEMPLATES(b));
      return {
        category: cat,
        query,
        signals: { fileCount: 1, contextSizeBytes: env.fileText.get(f)!.length },
        applicable: 'BASELINE',
        builders: {},
        baseline: () => readFormat(path.join(env.root, f)),
        facts: [],
        recovery: () => readFormat(path.join(env.root, f)),
        minimal: b,
      };
    }
    case 'search_symbol': {
      const sym = rng.pick(env.symbols);
      const files = env.symbolFiles.get(sym) ?? [];
      const query = rng.pick(SEARCH_TEMPLATES(sym));
      return {
        category: cat,
        query,
        signals: {
          isRepositorySearch: true,
          fileCount: files.length,
          contextSizeBytes: sizesOf(env, files),
        },
        applicable: 'SEMBLE',
        builders: { SEMBLE: () => env.semble(`where is ${sym} defined and used`) },
        baseline: () => files.map((f) => readFormat(path.join(env.root, f))).join('\n\n'),
        facts: [sym],
        recovery: () => files.map((f) => readFormat(path.join(env.root, f))).join('\n\n'),
        minimal: sym,
      };
    }
    case 'structure': {
      const dir = rng.pick(env.packages);
      const files = env.pkgFiles.get(dir)!;
      const name = path.posix.basename(dir);
      const syms = env.pkgSymbols.get(dir) ?? [];
      const facts = syms.slice(0, 3);
      const query = rng.pick(STRUCT_TEMPLATES(name));
      return {
        category: cat,
        query,
        signals: { fileCount: files.length, contextSizeBytes: sizesOf(env, files) },
        applicable: 'REPOMIX',
        builders: {
          REPOMIX: () => env.repomix(dir),
          SEMBLE: () => env.semble(`structure and signatures of the ${name} module`),
        },
        baseline: () => files.map((f) => readFormat(path.join(env.root, f))).join('\n\n'),
        facts,
        recovery: () => files.map((f) => readFormat(path.join(env.root, f))).join('\n\n'),
        minimal: facts.join(' '),
      };
    }
    case 'docs': {
      const secTitle = rng.pick(
        [...env.htmlSections.filter((s) => s.title && s.title !== '(inicio)').map((s) => s.title)],
      );
      const query = `segun el frontend, explicame la seccion "${secTitle}" del dashboard`;
      return {
        category: cat,
        query,
        signals: { fileCount: 1, contextSizeBytes: env.html.length },
        applicable: 'CONTEXT_MODE',
        builders: {
          CONTEXT_MODE: () => retrieveSections(env.html, secTitle, 2),
          SEMBLE: () => env.semble(query),
        },
        baseline: () => env.html,
        facts: [secTitle],
        recovery: () => env.html,
        minimal: secTitle,
      };
    }
    case 'deps': {
      return {
        category: cat,
        query: `cat uv.lock y lista todas las dependencias instaladas con su version (miles de lineas)`,
        signals: { hasTerminalCommands: true, contextSizeBytes: env.uvLock.length },
        applicable: 'DCP',
        builders: { DCP: () => env.prunedDeps },
        baseline: () => env.uvLock,
        facts: ['fastapi', 'uvicorn', 'httpx', 'pydantic', 'pytest'],
        recovery: () => env.uvLock,
        minimal: 'fastapi uvicorn httpx pydantic pytest',
      };
    }
    case 'bigfile': {
      const big = rng.pick(env.bigFiles.length ? env.bigFiles : env.pyFiles);
      const b = path.posix.basename(big);
      const syms = env.fileSymbols.get(big) ?? [];
      const sym = syms.length ? rng.pick(syms) : rng.pick(env.symbols);
      const text = env.fileText.get(big)!;
      const grep = text
        .split('\n')
        .map((l, i) => (new RegExp(`\\b${sym}\\b`).test(l) ? `${i + 1}: ${l}` : null))
        .filter((x): x is string => x !== null)
        .join('\n');
      return {
        category: cat,
        query: `navega el fichero grande ${b} y dime en que linea se define ${sym}`,
        signals: { fileCount: 1, contextSizeBytes: text.length },
        applicable: 'SERENA',
        builders: {
          SERENA: () => grep,
          SEMBLE: () => env.semble(`where is ${sym} defined in ${b}`),
        },
        baseline: () => readFormat(path.join(env.root, big)),
        facts: [sym],
        recovery: () => readFormat(path.join(env.root, big)),
        minimal: sym,
      };
    }
  }
}

// --- Evaluacion --------------------------------------------------------------

interface ItemResult {
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

async function evaluate(
  item: WorkItem,
  routerPick: Optimizer,
  routerTaskType: string,
): Promise<ItemResult> {
  // 1) BASELINE primero (lo que inyecta OpenCode crudo).
  const baseText = cap(item.baseline());
  const baseTokRaw = await toks(baseText);
  const recTok = await toks(item.recovery());

  // Gate SIMETRICO: si el baseline tambien fue truncado y pierde hechos, paga recuperacion.
  const baseMissing = missingFacts(baseText, item.facts);
  const baseEff = baseTokRaw + (baseMissing.length ? recTok : 0);

  const measure = async (opt: Optimizer): Promise<{ tok: number; recovered: boolean }> => {
    const builder = item.builders[opt];
    const optText = cap(builder ? builder() : item.baseline());
    const optTok = await toks(optText);
    const miss = missingFacts(optText, item.facts);
    return { tok: optTok + (miss.length ? recTok : 0), recovered: miss.length > 0 };
  };

  // 2) OPTIMIZER (el que elige el router).
  const applicable = await measure(item.applicable);
  const routed = routerPick === item.applicable ? applicable : await measure(routerPick);
  const ceilingTok = Math.min(baseEff, applicable.tok, routed.tok);

  return {
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

function report(
  results: ItemResult[],
  env: LabEnv,
  seed: number,
  minutes: number,
  elapsedS: number,
): void {
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
  // "Acierto util": el router logra un ahorro dentro de 5 pts del recomendado
  // (aunque elija otro optimizador distinto con igual o mejor resultado).
  const agree = applies.filter((r) => r.savingsRouted >= r.savingsApplicable - 0.05).length;
  const agreement = applies.length ? agree / applies.length : 0;

  const ganan = ok.filter((r) => verdictOf(r.savingsRouted) === 'gana').length;
  const empatan = ok.filter((r) => verdictOf(r.savingsRouted) === 'empata').length;
  const pierden = ok.filter((r) => verdictOf(r.savingsRouted) === 'pierde').length;
  const worst = ok.slice().sort((a, b) => a.savingsRouted - b.savingsRouted)[0];
  const best = ok.slice().sort((a, b) => b.savingsRouted - a.savingsRouted)[0];

  const cats = Array.from(new Set(ok.map((r) => r.category)));
  const byCat = cats.map((c) => {
    const rs = ok.filter((r) => r.category === c);
    return {
      category: c,
      n: rs.length,
      savApp: aggregate(rs, 'applicableTok'),
      savRout: aggregate(rs, 'routedTok'),
    };
  });

  // El veredicto depende del RESULTADO (producto), no de que el router elija
  // exactamente la etiqueta "recomendada": basta con ahorrar y no destruir tareas.
  const sirveRouted = savRout > 0.1 && pierden / Math.max(1, ok.length) < 0.25;

  console.log('');
  console.log(
    `[lab] proyecto=${env.root} | modelo=${MODEL} | seed=${seed} | tareas=${ok.length} | ${elapsedS.toFixed(0)}s`,
  );
  console.log(`[lab] tokens base totales = ${baseTotal}`);
  console.log(`[lab] TECHO observado (min recomendado/router): ${pct(savCeil)}   (${baseTotal} -> ${ceilTotal})`);
  console.log(`[lab] POTENCIAL recomendado (applicable): ${pct(savApp)}   (${baseTotal} -> ${appTotal})`);
  console.log(`[lab] PRODUCTO con el router (routed):   ${pct(savRout)}   (${baseTotal} -> ${routTotal})`);
  console.log(`[lab] acierto util del router (ahorro >= recomendado -5pts): ${pct(agreement)} (${agree}/${applies.length})`);
  console.log(`[lab] veredicto por tarea (routed): ${ganan} gana / ${empatan} empata / ${pierden} pierde`);
  console.log('');
  console.log('Por categoria:');
  console.log(['categoria', 'n', 'potencial', 'router', 'verdict'].join(' | '));
  for (const c of byCat) {
    console.log(
      [
        c.category.padEnd(14),
        String(c.n).padStart(3),
        pct(c.savApp).padStart(9),
        pct(c.savRout).padStart(7),
        verdictOf(c.savRout),
      ].join(' | '),
    );
  }
  if (best) console.log(`\nMejor tarea: ${pct(best.savingsRouted)} (${best.category}/${best.routerPick})`);
  if (worst) console.log(`Peor tarea: ${pct(worst.savingsRouted)} (${worst.category}/${worst.routerPick})`);
  console.log('');
  console.log(
    `VEREDICTO: ${sirveRouted ? 'SI SIRVE' : 'NO COMPENSA'} (producto ${pct(savRout)}, techo ${pct(savCeil)}, recomendado ${pct(savApp)}, acierto router ${pct(agreement)})`,
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    project: env.root,
    model: MODEL,
    seed,
    minutesBudget: minutes,
    elapsedSeconds: Math.round(elapsedS),
    tokenizer: 'real (KLIA usage.prompt_tokens)',
    opencodeBaseline: { maxLines: OPENCODE_MAX_LINES, maxBytes: OPENCODE_MAX_BYTES, readPrefix: true },
    proxies: {
      DCP: 'poda de uv.lock (name == version)',
      CONTEXT_MODE: 'secciones HTML',
      SERENA: 'grep -n de lineas',
      REPOMIX: 'npx repomix --compress',
      SEMBLE: 'semble search',
    },
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
    itemResults: results,
  };
  fs.writeFileSync(DATA_PATH, JSON.stringify(payload, null, 2), 'utf-8');

  const md: string[] = [];
  md.push('# Pruebas aleatorias sobre un proyecto externo (tokens reales)\n');
  md.push(`- Proyecto: \`${env.root}\` (Python / FastAPI)`);
  md.push(`- Modelo/tokenizador: **${MODEL}** (real, \`usage.prompt_tokens\`)`);
  md.push(`- Presupuesto: ~${minutes} min | duracion real: ${Math.round(elapsedS)}s | seed=${seed}`);
  md.push(`- ${ok.length} tareas aleatorias; por tarea: PRIMERO baseline, LUEGO optimizador del router`);
  md.push(`- Baseline OpenCode: Read con \`N: \` + Bash capado a ${OPENCODE_MAX_LINES} lineas / ${OPENCODE_MAX_BYTES} bytes`);
  md.push(`- Router en frio (V0, sin historial); proxies DCP/CONTEXT_MODE/SERENA/REPOMIX/SEMBLE`);
  md.push(`- Generado: ${payload.generatedAt}\n`);
  md.push(`**Techo observado: ${pct(savCeil)}** | **Recomendado: ${pct(savApp)}** | **Producto con el router: ${pct(savRout)}** | **Acierto util router: ${pct(agreement)}** (${agree}/${applies.length})`);
  md.push(`\n**Veredicto: ${payload.summary.verdict}.** ${ganan} gana / ${empatan} empata / ${pierden} pierde.\n`);
  md.push('\n## Por categoria\n');
  md.push('| Categoria | n | Potencial | Router | Veredicto |');
  md.push('|---|---:|---:|---:|---|');
  for (const c of byCat)
    md.push(`| ${c.category} | ${c.n} | ${pct(c.savApp)} | ${pct(c.savRout)} | ${verdictOf(c.savRout)} |`);
  fs.writeFileSync(REPORTE_PATH, md.join('\n') + '\n', 'utf-8');

  console.log('');
  console.log(`[lab] JSON -> ${DATA_PATH}`);
  console.log(`[lab] Reporte -> ${REPORTE_PATH}`);
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const numArg = (name: string, def: number): number => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : def;
  };
  const minutes = numArg('--minutes', 25);
  const seed = numArg('--seed', Date.now() % 1_000_000_000);
  const pIdx = args.indexOf('--project');
  const project =
    (pIdx >= 0 && args[pIdx + 1]) || process.env.LAB_PROJECT || 'C:\\ProyectosV2\\telemetria\\opencode-benchmark-lab';
  const mIdx = args.indexOf('--model');
  if (mIdx >= 0 && args[mIdx + 1]) MODEL = args[mIdx + 1];

  if (!API_KEY) {
    console.error('[lab] Falta KLIA_API_KEY en el entorno.');
    process.exit(1);
  }
  if (!fs.existsSync(project)) {
    console.error(`[lab] Proyecto no encontrado: ${project}`);
    process.exit(1);
  }

  console.log(`[lab] proyecto=${project} modelo=${MODEL} minutes=${minutes} seed=${seed}`);
  await overhead();

  const t0 = Date.now();
  const env = collectEnv(project);
  console.log(
    `[lab] entorno: ${env.pyFiles.length} ficheros py, ${env.symbols.length} simbolos, ${env.packages.length} paquetes, ${env.depNames.length} deps, ${env.htmlSections.length} secciones html`,
  );

  const historyPath = path.join(OUT_DIR, 'random-lab-history.json');
  if (fs.existsSync(historyPath)) fs.rmSync(historyPath);
  const router = createAdaptiveRouter({ historyPath, enableExploration: false });

  const rng = new Rng(seed);
  const results: ItemResult[] = [];
  const BUDGET_MS = Math.max(60_000, minutes * 60 * 1000 - 60_000);
  const maxTasks = numArg('--max-tasks', 5000);

  let n = 0;
  while (Date.now() - t0 < BUDGET_MS && n < maxTasks) {
    const cat = rng.weighted<Category>([
      { w: 5, v: 'read_file' },
      { w: 7, v: 'search_symbol' },
      { w: 6, v: 'structure' },
      { w: 4, v: 'docs' },
      { w: 4, v: 'deps' },
      { w: 4, v: 'bigfile' },
    ]);
    const item = makeItem(env, rng, cat);
    try {
      const ctx = buildContextFromQuery(MODEL, item.query, item.signals);
      const dec = await router.route(ctx);
      results.push(await evaluate(item, dec.optimizer, dec.taskType));
    } catch (e) {
      results.push({
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
    n++;
    if (n % 50 === 0) {
      console.log(`[lab] ${n} tareas (${((Date.now() - t0) / 1000).toFixed(0)}s) ultima=${item.category}`);
    }
  }
  console.log(`[lab] fin: ${n} tareas en ${((Date.now() - t0) / 1000).toFixed(0)}s.`);

  report(results, env, seed, minutes, (Date.now() - t0) / 1000);
}

main().catch((e) => {
  console.error('[lab] error fatal:', (e as Error).message);
  process.exit(1);
});
