#!/usr/bin/env node
/**
 * run-benchmark-diverse.ts - Benchmark DIVERSO con conteo de tokens REAL.
 *
 * Objetivo: cubrir TODO el espacio del router con artefactos reales.
 *   - 7 tipos de tarea: SMALL_CODE, TERMINAL, LARGE_CONTEXT, REPOSITORY_SEARCH,
 *     MULTISTEP, REFACTOR, DEBUG.
 *   - 7 optimizadores: BASELINE, DCP, RTK, CONTEXT_MODE, REPOMIX, SEMBLE, SERENA.
 *
 * Mismo rigor que run-benchmark-max-real.ts:
 *   - Tokens REALES via KLIA `/v1/chat/completions` (usage.prompt_tokens).
 *   - Baseline = lo que OpenCode INYECTA: Read con prefijo "N: " y salida de
 *     Bash truncada a 2000 lineas / 51200 bytes.
 *   - Gate de cobertura SIMETRICO + coste de recuperacion (artefacto completo).
 *   - Techo teorico por escenario.
 *
 * Datos REALES usados: historial git, arbol de node_modules (5209 ficheros),
 * Install_klia_token.ps1 (138 KB), package-lock.json (116 KB), README/AGENTS,
 * y la salida REAL de `npx tsc --noEmit` (5 errores TS2741).
 *
 * NOTA de honestidad: DCP y CONTEXT_MODE no tienen CLI en este repo (son etiquetas
 * del router). Se modelan de forma determinista:
 *   - DCP: poda/deduplicacion (p.ej. colapsar node_modules a paquetes de nivel 1,
 *     o reducir un contexto multi-paso a firmas + hechos).
 *   - CONTEXT_MODE: recuperacion de las secciones relevantes de un documento
 *     largo (proxy del indice FTS5), en vez del documento completo.
 *
 * Uso: npx tsx pruebas_v3/run-benchmark-diverse.ts [--model GLM-5.2]
 * Limite: < 20 min en PC lento (comandos pesados: repomix ~13 s, semble ~6 s,
 * tsc ~4 s; el resto git/lectura local). Sin repeticiones.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import type { Optimizer, TaskType } from '../src/types';

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'resultados');
const DATA_PATH = path.join(OUT_DIR, 'resultados-diverse.json');
const REPORTE_PATH = path.join(OUT_DIR, 'reporte-diverse.md');
const TIMEOUT_MS = 120_000;

const API_BASE = process.env.KLIA_API_BASE || 'https://api.klia.tech/v1';
const API_KEY = process.env.KLIA_API_KEY || '';
const MODEL = process.env.KLIA_BENCH_MODEL || 'GLM-5.2';

const OPENCODE_MAX_LINES = 2000;
const OPENCODE_MAX_BYTES = 51200;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ShellResult {
  stdout: string;
  ok: boolean;
  timedOut: boolean;
  durationMs: number;
}

function runShell(command: string, timeoutMs = TIMEOUT_MS): ShellResult {
  const start = Date.now();
  const res = spawnSync(command, {
    cwd: ROOT,
    encoding: 'utf-8',
    shell: true,
    maxBuffer: 128 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const stdout = (res.stdout || '').toString();
  return {
    stdout,
    ok: !res.error && res.status === 0,
    timedOut: !!(res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'),
    durationMs: Date.now() - start,
  };
}

function opencodeCap(text: string): { text: string; lines: number; bytes: number; truncated: boolean } {
  const raw = text ?? '';
  const rawLines = raw.split('\n');
  const rawBytes = Buffer.byteLength(raw, 'utf-8');
  if (rawLines.length <= OPENCODE_MAX_LINES && rawBytes <= OPENCODE_MAX_BYTES) {
    return { text: raw, lines: rawLines.length, bytes: rawBytes, truncated: false };
  }
  const kept: string[] = [];
  let bytes = 0;
  for (let i = 0; i < rawLines.length && i < OPENCODE_MAX_LINES; i++) {
    const add = Buffer.byteLength(rawLines[i] + '\n', 'utf-8');
    if (bytes + add > OPENCODE_MAX_BYTES) break;
    kept.push(rawLines[i]);
    bytes += add;
  }
  const nota = `\n[OpenCode: salida truncada de ${rawLines.length} lineas / ${rawBytes} bytes a ${kept.length} lineas / ${bytes} bytes; el resto queda en un fichero]`;
  return { text: kept.join('\n') + nota, lines: kept.length, bytes, truncated: true };
}

function readFormat(rel: string): string {
  const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
  return content
    .split('\n')
    .map((l, i) => `${i + 1}: ${l}`)
    .join('\n');
}

function listFiles(dir: string, ext = '.ts'): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(ext)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** Arbol recursivo de rutas relativas (para simular `ls -R node_modules`). */
function listTree(dir: string, base = ''): string[] {
  const out: string[] = [];
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(rel + '/');
      out.push(...listTree(path.join(dir, e.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/** CONTEXT_MODE (proxy): trocea markdown por encabezados y recupera las
 *  secciones con mayor solape de terminos con la query. */
function mdSections(md: string): Array<{ title: string; body: string }> {
  const lines = md.split('\n');
  const sections: Array<{ title: string; body: string }> = [];
  let cur = { title: '(preambulo)', body: [] as string[] };
  for (const line of lines) {
    if (/^#{1,4}\s+/.test(line)) {
      if (cur.body.length || cur.title !== '(preambulo)') sections.push({ title: cur.title, body: cur.body.join('\n') });
      cur = { title: line, body: [] as string[] };
    } else {
      cur.body.push(line);
    }
  }
  sections.push({ title: cur.title, body: cur.body.join('\n') });
  return sections;
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
  const cached = tokenCache.get(key);
  if (cached !== undefined) return cached;
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

// --- Entorno real (una recoleccion) ------------------------------------------

interface Env {
  headSubject: string;
  headFiles: string[];
  logSubjects: string[];
  headFull: string;
  logFull: string;
  srcFiles: string[];
  exportNames: string[];
  symbol: string;
  symbolFiles: string[];
  symbolGreps: string;
  modelFiles: string[];
  sembleModels: string;
  sembleSymbol: string;
  sembleRouter: string;
  repomixOut: string;
  tscOut: string;
  tscFiles: string[];
  nmTop: string;
  nmTree: string;
  agentsMd: string;
  readmeMd: string;
  ps1: string;
  ps1Syms: string;
}

function collectEnv(): Env {
  const run = (c: string, t = TIMEOUT_MS): ShellResult => runShell(c, t);
  const headSubject = run('git log -1 --format=%s').stdout.trim();
  const headFiles = run('git show --name-only --format= HEAD')
    .stdout.split('\n')
    .map((s) => s.trim().replace(/\\/g, '/'))
    .filter(Boolean);
  const logSubjects = run('git log -n 5 --format=%s')
    .stdout.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const srcFiles = listFiles(path.join(ROOT, 'src')).map((p) => path.relative(ROOT, p).replace(/\\/g, '/'));
  const exportsOut = run('git grep -h -E "^export (const|function|class|interface|type|enum) " -- src').stdout;
  const exportNames: string[] = [];
  for (const line of exportsOut.split('\n')) {
    const m = line.match(/^\s*export\s+(?:const|function|class|interface|type|enum)\s+([A-Za-z0-9_]+)/);
    if (m) exportNames.push(m[1]);
  }

  const symbol = 'computeRecordCost';
  const symbolFiles = run(`git grep -l "${symbol}" -- src`)
    .stdout.split('\n')
    .map((s) => s.trim().replace(/\\/g, '/'))
    .filter(Boolean);
  const symbolGreps = run(`git grep -n "${symbol}" -- src`).stdout;

  const modelFiles = Array.from(
    new Set(
      [
        ...run('git grep -l "KLIA_API_KEY" -- src').stdout.split('\n'),
        ...run('git grep -l "/v1/models" -- src').stdout.split('\n'),
      ]
        .map((s) => s.trim().replace(/\\/g, '/'))
        .filter(Boolean),
    ),
  );

  const sembleModels = run(
    'semble search "where models are discovered from the KLIA API /v1/models normalizeModel family" . --max-snippet-lines 10 --top-k 5',
  ).stdout;
  const sembleSymbol = run(
    'semble search "computeRecordCost expected cost scoring function definition" . --max-snippet-lines 10 --top-k 5',
  ).stdout;
  const sembleRouter = run(
    'semble search "adaptive router learn from history choose optimizer createAdaptiveRouter" . --max-snippet-lines 10 --top-k 5',
  ).stdout;

  const repomixOut = run('npx -y repomix src --compress --stdout', 180_000).stdout;

  const tscOut = run('npx tsc --noEmit', 180_000).stdout;
  const tscFiles = Array.from(
    new Set(
      tscOut
        .split('\n')
        .map((l) => (l.match(/^(.*?\(\d+,\d+\)): error/) || [])[1])
        .filter(Boolean)
        .map((s) => (s as string).replace(/\(\d+,\d+\)$/, '')),
    ),
  );

  const nmDir = path.join(ROOT, 'node_modules');
  const nmTop = fs
    .readdirSync(nmDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '.bin')
    .map((e) => e.name)
    .sort()
    .join('\n');
  const nmTree = listTree(nmDir).join('\n');

  const agentsMd = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf-8');
  const readmeMd = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8');
  const ps1 = fs.readFileSync(path.join(ROOT, 'Install_klia_token.ps1'), 'utf-8');
  const ps1Syms = run('git grep -n -E "^function " -- Install_klia_token.ps1').stdout;

  return {
    headSubject,
    headFiles,
    logSubjects,
    headFull: run('git show HEAD').stdout,
    logFull: run('git log -p -n 5').stdout,
    srcFiles,
    exportNames,
    symbol,
    symbolFiles,
    symbolGreps,
    modelFiles,
    sembleModels,
    sembleSymbol,
    sembleRouter,
    repomixOut,
    tscOut,
    tscFiles,
    nmTop,
    nmTree,
    agentsMd,
    readmeMd,
    ps1,
    ps1Syms,
  };
}

// --- Escenarios --------------------------------------------------------------

interface Scenario {
  id: string;
  task: string;
  taskType: TaskType;
  optimizer: Optimizer;
  baseline: () => string;
  optimized: () => string;
  facts: string[];
  recovery: () => string;
  minimal: string;
}

function buildScenarios(env: Env): Scenario[] {
  const readAllSrc = (): string => env.srcFiles.map(readFormat).join('\n\n');
  const tscErrFiles = env.tscFiles.length ? env.tscFiles : ['tests/scorer/expected-cost-scorer.test.ts'];

  return [
    // --- SMALL_CODE ------------------------------------------------------------
    {
      id: 'D01',
      task: 'Leer package.json (control SMALL_CODE)',
      taskType: 'SMALL_CODE',
      optimizer: 'BASELINE',
      baseline: () => readFormat('package.json'),
      optimized: () => readFormat('package.json'),
      facts: ['klia-token-optimizer'],
      recovery: () => readFormat('package.json'),
      minimal: 'klia-token-optimizer',
    },
    {
      id: 'D02',
      task: `Localizar la funcion ${env.symbol} (fichero pequeno)`,
      taskType: 'SMALL_CODE',
      optimizer: 'SEMBLE',
      baseline: () => readFormat('src/scorer/expected-cost-scorer.ts'),
      optimized: () => env.sembleSymbol,
      facts: [env.symbol],
      recovery: () => readFormat('src/scorer/expected-cost-scorer.ts'),
      minimal: `${env.symbol} en src/scorer/expected-cost-scorer.ts`,
    },

    // --- TERMINAL --------------------------------------------------------------
    {
      id: 'D03',
      task: 'Ver el ultimo commit (mensaje, archivos y diff)',
      taskType: 'TERMINAL',
      optimizer: 'RTK',
      baseline: () => env.headFull,
      optimized: () => runShell('rtk git show HEAD').stdout,
      facts: [env.headSubject, ...env.headFiles.slice(0, 8)],
      recovery: () => env.headFull,
      minimal: [env.headSubject, ...env.headFiles].join('\n'),
    },
    {
      id: 'D04',
      task: 'Ver los ultimos 5 commits con diff (control TERMINAL)',
      taskType: 'TERMINAL',
      optimizer: 'BASELINE',
      baseline: () => env.logFull,
      optimized: () => env.logFull,
      facts: env.logSubjects,
      recovery: () => env.logFull,
      minimal: env.logSubjects.join('\n'),
    },
    {
      id: 'D05',
      task: 'Inspeccionar las dependencias instaladas (node_modules)',
      taskType: 'TERMINAL',
      optimizer: 'DCP',
      baseline: () => env.nmTree,
      optimized: () => env.nmTop,
      facts: ['zod', 'vitest', 'typescript'],
      recovery: () => env.nmTree,
      minimal: [env.nmTop.split('\n')[0], 'zod', 'vitest', 'typescript'].join('\n'),
    },

    // --- LARGE_CONTEXT ---------------------------------------------------------
    {
      id: 'D06',
      task: 'Entender la estructura del codigo de src',
      taskType: 'LARGE_CONTEXT',
      optimizer: 'REPOMIX',
      baseline: () => readAllSrc(),
      optimized: () => env.repomixOut,
      facts: env.exportNames,
      recovery: () => readAllSrc(),
      minimal: env.exportNames.join(' '),
    },
    {
      id: 'D07',
      task: 'Como aprende el router adaptativo de la historia y elige optimizador',
      taskType: 'LARGE_CONTEXT',
      optimizer: 'SEMBLE',
      baseline: () => [readFormat('src/index.ts'), readFormat('src/scorer/stats-report.ts')].join('\n\n'),
      optimized: () => env.sembleRouter,
      facts: ['createAdaptiveRouter', 'buildContextFromQuery'],
      recovery: () => [readFormat('src/index.ts'), readFormat('src/scorer/stats-report.ts')].join('\n\n'),
      minimal: 'createAdaptiveRouter en src/index.ts',
    },
    {
      id: 'D08',
      task: 'Como anado un optimizador nuevo (docs AGENTS.md)',
      taskType: 'LARGE_CONTEXT',
      optimizer: 'CONTEXT_MODE',
      baseline: () => env.agentsMd,
      optimized: () => retrieveSections(env.agentsMd, 'anadir nuevo optimizador extension base rules task type', 2),
      facts: ['Optimizer', 'BASE_RULES'],
      recovery: () => env.agentsMd,
      minimal: 'Optimizer BASE_RULES TaskType classifyTask',
    },
    {
      id: 'D09',
      task: 'Navegar un script PowerShell grande (138 KB) para localizar Save-Config',
      taskType: 'LARGE_CONTEXT',
      optimizer: 'SERENA',
      baseline: () => env.ps1,
      optimized: () => runShell('git grep -n -A4 -E "^function (Save-Config|Set-McpEntry)" -- Install_klia_token.ps1').stdout,
      facts: ['Save-Config', 'Set-McpEntry'],
      recovery: () => env.ps1,
      minimal: 'Save-Config Set-McpEntry',
    },

    // --- REPOSITORY_SEARCH -----------------------------------------------------
    {
      id: 'D10',
      task: 'Donde se descubren los modelos desde la API KLIA',
      taskType: 'REPOSITORY_SEARCH',
      optimizer: 'SEMBLE',
      baseline: () => env.modelFiles.map(readFormat).join('\n\n'),
      optimized: () => env.sembleModels,
      facts: ['klia-discovery', '/v1/models', 'KLIA_API_KEY'],
      recovery: () => env.modelFiles.map(readFormat).join('\n\n'),
      minimal: 'klia-discovery.ts /v1/models KLIA_API_KEY',
    },
    {
      id: 'D11',
      task: 'Recuperar de la documentacion como se ejecutan los tests y benchmarks',
      taskType: 'REPOSITORY_SEARCH',
      optimizer: 'CONTEXT_MODE',
      baseline: () => env.readmeMd,
      optimized: () => retrieveSections(env.readmeMd, 'tests benchmarks npm scripts ejecutar', 3),
      facts: ['npm test', 'benchmark'],
      recovery: () => env.readmeMd,
      minimal: 'npm test benchmark',
    },

    // --- MULTISTEP -------------------------------------------------------------
    {
      id: 'D12',
      task: 'Analiza el ultimo commit, lee el router y resume (3 pasos)',
      taskType: 'MULTISTEP',
      optimizer: 'DCP',
      baseline: () => [env.headFull, readFormat('src/index.ts'), readFormat('src/rules/base-rules.ts')].join('\n\n'),
      optimized: () => {
        const sigs = runShell('git grep -h -E "^export " -- src/index.ts src/rules/base-rules.ts').stdout;
        const rules = runShell('git grep -h -E "BASE_RULES|SMALL_CODE|DEBUG" -- src/rules/base-rules.ts').stdout;
        return [env.headSubject, ...env.headFiles, sigs, rules].join('\n');
      },
      facts: ['createAdaptiveRouter', 'BASE_RULES', env.headSubject],
      recovery: () => [env.headFull, readFormat('src/index.ts'), readFormat('src/rules/base-rules.ts')].join('\n\n'),
      minimal: [env.headSubject, 'createAdaptiveRouter', 'BASE_RULES'].join('\n'),
    },

    // --- REFACTOR --------------------------------------------------------------
    {
      id: 'D13',
      task: `Refactor: localizar ${env.symbol} y todos sus usos`,
      taskType: 'REFACTOR',
      optimizer: 'SERENA',
      baseline: () => env.symbolFiles.map(readFormat).join('\n\n'),
      optimized: () => env.symbolGreps,
      facts: [env.symbol],
      recovery: () => env.symbolFiles.map(readFormat).join('\n\n'),
      minimal: env.symbolGreps,
    },

    // --- DEBUG -----------------------------------------------------------------
    {
      id: 'D14',
      task: 'Arreglar los errores de tipo de tsc (salida real)',
      taskType: 'DEBUG',
      optimizer: 'RTK',
      baseline: () => [env.tscOut, ...tscErrFiles.map(readFormat)].join('\n\n'),
      optimized: () => runShell('rtk err npx tsc --noEmit', 180_000).stdout,
      facts: ['TS2741', 'familyConfidenceWeight'],
      recovery: () => [env.tscOut, ...tscErrFiles.map(readFormat)].join('\n\n'),
      minimal: env.tscOut.split('\n')[0],
    },
    {
      id: 'D15',
      task: 'Diagnosticar el error TS2741 y la definicion del tipo (DEBUG)',
      taskType: 'DEBUG',
      optimizer: 'CONTEXT_MODE',
      baseline: () => [env.tscOut, ...tscErrFiles.map(readFormat), readFormat('src/types.ts')].join('\n\n'),
      optimized: () =>
        [env.tscOut, runShell('git grep -n -A2 "interface RouterOptions" -- src/types.ts').stdout].join('\n---\n'),
      facts: ['familyConfidenceWeight', 'RouterOptions'],
      recovery: () => [env.tscOut, ...tscErrFiles.map(readFormat), readFormat('src/types.ts')].join('\n\n'),
      minimal: 'familyConfidenceWeight RouterOptions',
    },
  ];
}

function missingFacts(text: string, facts: string[]): string[] {
  return facts.filter((f) => f && !text.includes(f));
}

interface Row {
  id: string;
  task: string;
  taskType: TaskType;
  optimizer: Optimizer;
  baseTok: number;
  baseEff: number;
  optTok: number;
  effectiveTok: number;
  savings: number;
  ceiling: number;
  recovered: boolean;
  baseRecovered: boolean;
  missing: string[];
  baseTrunc: boolean;
  optTrunc: boolean;
  nota: string;
}

async function evaluate(s: Scenario): Promise<Row> {
  const base = opencodeCap(s.baseline());
  const opt = opencodeCap(s.optimized());
  const baseTok = await toks(base.text);
  const optTok = await toks(opt.text);
  const baseMissing = missingFacts(base.text, s.facts);
  const optMissing = missingFacts(opt.text, s.facts);
  const needsRecovery = baseMissing.length > 0 || optMissing.length > 0;
  const recoveryTok = needsRecovery ? await toks(s.recovery()) : 0;
  const baseEff = baseTok + (baseMissing.length ? recoveryTok : 0);
  const effectiveTok = optTok + (optMissing.length ? recoveryTok : 0);
  const savings = baseEff > 0 ? 1 - effectiveTok / baseEff : 0;
  const ceiling = baseEff > 0 ? 1 - (await toks(s.minimal)) / baseEff : 0;
  return {
    id: s.id,
    task: s.task,
    taskType: s.taskType,
    optimizer: s.optimizer,
    baseTok,
    baseEff,
    optTok,
    effectiveTok,
    savings,
    ceiling,
    recovered: optMissing.length > 0,
    baseRecovered: baseMissing.length > 0,
    missing: optMissing,
    baseTrunc: base.truncated,
    optTrunc: opt.truncated,
    nota: '',
  };
}

function verdict(savings: number): string {
  if (savings > 0.1) return 'gana';
  if (savings >= -0.1) return 'empata';
  return 'pierde';
}
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

// --- Reporte -----------------------------------------------------------------

function report(rows: Row[], env: Env): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const valid = rows.filter((r) => r.baseTok > 0);
  const ganan = valid.filter((r) => verdict(r.savings) === 'gana').length;
  const empatan = valid.filter((r) => verdict(r.savings) === 'empata').length;
  const pierden = valid.filter((r) => verdict(r.savings) === 'pierde').length;
  const sumBase = valid.reduce((a, r) => a + r.baseEff, 0);
  const sumEff = valid.reduce((a, r) => a + r.effectiveTok, 0);
  const weighted = sumBase > 0 ? 1 - sumEff / sumBase : 0;
  const mean = valid.length ? valid.reduce((a, r) => a + r.savings, 0) / valid.length : 0;
  const mejor = valid.slice().sort((a, b) => b.savings - a.savings)[0];

  const byOpt = new Map<Optimizer, Row[]>();
  for (const r of valid) {
    if (!byOpt.has(r.optimizer)) byOpt.set(r.optimizer, []);
    byOpt.get(r.optimizer)!.push(r);
  }

  console.log('');
  console.log(`[diverse] modelo=${MODEL} (tokens REALES via usage.prompt_tokens)`);
  console.log(`[diverse] overhead plantilla=${_Overhead} tokens | escenarios=${rows.length} | src=${env.srcFiles.length} ficheros | node_modules nivel-1=${env.nmTop.split('\n').length}`);
  console.log('');
  console.log(['ID', 'Tipo', 'Optim', 'baseEff', 'optEff', 'ahorro', 'techo', 'cob', 'verdict'].join(' | '));
  console.log('-'.repeat(84));
  for (const r of rows) {
    if (r.baseTok === 0) {
      console.log(`${r.id} | ${r.taskType} | ${r.optimizer} | N/D: ${r.nota}`);
      continue;
    }
    const cob = r.recovered ? 'OPT-falta' : r.baseRecovered ? 'base-inc' : 'OK';
    console.log(
      [
        r.id,
        r.taskType.padEnd(17),
        r.optimizer.padEnd(12),
        String(r.baseEff).padStart(7),
        String(r.effectiveTok).padStart(7),
        pct(r.savings).padStart(7),
        pct(r.ceiling).padStart(6),
        cob.padEnd(9),
        verdict(r.savings),
      ].join(' | '),
    );
  }
  console.log('-'.repeat(84));
  console.log(`Veredicto: ${ganan} gana / ${empatan} empata / ${pierden} pierde`);
  console.log(`Ahorro ponderado por coste efectivo: ${pct(weighted)}`);
  console.log(`Ahorro medio (no ponderado):         ${pct(mean)}`);
  console.log('');
  console.log('--- Por optimizador ---');
  for (const [opt, rs] of Array.from(byOpt.entries()).sort()) {
    const w = 1 - rs.reduce((a, r) => a + r.effectiveTok, 0) / rs.reduce((a, r) => a + r.baseEff, 0);
    const m = rs.reduce((a, r) => a + r.savings, 0) / rs.length;
    console.log(`${opt.padEnd(13)} n=${rs.length}  media=${pct(m).padStart(7)}  ponderado=${pct(w).padStart(7)}`);
  }
  if (mejor) {
    console.log('');
    console.log(`AHORRO MAXIMO: ${pct(mejor.savings)} (${mejor.id} ${mejor.optimizer} - ${mejor.task})`);
    console.log(`TECHO de ese escenario: ${pct(mejor.ceiling)}`);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    apiBase: API_BASE,
    tokenizer: 'real (KLIA /v1/chat/completions usage.prompt_tokens)',
    overheadTokens: _Overhead,
    opencodeBaseline: { maxLines: OPENCODE_MAX_LINES, maxBytes: OPENCODE_MAX_BYTES, readPrefix: true },
    gate: 'simetrico (baseline y optimizador pagan recuperacion si faltan hechos)',
    proxies: {
      DCP: 'poda/deduplicacion determinista (node_modules nivel-1; multi-paso a firmas+hechos)',
      CONTEXT_MODE: 'recuperacion de secciones markdown relevantes (proxy FTS5)',
      SERENA: 'git grep -n como proxy de find_symbol/referencias (sin CLI de Serena)',
    },
    summary: {
      ganan,
      empatan,
      pierden,
      weighted,
      mean,
      maxSavings: mejor ? { id: mejor.id, optimizer: mejor.optimizer, taskType: mejor.taskType, savings: mejor.savings, ceiling: mejor.ceiling } : null,
    },
    byOptimizer: Array.from(byOpt.entries()).map(([optimizer, rs]) => ({
      optimizer,
      n: rs.length,
      mean: rs.reduce((a, r) => a + r.savings, 0) / rs.length,
      weighted: 1 - rs.reduce((a, r) => a + r.effectiveTok, 0) / rs.reduce((a, r) => a + r.baseEff, 0),
    })),
    env: {
      headSubject: env.headSubject,
      headFiles: env.headFiles,
      symbolFiles: env.symbolFiles,
      modelFiles: env.modelFiles,
      srcFileCount: env.srcFiles.length,
      exportCount: env.exportNames.length,
      nodeModulesL1: env.nmTop.split('\n').length,
      tscFiles: env.tscFiles,
    },
    rows,
  };
  fs.writeFileSync(DATA_PATH, JSON.stringify(payload, null, 2), 'utf-8');

  const md: string[] = [];
  md.push('# Benchmark diverso (tokens reales)\n');
  md.push(`- Modelo/tokenizador: **${MODEL}** (real, \`usage.prompt_tokens\`)`);
  md.push(`- Baseline OpenCode: Read con prefijo \`N: \` + Bash truncado a ${OPENCODE_MAX_LINES} lineas / ${OPENCODE_MAX_BYTES} bytes`);
  md.push('- Gate simetrico + recuperacion (artefacto completo); techo teorico por escenario');
  md.push('- Proxies: DCP (poda/dedup), CONTEXT_MODE (recuperacion de secciones), SERENA (git grep)');
  md.push(`- Generado: ${payload.generatedAt}\n`);
  md.push(`**Veredicto: ${ganan} gana / ${empatan} empata / ${pierden} pierde.** Ponderado **${pct(weighted)}**, medio ${pct(mean)}.`);
  if (mejor) md.push(`\n**Ahorro maximo: ${pct(mejor.savings)}** (${mejor.id} ${mejor.optimizer}, ${mejor.taskType}), techo ${pct(mejor.ceiling)}.\n`);
  md.push('\n| ID | Tipo | Tarea | Optim | baseEff | optEff | ahorro | techo | cobertura | veredicto |');
  md.push('|---|---|---|---|---:|---:|---:|---:|---|---|');
  for (const r of rows) {
    if (r.baseTok === 0) {
      md.push(`| ${r.id} | ${r.taskType} | ${r.task} | ${r.optimizer} | N/D | | | | | ${r.nota} |`);
      continue;
    }
    const cob = r.recovered ? `OPT falta: ${r.missing.join(', ')}` : r.baseRecovered ? 'baseline incompleto' : 'OK';
    md.push(`| ${r.id} | ${r.taskType} | ${r.task} | ${r.optimizer} | ${r.baseEff} | ${r.effectiveTok} | ${pct(r.savings)} | ${pct(r.ceiling)} | ${cob} | ${verdict(r.savings)} |`);
  }
  md.push('\n## Ahorro por optimizador\n');
  md.push('| Optimizador | n | medio | ponderado |');
  md.push('|---|---:|---:|---:|');
  for (const [opt, rs] of Array.from(byOpt.entries()).sort()) {
    const w = 1 - rs.reduce((a, r) => a + r.effectiveTok, 0) / rs.reduce((a, r) => a + r.baseEff, 0);
    const m = rs.reduce((a, r) => a + r.savings, 0) / rs.length;
    md.push(`| ${opt} | ${rs.length} | ${pct(m)} | ${pct(w)} |`);
  }
  fs.writeFileSync(REPORTE_PATH, md.join('\n') + '\n', 'utf-8');

  console.log('');
  console.log(`[diverse] JSON -> ${DATA_PATH}`);
  console.log(`[diverse] Reporte -> ${REPORTE_PATH}`);
}

async function main(): Promise<void> {
  console.log(`[diverse] modelo=${MODEL} api=${API_BASE}`);
  if (!API_KEY) {
    console.error('[diverse] Falta KLIA_API_KEY en el entorno.');
    process.exit(1);
  }
  await overhead();
  const t0 = Date.now();
  const env = collectEnv();
  console.log(`[diverse] entorno recogido en ${((Date.now() - t0) / 1000).toFixed(1)}s (incluye repomix, semble, tsc)`);
  const scenarios = buildScenarios(env);

  const rows: Row[] = [];
  for (const s of scenarios) {
    const t = Date.now();
    try {
      const row = await evaluate(s);
      rows.push(row);
      console.log(`[diverse] ${s.id} ${s.taskType}/${s.optimizer} en ${((Date.now() - t) / 1000).toFixed(1)}s - ${pct(row.savings)}${row.recovered ? ' (recuperacion)' : ''}`);
    } catch (e) {
      console.log(`[diverse] ${s.id} N/D: ${(e as Error).message}`);
      rows.push({
        id: s.id,
        task: s.task,
        taskType: s.taskType,
        optimizer: s.optimizer,
        baseTok: 0,
        baseEff: 0,
        optTok: 0,
        effectiveTok: 0,
        savings: 0,
        ceiling: 0,
        recovered: false,
        baseRecovered: false,
        missing: [],
        baseTrunc: false,
        optTrunc: false,
        nota: (e as Error).message.slice(0, 60),
      });
    }
  }
  report(rows, env);
  console.log(`[diverse] tiempo total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error('[diverse] error fatal:', (e as Error).message);
  process.exit(1);
});
