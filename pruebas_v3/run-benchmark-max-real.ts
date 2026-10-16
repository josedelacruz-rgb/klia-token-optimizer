#!/usr/bin/env node
/**
 * run-benchmark-max-real.ts - Benchmark "maximo realista" con conteo de tokens REAL.
 *
 * Diferencias frente a los benchmarks previos (honesto / real / adversarial):
 *
 *  1. TOKENS REALES, no estimados. Cada contexto se envia al endpoint
 *     OpenAI-compatible de KLIA (`/v1/chat/completions`, max_tokens=1) y se
 *     lee `usage.prompt_tokens`. Es el tokenizador EXACTO del proveedor que usa
 *     OpenCode, no la heuristica chars/3.7. Se descuenta el overhead fijo de la
 *     plantilla de chat midiendolo con una sonda de 1 caracter.
 *
 *  2. BASELINE = LO QUE OPENCODE INYECTA DE VERDAD. No se vuelca el comando
 *     completo: se aplica el limite real de OpenCode para salida de tools
 *     (2000 lineas / 51200 bytes; lo que exceda va a un fichero y NO entra al
 *     contexto). Los ficheros leidos se formatean como el tool Read (prefijo
 *     "N: "). Esto vuelve el baseline realista y, por tanto, el ahorro honesto.
 *
 *  3. GATE DE COBERTURA + RECUPERACION. El ahorro se mide sobre el coste
 *     EFECTIVO: si la salida del optimizador no contiene los HECHOS requeridos,
 *     el agente debe recuperarlos y se suma el coste de recuperacion. El ahorro
 *     PUEDE ser negativo.
 *
 *  4. TECHO TEORICO por escenario: 1 - tokens(evidencia minima suficiente) /
 *     tokens(baseline). Muestra cuanto margen queda sin optimizar.
 *
 * Uso: npx tsx pruebas_v3/run-benchmark-max-real.ts [--model GLM-5.2]
 * Limite previsto: < 15 min (portatil viejo). Los comandos pesados son repomix
 * (~13 s) y semble (~6 s); el resto es git/lectura local. Sin repeticiones.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import type { Optimizer } from '../src/types';

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'resultados');
const DATA_PATH = path.join(OUT_DIR, 'resultados-max-real.json');
const REPORTE_PATH = path.join(OUT_DIR, 'reporte-max-real.md');
const TIMEOUT_MS = 90_000;

const API_BASE = process.env.KLIA_API_BASE || 'https://api.klia.tech/v1';
const API_KEY = process.env.KLIA_API_KEY || '';
const MODEL = process.env.KLIA_BENCH_MODEL || 'GLM-5.2';

const OPENCODE_MAX_LINES = 2000;
const OPENCODE_MAX_BYTES = 51200;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const stdout = (res.stdout || '').toString();
  const ok = !res.error && res.status === 0;
  const timedOut = !!(res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
  return { stdout, ok, timedOut, durationMs: Date.now() - start };
}

/** Trunca como OpenCode: primera de (2000 lineas, 51200 bytes). */
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

/** Formatea un fichero como el tool Read de OpenCode: "N: contenido". */
function readFormat(rel: string): string {
  const abs = path.join(ROOT, rel);
  const content = fs.readFileSync(abs, 'utf-8');
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

// --- Conteo de tokens REAL (KLIA API, OpenAI-compatible) ---------------------

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
      const j = (await r.json()) as { usage?: { prompt_tokens?: number }; error?: unknown };
      if (!j.usage || typeof j.usage.prompt_tokens !== 'number') {
        lastErr = `sin usage: ${JSON.stringify(j).slice(0, 200)}`;
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
  const raw = await countTokensRaw(text);
  return Math.max(1, raw - (await overhead()));
}

// --- Entorno real (una sola recoleccion) -------------------------------------

interface Env {
  headSubject: string;
  headFiles: string[];
  logSubjects: string[];
  srcFiles: string[];
  exportNames: string[];
  symbol: string;
  symbolFiles: string[];
  symbolGreps: string;
  modelFiles: string[];
  sembleOut: string;
  repomixOut: string;
}

function collectEnv(): Env {
  const run = (c: string): ShellResult => runShell(c);
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

  const sembleOut = run(
    'semble search "where models are discovered from the KLIA API /v1/models normalizeModel family" . --max-snippet-lines 10 --top-k 5',
  ).stdout;
  const repomixOut = run('npx -y repomix src --compress --stdout').stdout;

  return {
    headSubject,
    headFiles,
    logSubjects,
    srcFiles,
    exportNames,
    symbol,
    symbolFiles,
    symbolGreps,
    modelFiles,
    sembleOut,
    repomixOut,
  };
}

// --- Escenarios --------------------------------------------------------------

interface Scenario {
  id: string;
  task: string;
  taskType: string;
  optimizer: Optimizer;
  baseline: () => string;
  optimized: () => string;
  facts: string[];
  recovery: () => string;
  minimal: string;
}

function buildScenarios(env: Env): Scenario[] {
  return [
    {
      id: 'S1',
      task: 'Ver el ultimo commit (mensaje, archivos y diff)',
      taskType: 'TERMINAL',
      optimizer: 'RTK',
      baseline: () => runShell('git show HEAD').stdout,
      optimized: () => runShell('rtk git show HEAD').stdout,
      facts: [env.headSubject, ...env.headFiles.slice(0, 8)],
      recovery: () => runShell('git show HEAD').stdout,
      minimal: [env.headSubject, ...env.headFiles].join('\n'),
    },
    {
      id: 'S2',
      task: 'Ver los ultimos 5 commits con diff',
      taskType: 'TERMINAL',
      optimizer: 'RTK',
      baseline: () => runShell('git log -p -n 5').stdout,
      optimized: () => runShell('rtk git log -p -n 5').stdout,
      facts: env.logSubjects,
      recovery: () => runShell('git log -p -n 5').stdout,
      minimal: env.logSubjects.join('\n'),
    },
    {
      id: 'S3',
      task: 'Entender la estructura del codigo de src',
      taskType: 'LARGE_CONTEXT',
      optimizer: 'REPOMIX',
      baseline: () => env.srcFiles.map(readFormat).join('\n\n'),
      optimized: () => env.repomixOut,
      facts: env.exportNames,
      recovery: () => env.srcFiles.map(readFormat).join('\n\n'),
      minimal: env.exportNames.join(' '),
    },
    {
      id: 'S4',
      task: 'Donde se descubren los modelos desde la API KLIA',
      taskType: 'REPOSITORY_SEARCH',
      optimizer: 'SEMBLE',
      baseline: () => env.modelFiles.map(readFormat).join('\n\n'),
      optimized: () => env.sembleOut,
      facts: ['klia-discovery', '/v1/models', 'KLIA_API_KEY'],
      recovery: () => env.modelFiles.map(readFormat).join('\n\n'),
      minimal: 'klia-discovery.ts /v1/models KLIA_API_KEY normalizeModel',
    },
    {
      id: 'S5',
      task: `Localizar ${env.symbol} y sus usos (navegacion de simbolos)`,
      taskType: 'REFACTOR',
      optimizer: 'SERENA',
      baseline: () => env.symbolFiles.map(readFormat).join('\n\n'),
      optimized: () => env.symbolGreps,
      facts: [env.symbol],
      recovery: () => env.symbolFiles.map(readFormat).join('\n\n'),
      minimal: env.symbolGreps,
    },
    {
      id: 'S6',
      task: 'Leer package.json (control: sin optimizacion posible)',
      taskType: 'SMALL_CODE',
      optimizer: 'BASELINE',
      baseline: () => readFormat('package.json'),
      optimized: () => readFormat('package.json'),
      facts: ['klia-token-optimizer'],
      recovery: () => readFormat('package.json'),
      minimal: 'klia-token-optimizer',
    },
  ];
}

function missingFacts(text: string, facts: string[]): string[] {
  return facts.filter((f) => f && !text.includes(f));
}

interface Row {
  id: string;
  task: string;
  taskType: string;
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
  baseMissing: string[];
  baseTrunc: boolean;
  optTrunc: boolean;
  nota: string;
}

/**
 * Evalua un escenario con GATE SIMETRICO: la cobertura de hechos se exige tanto
 * al optimizador como al baseline. Si un brazo no contiene los hechos requeridos
 * (tipico cuando la salida fue truncada por OpenCode), el agente debe recuperarlos
 * leyendo el artefacto COMPLETO sin truncar; ese coste se suma a ese brazo. Asi
 * el ahorro no se infla penalizando solo a un lado.
 */
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
    baseMissing,
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

  console.log('');
  console.log(`[max-real] modelo=${MODEL} (tokens REALES via usage.prompt_tokens)`);
  console.log(`[max-real] overhead plantilla = ${_Overhead} tokens`);
  console.log('');
  const head = ['ID', 'Tarea', 'Optim', 'baseEff', 'optEff', 'ahorro', 'techo', 'cobertura', 'veredicto'];
  console.log(head.join(' | '));
  console.log('-'.repeat(96));
  for (const r of rows) {
    if (r.baseTok === 0) {
      console.log([r.id, r.task.slice(0, 26).padEnd(26), r.optimizer.padEnd(12), 'N/D', '', '', '', '', r.nota].join(' | '));
      continue;
    }
    const cob = r.recovered ? `OPT falta: ${r.missing.slice(0, 2).join(',')}` : r.baseRecovered ? 'base incompleto' : 'OK';
    console.log(
      [
        r.id,
        r.task.slice(0, 26).padEnd(26),
        r.optimizer.padEnd(12),
        String(r.baseEff).padStart(6),
        String(r.effectiveTok).padStart(6),
        pct(r.savings).padStart(7),
        pct(r.ceiling).padStart(6),
        cob.slice(0, 26).padEnd(26),
        verdict(r.savings),
      ].join(' | '),
    );
  }
  console.log('-'.repeat(96));
  console.log(`Veredicto: ${ganan} gana / ${empatan} empata / ${pierden} pierde`);
  console.log(`Ahorro ponderado por coste efectivo: ${pct(weighted)}`);
  console.log(`Ahorro medio (no ponderado):         ${pct(mean)}`);
  if (mejor) console.log(`AHORRO MAXIMO: ${pct(mejor.savings)} (${mejor.id} ${mejor.optimizer} - ${mejor.task})`);
  if (mejor) console.log(`TECHO de ese escenario: ${pct(mejor.ceiling)}`);

  const payload = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    apiBase: API_BASE,
    tokenizer: 'real (KLIA /v1/chat/completions usage.prompt_tokens)',
    overheadTokens: _Overhead,
    opencodeBaseline: { maxLines: OPENCODE_MAX_LINES, maxBytes: OPENCODE_MAX_BYTES, readPrefix: true },
    gate: 'simetrico (baseline y optimizador pagan recuperacion si faltan hechos)',
    summary: { ganan, empatan, pierden, weighted, mean, maxSavings: mejor ? { id: mejor.id, optimizer: mejor.optimizer, savings: mejor.savings, ceiling: mejor.ceiling } : null },
    env: { headSubject: env.headSubject, headFiles: env.headFiles, logSubjects: env.logSubjects, symbolFiles: env.symbolFiles, modelFiles: env.modelFiles, srcFileCount: env.srcFiles.length, exportCount: env.exportNames.length },
    rows,
  };
  fs.writeFileSync(DATA_PATH, JSON.stringify(payload, null, 2), 'utf-8');

  const md: string[] = [];
  md.push('# Benchmark max-real (tokens reales)\n');
  md.push(`- Modelo/tokenizador: **${MODEL}** (real, \`usage.prompt_tokens\`)`);
  md.push(`- Overhead de plantilla descontado: ${_Overhead} tokens`);
  md.push(`- Baseline OpenCode: tool Read con prefijo \`N: \`, salida de Bash truncada a ${OPENCODE_MAX_LINES} lineas / ${OPENCODE_MAX_BYTES} bytes`);
  md.push('- Gate **simetrico**: si baseline u optimizador no contienen los hechos, ese brazo paga la recuperacion (lectura del artefacto completo)');
  md.push(`- Generado: ${payload.generatedAt}\n`);
  md.push(`**Veredicto: ${ganan} gana / ${empatan} empata / ${pierden} pierde.** Ahorro ponderado **${pct(weighted)}**, medio ${pct(mean)}.`);
  if (mejor) md.push(`\n**Ahorro maximo: ${pct(mejor.savings)}** (${mejor.id} ${mejor.optimizer}), techo ${pct(mejor.ceiling)}.\n`);
  md.push('\n| ID | Tarea | Optim | baseTok | baseEff | optTok | optEff | ahorro | techo | cobertura | veredicto |');
  md.push('|---|---|---|---:|---:|---:|---:|---:|---:|---|---|');
  for (const r of rows) {
    if (r.baseTok === 0) {
      md.push(`| ${r.id} | ${r.task} | ${r.optimizer} | N/D | | | | | | | ${r.nota} |`);
      continue;
    }
    const cob = r.recovered ? `OPT falta: ${r.missing.join(', ')}` : r.baseRecovered ? 'baseline incompleto (recupera, igual que OPT)' : 'OK';
    md.push(`| ${r.id} | ${r.task} | ${r.optimizer} | ${r.baseTok} | ${r.baseEff} | ${r.optTok} | ${r.effectiveTok} | ${pct(r.savings)} | ${pct(r.ceiling)} | ${cob} | ${verdict(r.savings)} |`);
  }
  fs.writeFileSync(REPORTE_PATH, md.join('\n') + '\n', 'utf-8');
  console.log('');
  console.log(`[max-real] JSON -> ${DATA_PATH}`);
  console.log(`[max-real] Reporte -> ${REPORTE_PATH}`);
}

async function main(): Promise<void> {
  console.log(`[max-real] modelo=${MODEL} api=${API_BASE}`);
  if (!API_KEY) {
    console.error('[max-real] Falta KLIA_API_KEY en el entorno.');
    process.exit(1);
  }
  await overhead();
  console.log(`[max-real] overhead plantilla = ${_Overhead} tokens`);

  const env = collectEnv();
  console.log(`[max-real] entorno: ${env.srcFiles.length} ficheros src, ${env.exportNames.length} exports, ${env.headFiles.length} ficheros en HEAD`);
  const scenarios = buildScenarios(env);

  const rows: Row[] = [];
  for (const s of scenarios) {
    const t = Date.now();
    try {
      const row = await evaluate(s);
      rows.push(row);
      console.log(
        `[max-real] ${s.id} ${s.optimizer} listo en ${((Date.now() - t) / 1000).toFixed(1)}s - ahorro ${pct(row.savings)}${row.recovered ? ' (RECUPERACION)' : ''}`,
      );
    } catch (e) {
      console.log(`[max-real] ${s.id} N/D: ${(e as Error).message}`);
      rows.push({
        id: s.id,
        task: s.task,
        taskType: s.taskType,
        optimizer: s.optimizer,
        baseTok: 0,
        optTok: 0,
        effectiveTok: 0,
        savings: 0,
        ceiling: 0,
        recovered: false,
        missing: [],
        baseTrunc: false,
        optTrunc: false,
        nota: (e as Error).message.slice(0, 60),
      });
    }
  }
  report(rows, env);
}

main().catch((e) => {
  console.error('[max-real] error fatal:', (e as Error).message);
  process.exit(1);
});
