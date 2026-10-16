#!/usr/bin/env node
/**
 * run-e2e.ts - Benchmark END-TO-END con metricas reales del modelo.
 *
 * Ejecuta cada tarea con `opencode run --format json` en dos condiciones
 * (baseline vs optimized) y extrae, por ejecucion, datos REALES reportados por
 * opencode/modelo:
 *   - tokens de entrada, salida y totales (por paso y agregados)
 *   - coste (USD) real
 *   - numero de llamadas al modelo (pasos)
 *   - numero de tool calls
 *   - respuesta final y traza completa (JSON de eventos)
 *
 * Repite N veces cada tarea para medir variabilidad (media, desv, min, max).
 *
 * Uso:
 *   npx tsx pruebas_v3/run-e2e.ts [--repetitions 3] [--tasks E1,E2]
 *
 * NOTA: ejecuta el modelo real (consume tokens/coste). Las tareas son de solo
 * lectura para no modificar el repositorio.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { computeCostUsd } from '../src/pricing/model-pricing';
import { extractModelFamily } from '../src/index';

const ROOT = path.resolve(__dirname, '..');
const MODEL = process.env.E2E_MODEL ?? 'glm-5.2';
const OPENCODE_JSON = path.join(ROOT, 'opencode.json');
const BASELINE_CONFIG = path.join(ROOT, 'opencode.baseline.json');
const OPTIMIZER_CONFIG = path.join(ROOT, 'opencode.optimizer.json');
const BACKUP_CONFIG = path.join(ROOT, 'opencode.json.e2e-backup');
const RESULTADOS_DIR = path.join(__dirname, 'resultados');
const TRACES_DIR = path.join(RESULTADOS_DIR, 'traces');
const DATOS_PATH = path.join(RESULTADOS_DIR, 'resultados-e2e.json');
const REPORTE_PATH = path.join(RESULTADOS_DIR, 'reporte-e2e.md');

interface Tarea {
  id: string;
  prompt: string;
  /** Regex que debe aparecer en la respuesta para considerar la tarea completada. */
  artifact: string;
}

const TAREAS: Tarea[] = [
  {
    id: 'E1',
    prompt:
      'Localiza en que archivo de src se define la funcion normalizeModel. Responde solo con la ruta del archivo.',
    artifact: 'model-family',
  },
  {
    id: 'E2',
    prompt:
      'Lista las clases y funciones exportadas de los archivos de src/history. Responde en pocas lineas.',
    artifact: 'RouterEventStore|JsonHistoryStore|migrateV1ToV2',
  },
  {
    id: 'E3',
    prompt: 'Ejecuta git log --oneline -3 y responde con los tres mensajes de commit.',
    artifact: '.',
  },
];

type Condicion = 'BASELINE' | 'OPTIMIZED';

interface Metricas {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  modelCalls: number;
  toolCalls: number;
  answer: string;
  completed: boolean;
  timedOut: boolean;
  error?: string;
  durationMs: number;
}

interface Ejecucion extends Metricas {
  taskId: string;
  condition: Condicion;
  rep: number;
}

function runOpencode(
  prompt: string,
  timeoutMs: number,
  model?: string,
): { raw: string; durationMs: number; timedOut: boolean } {
  // Se pasa el prompt entre comillas dobles; no contiene comillas internas.
  const modelArg = model ? ` -m ${model}` : '';
  const cmd = `opencode run "${prompt.replace(/"/g, '')}" --format json --auto${modelArg}`;
  const start = Date.now();
  const res = spawnSync(cmd, {
    cwd: ROOT,
    encoding: 'utf-8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const timedOut =
    (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM';
  return { raw: res.stdout || '', durationMs: Date.now() - start, timedOut };
}

function parseMetrics(raw: string, artifact: string, timedOut: boolean, durationMs: number): Metricas {
  const events: any[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      events.push(JSON.parse(s));
    } catch {
      /* linea no-JSON (ANSI/log): ignorar */
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costUsd = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let answer = '';

  for (const e of events) {
    if (e.type === 'step_finish' && e.part?.tokens) {
      inputTokens += e.part.tokens.input || 0;
      outputTokens += e.part.tokens.output || 0;
      totalTokens += e.part.tokens.total || 0;
      costUsd += e.part.cost || 0;
      modelCalls += 1;
    }
    if (e.type === 'tool') toolCalls += 1;
    if (e.type === 'text' && e.part?.text) answer += e.part.text;
  }

  const completed = artifact === '.' ? answer.length > 0 : new RegExp(artifact, 'i').test(answer);

  // Coste: usar el reportado por el proveedor; si es 0 (p. ej. klia no lo
  // devuelve), estimarlo con la tabla de pricing del proyecto.
  const costEstimated = computeCostUsd(inputTokens, outputTokens, MODEL, extractModelFamily(MODEL));
  const costFinal = costUsd > 0 ? costUsd : costEstimated;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: costFinal,
    modelCalls,
    toolCalls,
    answer: answer.trim(),
    completed,
    timedOut,
    durationMs,
  };
}

function useConfig(configPath: string): void {
  fs.copyFileSync(OPENCODE_JSON, BACKUP_CONFIG);
  fs.copyFileSync(configPath, OPENCODE_JSON);
}

function restoreConfig(): void {
  if (fs.existsSync(BACKUP_CONFIG)) {
    fs.copyFileSync(BACKUP_CONFIG, OPENCODE_JSON);
    try {
      fs.unlinkSync(BACKUP_CONFIG);
    } catch {
      /* ignore */
    }
  }
}

function stats(values: number[]): { mean: number; std: number; min: number; max: number } {
  if (values.length === 0) return { mean: 0, std: 0, min: 0, max: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return {
    mean: +mean.toFixed(1),
    std: +Math.sqrt(variance).toFixed(1),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const repIdx = args.indexOf('--repetitions');
  const repetitions = repIdx >= 0 && args[repIdx + 1] ? parseInt(args[repIdx + 1], 10) : 1;
  const tasksIdx = args.indexOf('--tasks');
  const selected = tasksIdx >= 0 && args[tasksIdx + 1] ? args[tasksIdx + 1].split(',') : null;
  const tareas = selected ? TAREAS.filter((t) => selected.includes(t.id)) : TAREAS;
  const timeoutIdx = args.indexOf('--timeout');
  const timeoutMs = timeoutIdx >= 0 && args[timeoutIdx + 1] ? parseInt(args[timeoutIdx + 1], 10) : 45_000;
  const modelIdx = args.indexOf('--model');
  const model = modelIdx >= 0 && args[modelIdx + 1] ? args[modelIdx + 1] : undefined;
  const maxIdx = args.indexOf('--max-minutes');
  const maxMinutes = maxIdx >= 0 && args[maxIdx + 1] ? parseFloat(args[maxIdx + 1]) : 5;
  const startWall = Date.now();
  const budgetMs = maxMinutes * 60_000;

  console.log('===============================================================');
  console.log('BENCHMARK END-TO-END - metricas reales (tokens/coste/pasos)');
  console.log('===============================================================');
  console.log(`Tareas: ${tareas.map((t) => t.id).join(', ')} | Repeticiones: ${repetitions}`);
  console.log(`Timeout por ejecucion: ${timeoutMs / 1000}s | Modelo: ${model ?? 'por defecto'}`);
  console.log(`Presupuesto total: ${maxMinutes} min (se omiten ejecuciones si se agota)`);
  console.log(`Ejecuciones totales: ${tareas.length * 2 * repetitions}`);
  console.log('');

  fs.mkdirSync(RESULTADOS_DIR, { recursive: true });
  fs.mkdirSync(TRACES_DIR, { recursive: true });

  const ejecuciones: Ejecucion[] = [];
  const condiciones: Condicion[] = ['BASELINE', 'OPTIMIZED'];

  try {
    for (const cond of condiciones) {
      console.log(`\n===== CONDICION ${cond} =====`);
      useConfig(cond === 'BASELINE' ? BASELINE_CONFIG : OPTIMIZER_CONFIG);
      // Dar tiempo a que opencode relea la config.
      await new Promise((r) => setTimeout(r, 3000));

      for (const t of tareas) {
        for (let rep = 1; rep <= repetitions; rep++) {
          const elapsed = Date.now() - startWall;
          if (elapsed >= budgetMs) {
            console.log(
              `   [${cond}] ${t.id} rep ${rep}/${repetitions} ... OMITIDA (presupuesto ${maxMinutes} min agotado)`,
            );
            ejecuciones.push({
              taskId: t.id,
              condition: cond,
              rep,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              costUsd: 0,
              modelCalls: 0,
              toolCalls: 0,
              answer: '',
              completed: false,
              timedOut: false,
              error: 'skipped:budget',
              durationMs: 0,
            });
            continue;
          }
          const runTimeout = Math.min(timeoutMs, budgetMs - elapsed);
          process.stdout.write(`   [${cond}] ${t.id} rep ${rep}/${repetitions} ... `);
          const { raw, durationMs, timedOut } = runOpencode(t.prompt, runTimeout, model);
          const m = parseMetrics(raw, t.artifact, timedOut, durationMs);
          ejecuciones.push({ taskId: t.id, condition: cond, rep, ...m });

          const tracePath = path.join(TRACES_DIR, `${cond}-${t.id}-rep${rep}.jsonl`);
          fs.writeFileSync(tracePath, raw, 'utf-8');

          console.log(
            `tokens=${m.totalTokens} (in=${m.inputTokens} out=${m.outputTokens}) coste=$${m.costUsd.toFixed(6)} llamadas=${m.modelCalls} tools=${m.toolCalls} ok=${m.completed}${timedOut ? ' TIMEOUT' : ''}`,
          );
        }
      }
    }
  } finally {
    restoreConfig();
  }

  // Agregados por (tarea, condicion)
  interface Fila {
    taskId: string;
    cond: Condicion;
    tokens: { mean: number; std: number; min: number; max: number };
    input: number;
    output: number;
    costMean: number;
    callsMean: number;
    toolsMean: number;
    completedRate: number;
  }
  const filas: Fila[] = [];
  for (const t of tareas) {
    for (const cond of condiciones) {
      const runs = ejecuciones.filter((e) => e.taskId === t.id && e.condition === cond);
      if (runs.length === 0) continue;
      filas.push({
        taskId: t.id,
        cond,
        tokens: stats(runs.map((r) => r.totalTokens)),
        input: Math.round(runs.reduce((a, r) => a + r.inputTokens, 0) / runs.length),
        output: Math.round(runs.reduce((a, r) => a + r.outputTokens, 0) / runs.length),
        costMean: +(runs.reduce((a, r) => a + r.costUsd, 0) / runs.length).toFixed(6),
        callsMean: +(runs.reduce((a, r) => a + r.modelCalls, 0) / runs.length).toFixed(1),
        toolsMean: +(runs.reduce((a, r) => a + r.toolCalls, 0) / runs.length).toFixed(1),
        completedRate: +(runs.filter((r) => r.completed).length / runs.length).toFixed(2),
      });
    }
  }

  // Global: suma de medias por tarea, solo tareas completadas en ambas condiciones.
  const validTasks = tareas.filter((t) => {
    const b = filas.find((f) => f.taskId === t.id && f.cond === 'BASELINE');
    const o = filas.find((f) => f.taskId === t.id && f.cond === 'OPTIMIZED');
    return b && o && b.completedRate > 0 && o.completedRate > 0;
  });
  const sumBase = validTasks.reduce(
    (a, t) => a + (filas.find((f) => f.taskId === t.id && f.cond === 'BASELINE')?.tokens.mean ?? 0),
    0,
  );
  const sumOpt = validTasks.reduce(
    (a, t) => a + (filas.find((f) => f.taskId === t.id && f.cond === 'OPTIMIZED')?.tokens.mean ?? 0),
    0,
  );
  const sumCostBase = validTasks.reduce(
    (a, t) => a + (filas.find((f) => f.taskId === t.id && f.cond === 'BASELINE')?.costMean ?? 0),
    0,
  );
  const sumCostOpt = validTasks.reduce(
    (a, t) => a + (filas.find((f) => f.taskId === t.id && f.cond === 'OPTIMIZED')?.costMean ?? 0),
    0,
  );
  const tokenSavings = sumBase > 0 ? +(((sumBase - sumOpt) / sumBase) * 100).toFixed(1) : 0;
  const costSavings = sumCostBase > 0 ? +(((sumCostBase - sumCostOpt) / sumCostBase) * 100).toFixed(1) : 0;

  const datos = {
    fecha: new Date().toISOString(),
    repetitions,
    tareas: TAREAS.map((t) => ({ id: t.id, prompt: t.prompt, artifact: t.artifact })),
    ejecuciones,
    filas,
    global: {
      tareasValidas: validTasks.length,
      totalTareas: tareas.length,
      sumBaseTokens: Math.round(sumBase),
      sumOptTokens: Math.round(sumOpt),
      ahorroTokensPct: tokenSavings,
      sumCostBaseUsd: +sumCostBase.toFixed(6),
      sumCostOptUsd: +sumCostOpt.toFixed(6),
      ahorroCostePct: costSavings,
    },
  };
  fs.writeFileSync(DATOS_PATH, JSON.stringify(datos, null, 2), 'utf-8');

  // Reporte
  let md = `# Benchmark end-to-end: ahorro real (tokens, coste, pasos)\n\n`;
  md += `**Fecha:** ${datos.fecha} | **Repeticiones por tarea:** ${repetitions}\n\n`;
  md += `**Metodologia:** \`opencode run --format json\` en dos condiciones. `;
  md += `BASELINE = optimizadores desactivados (semble/repomix/serena off). `;
  md += `OPTIMIZED = activados. Metricas reportadas por opencode/modelo (no estimadas). `;
  md += `Tareas de solo lectura.\n\n`;

  md += `## Tokens por tarea (media de ${repetitions} ejecuciones)\n\n`;
  md += `| Tarea | Cond. | Entrada | Salida | Total (media) | Desv | Min | Max | Llamadas | Tools | Completada |\n`;
  md += `|:---|:---|---:|---:|---:|---:|---:|---:|---:|---:|:---:|\n`;
  for (const f of filas) {
    md += `| ${f.taskId} | ${f.cond} | ${f.input} | ${f.output} | ${f.tokens.mean} | ${f.tokens.std} | ${f.tokens.min} | ${f.tokens.max} | ${f.callsMean} | ${f.toolsMean} | ${(f.completedRate * 100).toFixed(0)}% |\n`;
  }

  md += `\n## Coste (USD, media por ejecucion)\n\n`;
  md += `| Tarea | Coste BASELINE | Coste OPTIMIZED |\n|:---|---:|---:|\n`;
  for (const t of tareas) {
    const b = filas.find((f) => f.taskId === t.id && f.cond === 'BASELINE')?.costMean ?? 0;
    const o = filas.find((f) => f.taskId === t.id && f.cond === 'OPTIMIZED')?.costMean ?? 0;
    md += `| ${t.id} | $${b.toFixed(6)} | $${o.toFixed(6)} |\n`;
  }

  md += `\n## Ahorro global (tareas completadas en ambas condiciones: ${validTasks.length}/${tareas.length})\n\n`;
  md += `- Tokens BASELINE (suma de medias): **${Math.round(sumBase).toLocaleString()}**\n`;
  md += `- Tokens OPTIMIZED (suma de medias): **${Math.round(sumOpt).toLocaleString()}**\n`;
  md += `- **Ahorro de tokens: ${tokenSavings}%**\n`;
  md += `- Coste BASELINE: $${sumCostBase.toFixed(6)} | OPTIMIZED: $${sumCostOpt.toFixed(6)}\n`;
  md += `- **Ahorro de coste: ${costSavings}%**\n\n`;

  md += `## Trazabilidad\n\n`;
  md += `- Trazas completas (eventos JSON por ejecucion): \`pruebas_v3/resultados/traces/\`\n`;
  md += `- Datos crudos: \`pruebas_v3/resultados/resultados-e2e.json\`\n`;
  md += `- Tokenizacion: tokens reportados por el proveedor a traves de opencode (\`step_finish.tokens\`), no estimados.\n`;
  fs.writeFileSync(REPORTE_PATH, md, 'utf-8');

  console.log('\n===============================================================');
  console.log(`Ahorro tokens: ${tokenSavings}% | Ahorro coste: ${costSavings}% (${validTasks.length}/${tareas.length} tareas validas)`);
  console.log(`Reporte: ${REPORTE_PATH}`);
  console.log('===============================================================');
}

main().catch((err) => {
  console.error('Error fatal:', err);
  restoreConfig();
  process.exit(1);
});
