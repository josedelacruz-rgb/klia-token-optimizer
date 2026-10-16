#!/usr/bin/env node
/**
 * run-benchmark-real.ts - Benchmark defendible de ahorro de contexto.
 *
 * Principios (a diferencia de v3 y del "honesto"):
 *  1. Baseline MINIMO SUFICIENTE: lo que un agente competente consumiria sin el
 *     optimizador (comando natural / lectura completa / grep), no una lectura
 *     inflada.
 *  2. PUERTA DE CALIDAD: el ahorro solo cuenta si la salida del optimizador
 *     contiene la informacion necesaria para completar la tarea (artefactos
 *     requeridos). Si no, la tarea NO aporta ahorro.
 *  3. Optimizador APROPIADO por tarea, y se compara con lo que el router elige
 *     en frio (sin historial) para verificar que coincide.
 *  4. Timeouts reportados y excluidos.
 *
 * Uso: npx tsx pruebas_v3/run-benchmark-real.ts [--repetitions N] [--model M]
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { buildContextFromQuery, createAdaptiveRouter } from '../src/index';
import { analyzeTask } from '../src/classifier/task-classifier';
import type { Optimizer } from '../src/types';

const ROOT = path.resolve(__dirname, '..');
const RESULTADOS_DIR = path.join(__dirname, 'resultados');
const DATOS_PATH = path.join(RESULTADOS_DIR, 'resultados-real.json');
const REPORTE_PATH = path.join(RESULTADOS_DIR, 'reporte-real.md');

type BaselineMode = 'command' | 'fullread' | 'grep';

interface Escenario {
  id: string;
  nombre: string;
  taskType: string;
  query: string;
  comando: string | null;
  archivos: string[];
  baselineMode: BaselineMode;
  grepPattern?: string;
  /** Optimizador apropiado para la tarea (el que se mide). */
  optimizer: Optimizer;
  /** Comando con el que se mide el optimizador RTK (si aplica). */
  rtkCommand?: string;
  /** Regex: al menos uno debe aparecer en la salida optimizada (puerta de calidad). */
  requiredArtifacts: string[];
}

const ESCENARIOS: Escenario[] = [
  {
    id: 'S1',
    nombre: 'Buscar donde se normalizan los modelos',
    taskType: 'REPOSITORY_SEARCH',
    query: 'donde se normalizan los nombres y familias de modelos',
    comando: null,
    archivos: [
      'src/utils/model-family.ts',
      'src/index.ts',
      'src/mcp-server.ts',
      'src/selector/optimizer-selector.ts',
    ],
    baselineMode: 'grep',
    grepPattern: 'normaliz|family|familia|modelFamily|KNOWN_FAMILIES',
    optimizer: 'SEMBLE',
    requiredArtifacts: ['normalizeModel', 'extractModelFamily', 'KNOWN_FAMILIES', 'modelFamily'],
  },
  {
    id: 'S2',
    nombre: 'Estructura y firmas del modulo de historial',
    taskType: 'LARGE_CONTEXT',
    query: 'dame la estructura y firmas de los modulos de historial y persistencia',
    comando: null,
    archivos: [
      'src/history/history-store.ts',
      'src/history/router-event-store.ts',
      'src/history/migrate.ts',
    ],
    baselineMode: 'fullread',
    optimizer: 'REPOMIX',
    requiredArtifacts: ['JsonHistoryStore', 'RouterEventStore', 'migrateV1ToV2', 'createExecutionRecord'],
  },
  {
    id: 'S3',
    nombre: 'Resumir los cambios del ultimo commit',
    taskType: 'TERMINAL',
    query: 'resume los cambios del ultimo commit',
    comando: 'git show HEAD',
    archivos: [],
    baselineMode: 'command',
    optimizer: 'RTK',
    rtkCommand: 'rtk git show HEAD',
    requiredArtifacts: ['\\.prettierrc\\.json', 'dev\\.md', 'src/'],
  },
  {
    id: 'S4',
    nombre: 'Edicion de codigo pequeno',
    taskType: 'SMALL_CODE',
    query: 'cambiar un valor por defecto en el selector',
    comando: null,
    archivos: ['src/selector/optimizer-selector.ts'],
    baselineMode: 'fullread',
    optimizer: 'BASELINE',
    requiredArtifacts: [],
  },
  {
    id: 'S5',
    nombre: 'Refactor del modulo de historial',
    taskType: 'REFACTOR',
    query: 'refactorizar el modulo de historial',
    comando: null,
    archivos: [
      'src/history/history-store.ts',
      'src/history/router-event-store.ts',
      'src/history/migrate.ts',
    ],
    baselineMode: 'fullread',
    optimizer: 'BASELINE',
    requiredArtifacts: [],
  },
];

interface ShellResult {
  stdout: string;
  timedOut: boolean;
  durationMs: number;
}

function runShell(command: string, timeoutMs = 120_000): ShellResult {
  const start = Date.now();
  const res = spawnSync(command, {
    cwd: ROOT,
    encoding: 'utf-8',
    shell: true,
    maxBuffer: 40 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const timedOut =
    (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM';
  return { stdout: res.stdout || '', timedOut, durationMs: Date.now() - start };
}

const tokens = (t: string) => (t ? Math.max(1, Math.ceil(t.length / 3.7)) : 0);

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

interface Medida {
  text: string;
  tokens: number;
  timedOut: boolean;
  available: boolean;
  error?: string;
}

function measureBaseline(t: Escenario): Medida {
  let text = '';
  let timedOut = false;
  if (t.comando) {
    const r = runShell(t.comando);
    if (r.timedOut) timedOut = true;
    text += r.stdout;
  }
  if (t.baselineMode === 'fullread' || t.baselineMode === 'command') text += readFiles(t.archivos);
  else if (t.baselineMode === 'grep') text += grepFiles(t.archivos, t.grepPattern ?? t.query);
  return { text, tokens: tokens(text), timedOut, available: true };
}

function measureOptimized(t: Escenario): Medida {
  const fail = (error: string, timedOut = false): Medida => ({
    text: '',
    tokens: 0,
    timedOut,
    available: false,
    error,
  });

  switch (t.optimizer) {
    case 'RTK': {
      if (!t.rtkCommand) return fail('RTK sin comando');
      const r = runShell(t.rtkCommand);
      if (r.timedOut) return fail('rtk timeout', true);
      const out = r.stdout.trim();
      if (!out) return fail('rtk sin salida');
      return { text: out, tokens: tokens(out), timedOut: false, available: true };
    }
    case 'SEMBLE': {
      const r = runShell(
        `semble search "${t.query}" "${ROOT}" --max-snippet-lines 15 --top-k 3 --content code`,
      );
      if (r.timedOut) return fail('semble timeout', true);
      if (!r.stdout || r.stdout.trim().length === 0) return fail('semble sin salida');
      return { text: r.stdout, tokens: tokens(r.stdout), timedOut: false, available: true };
    }
    case 'REPOMIX': {
      const out = path.join(RESULTADOS_DIR, 'temp-real.xml');
      const include = t.archivos.map((a) => a.replace(/\\/g, '/')).join(',');
      const r = runShell(`npx -y repomix --compress --include "${include}" --style xml --output "${out}"`);
      if (r.timedOut) return fail('repomix timeout', true);
      if (!fs.existsSync(out)) return fail('repomix no disponible');
      const text = fs.readFileSync(out, 'utf-8');
      try {
        fs.unlinkSync(out);
      } catch {
        /* ignore */
      }
      return { text, tokens: tokens(text), timedOut: false, available: true };
    }
    case 'BASELINE':
    default: {
      const b = measureBaseline(t);
      return { ...b, available: true };
    }
  }
}

function gatePassed(t: Escenario, optimizedText: string): boolean {
  if (t.requiredArtifacts.length === 0) return true; // sin gate
  return t.requiredArtifacts.some((re) => new RegExp(re).test(optimizedText));
}

async function main() {
  const args = process.argv.slice(2);
  const repIdx = args.indexOf('--repetitions');
  const repetitions = repIdx >= 0 && args[repIdx + 1] ? parseInt(args[repIdx + 1], 10) : 2;
  const modelIdx = args.indexOf('--model');
  const model = modelIdx >= 0 && args[modelIdx + 1] ? args[modelIdx + 1] : 'glm-5.2';

  console.log('===============================================================');
  console.log('BENCHMARK REAL - baseline minimo + puerta de calidad');
  console.log('===============================================================');
  console.log(`Modelo: ${model} | Repeticiones: ${repetitions}`);
  console.log('');

  fs.mkdirSync(RESULTADOS_DIR, { recursive: true });
  const historyPath = path.join(RESULTADOS_DIR, 'real-history.json');
  if (fs.existsSync(historyPath)) fs.rmSync(historyPath);
  const router = createAdaptiveRouter({ historyPath, enableExploration: false });

  interface Fila {
    id: string;
    nombre: string;
    taskType: string;
    optimizer: Optimizer;
    routerPick: Optimizer;
    baselineTokens: number | null;
    optimizedTokens: number | null;
    ahorroPct: number | null;
    gate: boolean;
    nota: string;
  }
  const filas: Fila[] = [];

  for (const t of ESCENARIOS) {
    const ctx = buildContextFromQuery(model, t.query, {
      fileCount: t.archivos.length,
      contextSizeBytes: t.archivos.reduce(
        (a, rel) => a + (fs.existsSync(path.join(ROOT, rel)) ? fs.statSync(path.join(ROOT, rel)).size : 0),
        0,
      ),
      hasTerminalCommands: Boolean(t.comando),
      isRefactor: t.taskType === 'REFACTOR',
      isRepositorySearch: t.taskType === 'REPOSITORY_SEARCH',
    });
    const routerPick = (await router.route(ctx)).optimizer;

    const baseTokensList: number[] = [];
    const optTokensList: number[] = [];
    let baseTimedOut = false;
    let opt: Medida = { text: '', tokens: 0, timedOut: false, available: true };
    let baselineText = '';

    for (let i = 0; i < repetitions; i++) {
      const b = measureBaseline(t);
      baselineText = b.text;
      if (b.timedOut) baseTimedOut = true;
      baseTokensList.push(b.tokens);
      opt = measureOptimized(t);
      optTokensList.push(opt.tokens);
    }

    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const baseMean = Math.round(avg(baseTokensList));
    const optMean = Math.round(avg(optTokensList));
    const gate = opt.available && gatePassed(t, opt.text);
    let ahorro: number | null = null;
    let nota = '';
    if (baseTimedOut) nota = 'timeout baseline';
    else if (!opt.available) nota = opt.error ?? 'optimizador no disponible';
    else if (!gate) nota = 'gate: falta informacion requerida';
    else if (baseMean > 0) ahorro = +(((baseMean - optMean) / baseMean) * 100).toFixed(1);

    console.log(`[${t.id}] ${t.nombre}`);
    console.log(`   router=${routerPick} optimizador-medido=${t.optimizer} baseline=${baseMean}t optimizado=${optMean}t gate=${gate ? 'OK' : 'FALLA'} ahorro=${ahorro === null ? 'N/D' : ahorro + '%'}${nota ? ' (' + nota + ')' : ''}`);

    filas.push({
      id: t.id,
      nombre: t.nombre,
      taskType: analyzeTask(ctx.signals).taskType,
      optimizer: t.optimizer,
      routerPick,
      baselineTokens: baseTimedOut ? null : baseMean,
      optimizedTokens: gate ? optMean : null,
      ahorroPct: ahorro,
      gate,
      nota,
    });
  }

  const validas = filas.filter((f) => f.ahorroPct !== null);
  const totalBase = validas.reduce((a, f) => a + (f.baselineTokens ?? 0), 0);
  const totalOpt = validas.reduce((a, f) => a + (f.optimizedTokens ?? 0), 0);
  const globalPct = totalBase > 0 ? +(((totalBase - totalOpt) / totalBase) * 100).toFixed(1) : 0;
  // Media simple por tarea: robusta frente a una tarea con baseline desproporcionado.
  const mediaPct = validas.length
    ? +(validas.reduce((a, f) => a + (f.ahorroPct ?? 0), 0) / validas.length).toFixed(1)
    : 0;

  const datos = {
    model,
    repetitions,
    fecha: new Date().toISOString(),
    metodologia:
      'Baseline minimo suficiente; puerta de calidad (artefactos requeridos); timeouts excluidos.',
    filas,
    global: {
      tareasMedibles: validas.length,
      totalTareas: filas.length,
      baseTokens: totalBase,
      optTokens: totalOpt,
      ahorroPct: globalPct,
      ahorroMedioPct: mediaPct,
    },
  };
  fs.writeFileSync(DATOS_PATH, JSON.stringify(datos, null, 2), 'utf-8');

  let md = `# Benchmark real de ahorro de tokens\n\n`;
  md += `**Modelo:** \`${model}\` | **Repeticiones:** ${repetitions} | **Fecha:** ${datos.fecha}\n\n`;
  md += `**Metodologia:** baseline minimo suficiente (comando natural / lectura completa / grep); `;
  md += `puerta de calidad (la salida del optimizador debe contener la informacion requerida); `;
  md += `timeouts excluidos. El ahorro solo cuenta en tareas que pasan la puerta.\n\n`;
  md += `## Resumen\n\n`;
  md += `- Tareas con ahorro valido: **${validas.length}/${filas.length}**\n`;
  md += `- Tokens baseline (suma de tareas validas): **${totalBase.toLocaleString()}**\n`;
  md += `- Tokens optimizados (suma): **${totalOpt.toLocaleString()}**\n`;
  md += `- **Ahorro medio por tarea: ${mediaPct}%** (metrica robusta, recomendada)\n`;
  md += `- Ahorro ponderado por tokens: ${globalPct}% (depende de la mezcla; una tarea con baseline grande puede dominarlo)\n\n`;
  md += `## Detalle\n\n`;
  md += `| ID | Tarea | Tipo | Optimizador | Router (frio) | Baseline | Optimizado | Gate | Ahorro |\n`;
  md += `|:---|:---|:---|:---|:---|---:|---:|:---:|---:|\n`;
  for (const f of filas) {
    md += `| ${f.id} | ${f.nombre} | ${f.taskType} | ${f.optimizer} | ${f.routerPick} | ${f.baselineTokens ?? 'N/D'} | ${f.optimizedTokens ?? 'N/D'} | ${f.gate ? 'OK' : 'FALLA'} | ${f.ahorroPct === null ? 'N/D' : f.ahorroPct + '%'} |\n`;
  }
  md += `\n> "N/D" = no cuenta para el ahorro (timeout, optimizador no disponible o gate de calidad no superado).\n`;
  fs.writeFileSync(REPORTE_PATH, md, 'utf-8');

  console.log('\n===============================================================');
  console.log(`Ahorro medio por tarea: ${mediaPct}% | ponderado: ${globalPct}% (${validas.length}/${filas.length} tareas validas)`);
  console.log(`Reporte: ${REPORTE_PATH}`);
  console.log('===============================================================');
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
