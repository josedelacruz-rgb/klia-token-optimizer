#!/usr/bin/env node
/**
 * run-benchmark-adversarial.ts - Benchmark duro y realista de ahorro de tokens.
 *
 * Por que es mas duro que run-benchmark-real.ts:
 *
 *  1. BASELINE COMPETENTE-MINIMO. No se compara contra un volcado ingenuo
 *     (leer todos los archivos / comando completo sin filtrar), sino contra lo
 *     que haria un agente EXPERTO: un grep dirigido para localizar codigo, un
 *     grep de firmas (`^export`) para obtener la estructura, o el comando
 *     minimo suficiente (p.ej. `git show HEAD` cuando hace falta el diff).
 *     Un agente competente rara vez vuelca contexto que no necesita.
 *
 *  2. GATE DE COBERTURA + COSTE DE RECUPERACION. El ahorro no se mide por
 *     tamano de salida, sino por si la salida del optimizador contiene los
 *     HECHOS REQUERIDOS (simbolos exportados / paths que la tarea necesita).
 *     Si faltan hechos, el agente debe RECUPERARLOS: releer el fichero que los
 *     contiene (modo 'files') o re-ejecutar el comando completo (modo 'command').
 *
 *        coste_efectivo = tokens(optimizador) + recuperacion
 *        ahorro = 1 - coste_efectivo / baseline
 *
 *     El ahorro PUEDE ser NEGATIVO: si el optimizador devuelve algo mas grande
 *     o incompleto que el baseline competente, empeora el resultado.
 *
 *  3. Sin siembra de historial (router en frio, V0) y sin repeticiones
 *     artificiales: 1 pasada determinista por tarea (limite ~10 min).
 *
 *  4. Timeouts y herramientas no disponibles se reportan como N/D (excluidos).
 *
 * Uso: npx tsx pruebas_v3/run-benchmark-adversarial.ts [--model M] [--repetitions N]
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { buildContextFromQuery, createAdaptiveRouter } from '../src/index';
import { analyzeTask } from '../src/classifier/task-classifier';
import type { Optimizer } from '../src/types';

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'resultados');
const DATA_PATH = path.join(OUT_DIR, 'resultados-adversarial.json');
const REPORTE_PATH = path.join(OUT_DIR, 'reporte-adversarial.md');
const TIMEOUT_MS = 120_000;

const tokens = (s: string): number => (s ? Math.max(1, Math.ceil(s.length / 3.7)) : 0);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Regex de presencia de un hecho con limites de identificador tolerantes a
 * nombres que empiezan por caracter no-palabra (p.ej. `.prettierrc.json`).
 */
const factRe = (name: string): RegExp => new RegExp(`(?:^|[^\\w$])${escapeRe(name)}(?![\\w$])`);

interface ShellResult {
  stdout: string;
  timedOut: boolean;
  ok: boolean;
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
  const timedOut =
    (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ||
    res.signal === 'SIGTERM';
  return {
    stdout: res.stdout || '',
    timedOut,
    ok: !timedOut && res.status === 0,
    durationMs: Date.now() - start,
  };
}

function readRel(rel: string): string {
  const full = path.join(ROOT, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf-8') : '';
}

function fileTokens(rel: string): number {
  return tokens(readRel(rel));
}

const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md']);

function walk(dir: string, acc: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'coverage') {
      continue;
    }
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (SCAN_EXT.has(path.extname(e.name))) acc.push(full);
  }
}

/** grep recursivo en Node (baseline competente para localizar codigo). */
function grepRecursive(roots: string[], re: RegExp, maxMatches = 400): string {
  const files: string[] = [];
  for (const r of roots) {
    const full = path.join(ROOT, r);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  const out: string[] = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const lines = fs.readFileSync(f, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
        if (out.length >= maxMatches) return out.join('\n');
      }
    }
  }
  return out.join('\n');
}

const DECL_RE =
  /^\s*export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(class|function|interface|type|enum|const|let|var)\s+([A-Za-z0-9_$]+)/;

/** Firmas exportadas de una lista de ficheros (baseline competente de estructura). */
function signatures(files: string[]): string {
  const out: string[] = [];
  for (const rel of files) {
    const text = readRel(rel);
    if (!text) continue;
    text.split('\n').forEach((line, i) => {
      if (DECL_RE.test(line)) out.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return out.join('\n');
}

/**
 * Baseline suficiente para EDITAR: leer la ventana de codigo alrededor de cada
 * coincidencia (no basta con la linea del grep para modificar el valor).
 */
function readWindows(files: string[], re: RegExp, radius = 40): string {
  const out: string[] = [];
  for (const rel of files) {
    const text = readRel(rel);
    if (!text) continue;
    const lines = text.split('\n');
    const keep = new Set<number>();
    lines.forEach((line, i) => {
      if (re.test(line)) {
        for (let j = Math.max(0, i - radius); j <= Math.min(lines.length - 1, i + radius); j++) {
          keep.add(j);
        }
      }
    });
    if (keep.size) {
      out.push(`--- ${rel} (ventana +-${radius} alrededor de coincidencias) ---`);
      [...keep].sort((a, b) => a - b).forEach((i) => out.push(lines[i]));
    }
  }
  return out.join('\n');
}

interface Fact {
  name: string;
  source: string;
}

/** Simbolos exportados de los ficheros, con su fichero de origen (para recuperacion). */
function declaredSymbols(files: string[]): Fact[] {
  const out: Fact[] = [];
  for (const rel of files) {
    const text = readRel(rel);
    if (!text) continue;
    for (const line of text.split('\n')) {
      const m = DECL_RE.exec(line);
      if (m) out.push({ name: m[2], source: rel });
    }
  }
  return out;
}

/** Paths modificados presentes en un `git show` completo (lineas `diff --git`). */
function gitChangedFiles(text: string): Fact[] {
  const seen = new Set<string>();
  const out: Fact[] = [];
  for (const m of text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const p = m[2].trim();
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push({ name: p, source: p });
    }
  }
  return out;
}

/** Ficheros con error presentes en la salida de `tsc --noEmit`. */
function tscErrorFiles(text: string): Fact[] {
  const seen = new Set<string>();
  const out: Fact[] = [];
  const re = /^(\S+?\.(?:ts|tsx|js|jsx))\(\d+,\d+\):/;
  for (const line of text.split('\n')) {
    const m = re.exec(line.trim());
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      out.push({ name: m[1], source: m[1] });
    }
  }
  return out;
}

interface Medida {
  text: string;
  tokens: number;
  available: boolean;
  timedOut: boolean;
  error?: string;
}

function fail(error: string, timedOut = false): Medida {
  return { text: '', tokens: 0, available: false, timedOut, error };
}

function sembleMeasure(query: string): Medida {
  const q = query.replace(/"/g, '');
  const r = runShell(
    `semble search "${q}" "${ROOT}" --max-snippet-lines 15 --top-k 3 --content code`,
  );
  if (r.timedOut) return fail('semble timeout', true);
  const text = r.stdout.trim();
  if (!text) return fail('semble sin salida');
  return { text, tokens: tokens(text), available: true, timedOut: false };
}

function repomixMeasure(files: string[]): Medida {
  const out = path.join(OUT_DIR, 'temp-adversarial.xml');
  const include = files.map((f) => f.replace(/\\/g, '/')).join(',');
  const r = runShell(
    `npx -y repomix --compress --include "${include}" --style xml --output "${out}"`,
  );
  if (r.timedOut) return fail('repomix timeout', true);
  if (!fs.existsSync(out)) return fail('repomix no disponible');
  const text = fs.readFileSync(out, 'utf-8');
  try {
    fs.unlinkSync(out);
  } catch {
    /* ignore */
  }
  return { text, tokens: tokens(text), available: true, timedOut: false };
}

interface Scenario {
  id: string;
  nombre: string;
  taskType: string;
  query: string;
  /** Optimizador apropiado para la tarea (el que se mide). */
  measured: Optimizer;
  files: string[];
  /** Sentinelas para ctx del router. */
  hasTerminal: boolean;
  isRefactor: boolean;
  isSearch: boolean;
  /** Baseline competente-minimo. */
  baseline: () => Medida;
  /** Hechos requeridos que la salida optimizada debe contener. */
  facts: (baselineText: string) => Fact[];
  /** Como recupera el agente la informacion que falte. */
  recoveryMode: 'files' | 'command';
  /** Comando RTK con el que se mide (si measured === 'RTK'). */
  rtkCommand?: string;
}

const HISTORY_FILES = [
  'src/history/history-store.ts',
  'src/history/router-event-store.ts',
  'src/history/mcp-metrics-store.ts',
  'src/history/migrate.ts',
];

const SCENARIOS: Scenario[] = [
  {
    id: 'A1',
    nombre: 'Localizar normalizacion de modelos',
    taskType: 'REPOSITORY_SEARCH',
    query: 'donde se normalizan los nombres y familias de modelos',
    measured: 'SEMBLE',
    files: ['src/utils/model-family.ts'],
    hasTerminal: false,
    isRefactor: false,
    isSearch: true,
    baseline: () => {
      const text = grepRecursive(
        ['src'],
        /normaliz|ModelFamily|extractModelFamily|KNOWN_FAMILIES/i,
      );
      return { text, tokens: tokens(text), available: true, timedOut: false };
    },
    facts: () => declaredSymbols(['src/utils/model-family.ts']),
    recoveryMode: 'files',
  },
  {
    id: 'A2',
    nombre: 'Estructura y firmas del modulo de historial',
    taskType: 'LARGE_CONTEXT',
    query: 'dame la estructura y firmas de los modulos de historial y persistencia',
    measured: 'REPOMIX',
    files: HISTORY_FILES,
    hasTerminal: false,
    isRefactor: false,
    isSearch: false,
    baseline: () => {
      const text = signatures(HISTORY_FILES);
      return { text, tokens: tokens(text), available: true, timedOut: false };
    },
    facts: () => declaredSymbols(HISTORY_FILES),
    recoveryMode: 'files',
  },
  {
    id: 'A3',
    nombre: 'Contenido de los cambios del ultimo commit',
    taskType: 'TERMINAL',
    query: 'revisa el contenido de los cambios del ultimo commit',
    measured: 'RTK',
    files: [],
    hasTerminal: true,
    isRefactor: false,
    isSearch: false,
    rtkCommand: 'rtk git show HEAD',
    baseline: () => {
      const r = runShell('git show HEAD');
      if (r.timedOut) return { text: '', tokens: 0, available: true, timedOut: true };
      return { text: r.stdout, tokens: tokens(r.stdout), available: true, timedOut: false };
    },
    facts: (base) => gitChangedFiles(base),
    recoveryMode: 'command',
  },
  {
    id: 'A4',
    nombre: 'Errores de tipos y sus ficheros',
    taskType: 'TERMINAL',
    query: 'dime si hay errores de tipos y en que archivos estan',
    measured: 'RTK',
    files: [],
    hasTerminal: true,
    isRefactor: false,
    isSearch: false,
    rtkCommand: 'rtk err "npx tsc --noEmit"',
    baseline: () => {
      const r = runShell('npx tsc --noEmit');
      if (r.timedOut) return { text: '', tokens: 0, available: true, timedOut: true };
      return { text: r.stdout, tokens: tokens(r.stdout), available: true, timedOut: false };
    },
    facts: (base) => tscErrorFiles(base),
    recoveryMode: 'command',
  },
  {
    id: 'A5',
    nombre: 'Edicion puntual (confidenceMultiplier)',
    taskType: 'SMALL_CODE',
    query: 'cambiar el valor por defecto de confidenceMultiplier en el selector',
    measured: 'SEMBLE',
    files: ['src/selector/optimizer-selector.ts'],
    hasTerminal: false,
    isRefactor: false,
    isSearch: false,
    baseline: () => {
      const text = readWindows(['src/selector/optimizer-selector.ts'], /confidenceMultiplier/);
      return { text, tokens: tokens(text), available: true, timedOut: false };
    },
    facts: () => [{ name: 'confidenceMultiplier', source: 'src/selector/optimizer-selector.ts' }],
    recoveryMode: 'files',
  },
  {
    id: 'A6',
    nombre: 'Refactor del modulo de historial',
    taskType: 'REFACTOR',
    query: 'refactorizar el modulo de historial separando migracion y storage',
    measured: 'BASELINE',
    files: ['src/history/history-store.ts', 'src/history/router-event-store.ts', 'src/history/migrate.ts'],
    hasTerminal: false,
    isRefactor: true,
    isSearch: false,
    baseline: () => {
      let text = '';
      for (const rel of ['src/history/history-store.ts', 'src/history/router-event-store.ts', 'src/history/migrate.ts']) {
        text += readRel(rel);
      }
      return { text, tokens: tokens(text), available: true, timedOut: false };
    },
    facts: (base) =>
      declaredSymbols(['src/history/history-store.ts', 'src/history/router-event-store.ts', 'src/history/migrate.ts']),
    recoveryMode: 'files',
  },
];

function optimizedFor(scen: Scenario, pick: Optimizer, baseline: Medida): Medida {
  switch (pick) {
    case 'SEMBLE':
      return sembleMeasure(scen.query);
    case 'REPOMIX':
      return scen.files.length ? repomixMeasure(scen.files) : fail('REPOMIX sin ficheros');
    case 'RTK':
      return scen.rtkCommand
        ? (() => {
            const r = runShell(scen.rtkCommand as string);
            if (r.timedOut) return fail('rtk timeout', true);
            const text = r.stdout.trim();
            if (!text) return fail('rtk sin salida');
            return { text, tokens: tokens(text), available: true, timedOut: false };
          })()
        : fail('RTK sin comando');
    case 'BASELINE':
    default:
      return { ...baseline, available: true };
  }
}

interface EvalResult {
  savings: number | null;
  coverage: number;
  optTokens: number;
  recoveryTokens: number;
  effectiveTokens: number;
  available: boolean;
  nota: string;
}

function evaluate(scen: Scenario, pick: Optimizer, baseline: Medida): EvalResult {
  const empty: EvalResult = {
    savings: null,
    coverage: 1,
    optTokens: 0,
    recoveryTokens: 0,
    effectiveTokens: 0,
    available: false,
    nota: '',
  };
  if (baseline.timedOut) return { ...empty, nota: 'timeout baseline' };
  const opt = optimizedFor(scen, pick, baseline);
  if (opt.timedOut) return { ...empty, nota: 'timeout optimizador' };
  if (!opt.available) return { ...empty, nota: opt.error ?? 'optimizador no disponible' };

  // Solo cuentan los hechos que el baseline competente ya exponia (gate justo).
  const factsAll = scen.facts(baseline.text);
  const facts = factsAll.filter((f) => factRe(f.name).test(baseline.text));
  const present = facts.filter((f) => factRe(f.name).test(opt.text));
  const missing = facts.filter((f) => !present.includes(f));
  const coverage = facts.length ? present.length / facts.length : 1;

  let recovery = 0;
  if (missing.length) {
    if (scen.recoveryMode === 'files') {
      const sources = [...new Set(missing.map((f) => f.source))];
      recovery = sources.reduce((a, s) => a + fileTokens(s), 0);
    } else {
      recovery = baseline.tokens; // re-ejecutar el comando completo
    }
  }

  const effective = opt.tokens + recovery;
  const savings =
    baseline.tokens > 0 ? +(((baseline.tokens - effective) / baseline.tokens) * 100).toFixed(1) : null;
  return {
    savings,
    coverage: +coverage.toFixed(2),
    optTokens: opt.tokens,
    recoveryTokens: recovery,
    effectiveTokens: effective,
    available: true,
    nota: missing.length
      ? `recuperacion: faltan ${missing.length}/${facts.length} hechos`
      : '',
  };
}

async function main() {
  const args = process.argv.slice(2);
  const modelIdx = args.indexOf('--model');
  const model = modelIdx >= 0 && args[modelIdx + 1] ? args[modelIdx + 1] : 'glm-5.2';

  console.log('===============================================================');
  console.log('BENCHMARK ADVERSARIAL - baseline competente + recuperacion');
  console.log('===============================================================');
  console.log(`Modelo: ${model} | 1 pasada determinista | Timeout: ${TIMEOUT_MS / 1000}s`);
  console.log('');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const historyPath = path.join(OUT_DIR, 'adversarial-history.json');
  if (fs.existsSync(historyPath)) fs.rmSync(historyPath);
  const router = createAdaptiveRouter({ historyPath, enableExploration: false });

  interface Fila {
    id: string;
    nombre: string;
    taskType: string;
    measured: Optimizer;
    routerPick: Optimizer;
    baselineTokens: number | null;
    optTokens: number;
    recoveryTokens: number;
    effectiveTokens: number;
    coverage: number;
    savingsApplicable: number | null;
    savingsRouter: number | null;
    nota: string;
  }
  const filas: Fila[] = [];

  for (const scen of SCENARIOS) {
    const ctx = buildContextFromQuery(model, scen.query, {
      fileCount: scen.files.length,
      contextSizeBytes: scen.files.reduce((a, rel) => a + fileTokens(rel) * 3.7, 0),
      hasTerminalCommands: scen.hasTerminal,
      isRefactor: scen.isRefactor,
      isRepositorySearch: scen.isSearch,
    });
    const routerPick = (await router.route(ctx)).optimizer;

    const base = scen.baseline();
    const app = evaluate(scen, scen.measured, base);
    const rout = routerPick === scen.measured ? app : evaluate(scen, routerPick, base);

    const baseT = base.timedOut ? null : base.tokens;
    console.log(`[${scen.id}] ${scen.nombre}`);
    console.log(
      `   medido=${scen.measured} router=${routerPick} baseline=${baseT ?? 'N/D'}t ` +
        `opt=${app.optTokens}t recup=${app.recoveryTokens}t cobertura=${(app.coverage * 100).toFixed(0)}% ` +
        `ahorro=${app.savings === null ? 'N/D' : app.savings + '%'}${app.nota ? ' (' + app.nota + ')' : ''}`,
    );

    filas.push({
      id: scen.id,
      nombre: scen.nombre,
      taskType: analyzeTask(ctx.signals).taskType,
      measured: scen.measured,
      routerPick,
      baselineTokens: baseT,
      optTokens: app.optTokens,
      recoveryTokens: app.recoveryTokens,
      effectiveTokens: app.effectiveTokens,
      coverage: app.coverage,
      savingsApplicable: app.savings,
      savingsRouter: rout.savings,
      nota: app.nota,
    });
  }

  const validas = filas.filter((f) => f.savingsApplicable !== null);
  const num = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const savingsList = validas.map((f) => f.savingsApplicable as number);
  const meanPct = +num(savingsList).toFixed(1);
  const sorted = [...savingsList].sort((a, b) => a - b);
  const medianPct = sorted.length
    ? +((sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      )).toFixed(1)
    : 0;
  const totalBase = validas.reduce((a, f) => a + (f.baselineTokens ?? 0), 0);
  const totalEff = validas.reduce((a, f) => a + f.effectiveTokens, 0);
  const weightedPct = totalBase > 0 ? +(((totalBase - totalEff) / totalBase) * 100).toFixed(1) : 0;
  const meanCoverage = +num(validas.map((f) => f.coverage)).toFixed(2);
  const wins = validas.filter((f) => (f.savingsApplicable ?? 0) > 1).length;
  const losses = validas.filter((f) => (f.savingsApplicable ?? 0) < -1).length;
  const ties = validas.length - wins - losses;

  const datos = {
    model,
    fecha: new Date().toISOString(),
    metodologia:
      'Baseline competente-minimo suficiente; gate de cobertura de hechos; coste de recuperacion; ahorro negativo permitido.',
    filas,
    global: {
      tareasInvalidas: filas.length - validas.length,
      totalTareas: filas.length,
      gana: wins,
      pierde: losses,
      empata: ties,
      ahorroMedioPct: meanPct,
      ahorroMedianaPct: medianPct,
      ahorroPonderadoPct: weightedPct,
      coberturaMedia: meanCoverage,
    },
  };
  fs.writeFileSync(DATA_PATH, JSON.stringify(datos, null, 2), 'utf-8');

  let md = `# Benchmark adversarial: ahorro real de tokens\n\n`;
  md += `**Modelo:** \`${model}\` | **Fecha:** ${datos.fecha}\n\n`;
  md += `**Metodologia:** baseline competente-minimo (grep dirigido / grep de firmas / comando minimo); `;
  md += `gate de cobertura (la salida del optimizador debe contener los hechos requeridos); `;
  md += `el coste de recuperacion (releer el fichero o re-ejecutar el comando) se suma al optimizador. `;
  md += `El ahorro puede ser negativo si el optimizador es peor que el baseline competente.\n\n`;
  md += `## Resumen\n\n`;
  md += `- Tareas evaluadas: **${validas.length}/${filas.length}**\n`;
  md += `- Resultado por tarea: **${wins} gana / ${ties} empata / ${losses} pierde**\n`;
  md += `- **Ahorro mediana por tarea: ${medianPct}%** (metrica robusta; recomendada)\n`;
  md += `- Ahorro medio por tarea: ${meanPct}% (dominado por tareas de baseline minusculo)\n`;
  md += `- Ahorro ponderado por tokens: ${weightedPct}%\n`;
  md += `- Cobertura media de hechos: ${(meanCoverage * 100).toFixed(0)}%\n\n`;
  md += `## Detalle\n\n`;
  md += `| ID | Tarea | Tipo | Medido | Router | Baseline | Opt | Recup | Efectivo | Cob. | Ahorro | Nota |\n`;
  md += `|:---|:---|:---|:---|:---|---:|---:|---:|---:|---:|---:|:---|\n`;
  for (const f of filas) {
    md += `| ${f.id} | ${f.nombre} | ${f.taskType} | ${f.measured} | ${f.routerPick} | ${f.baselineTokens ?? 'N/D'} | ${f.optTokens} | ${f.recoveryTokens} | ${f.effectiveTokens} | ${(f.coverage * 100).toFixed(0)}% | ${f.savingsApplicable === null ? 'N/D' : f.savingsApplicable + '%'} | ${f.nota || '-'} |\n`;
  }
  md += `\n> "Recup" = tokens de recuperacion que el agente paga por hechos ausentes.\n`;
  md += `> "N/D" = no cuenta para el ahorro (timeout o herramienta no disponible).\n`;
  fs.writeFileSync(REPORTE_PATH, md, 'utf-8');

  console.log('\n===============================================================');
  console.log(`Mediana: ${medianPct}% | ponderado: ${weightedPct}% | medio: ${meanPct}%`);
  console.log(`Resultado: ${wins} gana / ${ties} empata / ${losses} pierde | cobertura media: ${(meanCoverage * 100).toFixed(0)}%`);
  console.log(`Reporte: ${REPORTE_PATH}`);
  console.log(`Datos:   ${DATA_PATH}`);
  console.log('===============================================================');
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
