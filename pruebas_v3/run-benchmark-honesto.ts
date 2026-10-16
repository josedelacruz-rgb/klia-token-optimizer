#!/usr/bin/env node
/**
 * run-benchmark-honesto.ts - Evaluacion A/B sin sesgos.
 *
 * Diferencias frente a run-benchmark-v3.ts (que sobreestimaba el ahorro):
 *
 *  1. NO siembra historial sintetico. El router decide EN FRIO (V0) con sus
 *     reglas base y se mide el optimizador que realmente elige. No se inyectan
 *     tokens simulados ni "candidatos esperados".
 *  2. Baseline COMPARABLE: cada tarea usa el metodo natural sin optimizador
 *     (comando completo / lectura completa / grep), no una lectura inflada.
 *  3. Los TIMEOUTS se reportan como fallo explicito y se EXCLUYEN del ahorro
 *     (un timeout nunca cuenta como "0 tokens = 100% ahorro").
 *  4. Si la herramienta del optimizador no esta disponible o falla, la tarea
 *     se marca como NO MEDIBLE (no se simula un filtro).
 *
 * Uso:
 *   npx tsx pruebas_v3/run-benchmark-honesto.ts [--repetitions N] [--model M]
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { buildContextFromQuery, createAdaptiveRouter, extractModelFamily } from '../src/index';
import { analyzeTask } from '../src/classifier/task-classifier';
import type { Optimizer } from '../src/types';

const ROOT = path.resolve(__dirname, '..');
const RESULTADOS_DIR = path.join(__dirname, 'resultados');
const DATOS_PATH = path.join(RESULTADOS_DIR, 'resultados-honesto.json');
const REPORTE_PATH = path.join(RESULTADOS_DIR, 'reporte-honesto.md');

type BaselineMode = 'command' | 'fullread' | 'grep';

interface Escenario {
  id: string;
  nombre: string;
  taskType: string;
  query: string;
  comando: string | null;
  archivos: string[];
  /** Metodo natural sin optimizador con el que se compara. */
  baselineMode: BaselineMode;
  /** Patron para baselineMode === 'grep'. */
  grepPattern?: string;
}

const ESCENARIOS: Escenario[] = [
  {
    id: 'T1',
    nombre: 'Inspeccion terminal (tsc --listFiles)',
    taskType: 'TERMINAL',
    query: 'ejecuta la comprobacion de tipos y resume los archivos',
    comando: 'npx tsc --noEmit --listFiles',
    archivos: [],
    baselineMode: 'command',
  },
  {
    id: 'T2',
    nombre: 'Explicar el sistema de scoring (lectura completa)',
    taskType: 'LARGE_CONTEXT',
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
    nombre: 'Estructura del historial y persistencia (lectura completa)',
    taskType: 'LARGE_CONTEXT',
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
    nombre: 'Buscar normalizacion de modelos (grep)',
    taskType: 'REPOSITORY_SEARCH',
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
  {
    id: 'T5',
    nombre: 'Edicion puntual de codigo pequeno',
    taskType: 'SMALL_CODE',
    query: 'cambiar el valor por defecto de confidenceMultiplier en el selector',
    comando: null,
    archivos: ['src/selector/optimizer-selector.ts'],
    baselineMode: 'fullread',
  },
  {
    id: 'T6',
    nombre: 'Refactor con verificacion tsc (comando)',
    taskType: 'REFACTOR',
    query: 'refactorizar el modulo de historial para separar migracion y storage',
    comando: 'npx tsc --noEmit',
    archivos: [],
    baselineMode: 'command',
  },
];

interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  durationMs: number;
}

interface Medida {
  available: boolean;
  timedOut: boolean;
  tokens: number;
  bytes: number;
  latencyMs: number;
  error?: string;
}

function runShell(command: string, timeoutMs: number): ShellResult {
  const start = Date.now();
  const res = spawnSync(command, {
    cwd: ROOT,
    encoding: 'utf-8',
    shell: true,
    maxBuffer: 40 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const timedOut =
    (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ||
    res.signal === 'SIGTERM';
  return {
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    code: res.status ?? (res.error ? 1 : 0),
    timedOut,
    durationMs: Date.now() - start,
  };
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3.7));
}

function readFiles(archivos: string[]): { text: string; missing: string[] } {
  let text = '';
  const missing: string[] = [];
  for (const rel of archivos) {
    const full = path.join(ROOT, rel);
    if (fs.existsSync(full)) {
      text += `\n--- ${rel} ---\n` + fs.readFileSync(full, 'utf-8');
    } else {
      missing.push(rel);
    }
  }
  return { text, missing };
}

/** Grep en Node: lineas que casan el patron, con prefijo path:line. */
function grepFiles(archivos: string[], pattern: string): string {
  const re = new RegExp(pattern, 'i');
  const out: string[] = [];
  for (const rel of archivos) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const lines = fs.readFileSync(full, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      if (re.test(line)) out.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return out.join('\n');
}

function measureBaseline(task: Escenario, timeoutMs: number): Medida {
  let text = '';
  let timedOut = false;
  let error: string | undefined;

  if (task.comando) {
    const res = runShell(task.comando, timeoutMs);
    if (res.timedOut) timedOut = true;
    text += res.stdout;
    if (res.code !== 0 && !res.stdout) error = res.stderr.slice(0, 200);
  }
  if (task.baselineMode === 'fullread' || task.baselineMode === 'command') {
    text += readFiles(task.archivos).text;
  } else if (task.baselineMode === 'grep') {
    text += grepFiles(task.archivos, task.grepPattern ?? task.query);
  }

  return {
    available: true,
    timedOut,
    tokens: estimateTokens(text),
    bytes: Buffer.byteLength(text, 'utf-8'),
    latencyMs: 0,
    error,
  };
}

function measureOptimized(task: Escenario, optimizer: Optimizer, timeoutMs: number): Medida {
  const empty: Medida = { available: false, timedOut: false, tokens: 0, bytes: 0, latencyMs: 0 };

  switch (optimizer) {
    case 'RTK': {
      if (!task.comando) return { ...empty, error: 'RTK sin comando de terminal' };
      // rtk es un proxy: envuelve el comando. `rtk err` muestra solo errores/warnings.
      const res = runShell(`rtk err "${task.comando}"`, timeoutMs);
      if (res.timedOut) return { ...empty, timedOut: true, error: 'rtk timeout' };
      const output = res.stdout.trim();
      if (!output) return { ...empty, error: 'rtk sin salida' };
      return {
        available: true,
        timedOut: false,
        tokens: estimateTokens(output),
        bytes: Buffer.byteLength(output, 'utf-8'),
        latencyMs: res.durationMs,
      };
    }

    case 'SEMBLE': {
      const res = runShell(
        `semble search "${task.query}" "${ROOT}" --max-snippet-lines 15 --top-k 3 --content code`,
        timeoutMs,
      );
      if (res.timedOut) return { ...empty, timedOut: true, error: 'semble timeout' };
      if (!res.stdout || res.code !== 0) return { ...empty, error: 'semble no disponible' };
      return {
        available: true,
        timedOut: false,
        tokens: estimateTokens(res.stdout),
        bytes: Buffer.byteLength(res.stdout, 'utf-8'),
        latencyMs: res.durationMs,
      };
    }

    case 'REPOMIX': {
      const tempOut = path.join(RESULTADOS_DIR, 'temp-repomix-honesto.xml');
      const include = task.archivos.map((a) => a.replace(/\\/g, '/')).join(',');
      const res = runShell(
        `npx -y repomix --compress --include "${include}" --style xml --output "${tempOut}"`,
        timeoutMs,
      );
      if (res.timedOut) return { ...empty, timedOut: true, error: 'repomix timeout' };
      if (!fs.existsSync(tempOut)) return { ...empty, error: 'repomix no disponible' };
      const output = fs.readFileSync(tempOut, 'utf-8');
      try {
        fs.unlinkSync(tempOut);
      } catch {
        /* ignore */
      }
      return {
        available: true,
        timedOut: false,
        tokens: estimateTokens(output),
        bytes: Buffer.byteLength(output, 'utf-8'),
        latencyMs: res.durationMs,
      };
    }

    case 'BASELINE':
    default:
      // El router eligio BASELINE: el "optimizado" es el propio baseline.
      return { ...measureBaseline(task, timeoutMs), available: true };
  }
}

interface FilaEscenario {
  id: string;
  nombre: string;
  taskType: string;
  optimizer: Optimizer;
  baselineTokens: number | null;
  optimizedTokens: number | null;
  ahorroPct: number | null;
  baselineTimedOut: boolean;
  optimizedTimedOut: boolean;
  nota: string;
}

async function main() {
  const args = process.argv.slice(2);
  const repIdx = args.indexOf('--repetitions');
  const repetitions = repIdx >= 0 && args[repIdx + 1] ? parseInt(args[repIdx + 1], 10) : 3;
  const modelIdx = args.indexOf('--model');
  const model = modelIdx >= 0 && args[modelIdx + 1] ? args[modelIdx + 1] : 'glm-5.2';
  const timeoutMs = 120_000;

  console.log('===============================================================');
  console.log('BENCHMARK HONESTO - sin siembra sintetica, baseline comparable');
  console.log('===============================================================');
  console.log(`Modelo: ${model} | Repeticiones: ${repetitions} | Timeout: ${timeoutMs / 1000}s`);
  console.log('');

  fs.mkdirSync(RESULTADOS_DIR, { recursive: true });

  // Historial VACIO: el router decide en frio con sus reglas base (V0).
  const historyPath = path.join(RESULTADOS_DIR, 'honesto-history.json');
  if (fs.existsSync(historyPath)) fs.rmSync(historyPath);

  const router = createAdaptiveRouter({ historyPath, enableExploration: false });

  const filas: FilaEscenario[] = [];

  for (const task of ESCENARIOS) {
    const ctx = buildContextFromQuery(model, task.query, {
      fileCount: task.archivos.length,
      contextSizeBytes: task.archivos.reduce((acc, rel) => {
        const full = path.join(ROOT, rel);
        return acc + (fs.existsSync(full) ? fs.statSync(full).size : 0);
      }, 0),
      hasTerminalCommands: Boolean(task.comando),
      isRefactor: task.taskType === 'REFACTOR',
      isRepositorySearch: task.taskType === 'REPOSITORY_SEARCH',
      isMultistep: task.taskType === 'MULTISTEP',
    });
    const analysis = analyzeTask(ctx.signals);
    const decision = await router.route(ctx);
    const optimizer = decision.optimizer;

    console.log(`[${task.id}] ${task.nombre}`);
    console.log(`   Router (en frio, ${decision.version}, conf ${decision.confidence}): ${optimizer}`);

    const baseTokens: number[] = [];
    const optTokens: number[] = [];
    let baseTimedOut = false;
    let optTimedOut = false;
    let nota = '';

    for (let r = 0; r < repetitions; r++) {
      const b = measureBaseline(task, timeoutMs);
      if (b.timedOut) baseTimedOut = true;
      baseTokens.push(b.tokens);

      const o = measureOptimized(task, optimizer, timeoutMs);
      if (o.timedOut) optTimedOut = true;
      if (!o.available) nota = o.error ?? 'optimizador no medible';
      optTokens.push(o.tokens);
    }

    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const baseMean = Math.round(avg(baseTokens));
    const optMean = Math.round(avg(optTokens));

    let ahorro: number | null = null;
    if (!baseTimedOut && !optTimedOut && !nota && baseMean > 0) {
      ahorro = +(((baseMean - optMean) / baseMean) * 100).toFixed(1);
    }

    console.log(
      `   baseline=${baseMean}t optimizado=${optMean}t ahorro=${ahorro === null ? 'N/D' : ahorro + '%'}${nota ? ' (' + nota + ')' : ''}${baseTimedOut ? ' [baseline timeout]' : ''}${optTimedOut ? ' [opt timeout]' : ''}`,
    );

    filas.push({
      id: task.id,
      nombre: task.nombre,
      taskType: analysis.taskType,
      optimizer,
      baselineTokens: baseTimedOut ? null : baseMean,
      optimizedTokens: optTimedOut || nota ? null : optMean,
      ahorroPct: ahorro,
      baselineTimedOut: baseTimedOut,
      optimizedTimedOut: optTimedOut,
      nota,
    });
  }

  // Global: solo tareas con ahorro medible.
  const validas = filas.filter((f) => f.ahorroPct !== null);
  const totalBase = validas.reduce((a, f) => a + (f.baselineTokens ?? 0), 0);
  const totalOpt = validas.reduce((a, f) => a + (f.optimizedTokens ?? 0), 0);
  const globalPct = totalBase > 0 ? +(((totalBase - totalOpt) / totalBase) * 100).toFixed(1) : 0;

  const datos = {
    model,
    repetitions,
    fecha: new Date().toISOString(),
    metodologia: 'Sin siembra sintetica; baseline natural por tarea; timeouts excluidos.',
    filas,
    global: { tareasMedibles: validas.length, totalTareas: filas.length, baseTokens: totalBase, optTokens: totalOpt, ahorroPct: globalPct },
  };
  fs.writeFileSync(DATOS_PATH, JSON.stringify(datos, null, 2), 'utf-8');

  let md = `# Benchmark honesto: ahorro real de tokens\n\n`;
  md += `**Modelo:** \`${model}\` | **Repeticiones:** ${repetitions} | **Fecha:** ${datos.fecha}\n\n`;
  md += `**Metodologia:** sin siembra de historial sintetico (el router decide en frio); `;
  md += `baseline natural por tarea (comando completo / lectura completa / grep); `;
  md += `los timeouts se reportan y se excluyen del ahorro.\n\n`;
  md += `## Resumen global\n\n`;
  md += `- Tareas medibles: **${validas.length}/${filas.length}**\n`;
  md += `- Tokens baseline (suma): **${totalBase.toLocaleString()}**\n`;
  md += `- Tokens con optimizador (suma): **${totalOpt.toLocaleString()}**\n`;
  md += `- **Ahorro global (solo tareas medibles): ${globalPct}%**\n\n`;
  md += `## Detalle por tarea\n\n`;
  md += `| ID | Tarea | Tipo | Optimizador | Baseline | Optimizado | Ahorro | Nota |\n`;
  md += `|:---|:---|:---|:---|---:|---:|---:|:---|\n`;
  for (const f of filas) {
    md += `| ${f.id} | ${f.nombre} | ${f.taskType} | ${f.optimizer} | ${f.baselineTokens ?? 'N/D'} | ${f.optimizedTokens ?? 'N/D'} | ${f.ahorroPct === null ? 'N/D' : f.ahorroPct + '%'} | ${f.baselineTimedOut ? 'timeout baseline' : f.optimizedTimedOut ? 'timeout optimizador' : f.nota || '-'} |\n`;
  }
  md += `\n> Los valores "N/D" no entran en el ahorro global (timeout o herramienta no disponible).\n`;
  fs.writeFileSync(REPORTE_PATH, md, 'utf-8');

  console.log('\n===============================================================');
  console.log(`Ahorro global honesto: ${globalPct}% (${validas.length}/${filas.length} tareas medibles)`);
  console.log(`Reporte: ${REPORTE_PATH}`);
  console.log(`Datos:   ${DATOS_PATH}`);
  console.log('===============================================================');
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
