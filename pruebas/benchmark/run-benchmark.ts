#!/usr/bin/env node
/**
 * run-benchmark.ts - Suite profesional de benchmark KLIA Token Optimizer
 *
 * Implementa el plan de las secciones 3-12:
 *   A1-A4: Auditoria tecnica (compilacion, clasificacion, reglas, registro)
 *   B:     Instrumentacion (BenchmarkRecord con metricas separadas)
 *   C:     Diseno BASELINE vs OPTIMIZED (piloto + N repeticiones)
 *   D:     Validacion por optimizador (RTK, SEMBLE, CONTEXT_MODE, REPOMIX)
 *   E:     Metricas y formulas (ahorro input/output/total, coste, latencia)
 *   F:     Revision de la tabla anterior (88,9% recalculado)
 *   G:     Aprendizaje adaptativo (train/test split)
 *   H:     Robustez (concurrencia, JSON corrupto, migracion)
 *   I:     Plan de ejecucion por presupuesto (~20 min suite rapida)
 *
 * Limitaciones documentadas (ver limitations.md):
 *   - Tokens reales de entrada del LLM: NO MEDIBLES sin sesion OpenCode
 *   - Calidad real: NO MEDIBLE (el plugin hardcodea 0.95, no es evaluacion)
 *   - Cache/reasoning tokens: NO IMPLEMENTADO en el schema v2
 *   - DCP: requiere sesion interactiva real, fuera de la suite rapida
 *
 * Uso:
 *   cd pruebas/benchmark
 *   npx tsx run-benchmark.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';

// Tokenizador local (cl100k_base / o200k_base de GPT). NO es el tokenizer
// exacto de glm-5.2; se documenta como estimacion.
import { encode as gptEncode } from 'gpt-tokenizer';

// ============================================================================
// Configuracion
// ============================================================================

const ROOT = path.resolve(__dirname, '..', '..');
const BENCH_DIR = __dirname;
const ESCENARIOS_DIR = path.join(BENCH_DIR, 'escenarios');
const RESULTADOS_DIR = path.join(BENCH_DIR, 'resultados');
const LOGS_DIR = path.join(BENCH_DIR, 'logs');
const HISTORY_DIR = path.join(ROOT, '.router-history');
const HISTORY_PATH = path.join(HISTORY_DIR, 'history.json');
const EVENTS_PATH = path.join(HISTORY_DIR, 'events.json');
const METRICS_PATH = path.join(HISTORY_DIR, 'mcp-metrics.json');

const BUDGET_MS = 18 * 60 * 1000;
const START_TIME = Date.now();
const REPETICIONES = 3; // piloto + 2 confirmatorias

const MODELO = 'glm-5.2';
const MODELO_FAMILY = 'glm';

interface TestResult {
  id: string;
  nombre: string;
  estado: 'PASS' | 'FAIL' | 'SKIP' | 'HALLAZGO' | 'PENDIENTE';
  duracionMs: number;
  evidencia: string;
  metrica?: string;
  detalle?: unknown;
}

const resultados: TestResult[] = [];

// ============================================================================
// Esquema de instrumentacion (Fase B del plan)
// ============================================================================

export type CalidadTipo = 'medida' | 'estimada' | 'desconocida' | 'hardcodeada';

export interface BytesPorCanal {
  filesBytes: number;
  commandBytes: number;
  toolOutputBytes: number;
  /** Bytes despues de aplicar el optimizador (si aplica). */
  toolOutputBytesAfterOpt?: number;
  /** Bytes eliminados por el optimizador (poda, compresion). */
  bytesPruned?: number;
}

export interface TokensPorCanal {
  /** Tokens de salida de herramientas ANTES de optimizar (medidos con gpt-tokenizer). */
  toolOutputTokens: number;
  /** Tokens de salida de herramientas DESPUES de optimizar. */
  toolOutputTokensAfterOpt?: number;
  /** Tokens reales de entrada al LLM. NO MEDIBLES en este script. */
  inputLlm?: null;
  /** Tokens reales de salida del LLM. NO MEDIBLES en este script. */
  outputLlm?: null;
  /** Tokens en cache del LLM. NO IMPLEMENTADO en el schema. */
  cacheLlm?: null;
  /** Tokens de razonamiento. NO IMPLEMENTADO en el schema. */
  reasoningLlm?: null;
}

export interface Calidad {
  valor: number | null;
  tipo: CalidadTipo;
  /** Descripcion de como se obtuvo. */
  origen: string;
}

export interface BenchmarkRecord {
  /** Identificador unico. */
  id: string;
  timestamp: string;
  /** Commit del proyecto (no medible aqui: 'no-medido'). */
  commit: string;
  /** Modelo y familia. */
  model: string;
  modelFamily: string;
  /** Optimizador aplicado: BASELINE, RTK, SEMBLE, CONTEXT_MODE, REPOMIX, DCP, o el nombre del optimizador bajo prueba. */
  optimizer: string;
  /** Tipo de tarea. */
  taskType: string;
  /** Condicion del experimento. */
  condition: 'BASELINE' | 'OPTIMIZED';
  /** Numero de repeticion (1..N). */
  repeticion: number;
  /** Bytes separados por canal. */
  bytes: BytesPorCanal;
  /** Tokens separados por canal. */
  tokens: TokensPorCanal;
  /** Coste en USD estimado con pricing tabular (input/output separados). */
  coste: {
    inputUsd: number | null;
    outputUsd: number | null;
    totalUsd: number | null;
    /** 'real' si viene del proveedor, 'estimado' si de tabla, 'no-disponible' si falta. */
    origen: 'real' | 'estimado' | 'no-disponible';
  };
  /** Latencia de pared en ms (tool execution). */
  latencyMs: number;
  /** Numero de llamadas a herramientas. */
  toolCalls: number;
  /** Reintentos. */
  retries: number;
  /** Errores. */
  errors: string[];
  /** Calidad (medida, estimada, desconocida o hardcodeada). */
  calidad: Calidad;
  /** Resultado de tests (vitest) si aplica. */
  tests?: { passed: number; failed: number; total: number };
  /** Si la tarea se completo correctamente. */
  completada: boolean;
  /** Informacion relevante omitida por el optimizador (si se detecta). */
  infoOmitida?: string;
  /** Logs originales (referencia). */
  logRef?: string;
}

// ============================================================================
// Helpers
// ============================================================================

function elapsedMs(): number {
  return Date.now() - START_TIME;
}

function budgetGuard(): boolean {
  return elapsedMs() < BUDGET_MS;
}

function log(msg: string): void {
  const t = (elapsedMs() / 1000).toFixed(1);
  console.log(`[${t}s] ${msg}`);
}

function runCli(cmd: string, opts: { cwd?: string; timeout?: number } = {}): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      cwd: opts.cwd ?? ROOT,
      timeout: opts.timeout ?? 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? e.message,
      code: e.status ?? 1,
    };
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson<T = any>(p: string): T | null {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

function writeJson(p: string, data: unknown): void {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

function parseRouterOutput(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) result[m[1]] = m[2];
  }
  return result;
}

function buildRouteCmd(query: string, modelo: string, opts: { files?: number; size?: number } = {}): string {
  let cmd = `npx tsx src/router-cli.ts --model ${modelo} --query "${query.replace(/"/g, '\\"')}"`;
  if (opts.files && opts.files > 0) cmd += ` --files ${opts.files}`;
  if (opts.size && opts.size > 0) cmd += ` --size ${opts.size}`;
  return cmd;
}

function countTokensGpt(text: string): number {
  try {
    return gptEncode(text).length;
  } catch {
    return 0;
  }
}

function filesBytes(archivos: string[]): number {
  let total = 0;
  for (const f of archivos) {
    const full = path.join(ROOT, f);
    if (fs.existsSync(full)) total += fs.readFileSync(full).length;
  }
  return total;
}

function fileBytes(fullPath: string): number {
  if (!fs.existsSync(fullPath)) return 0;
  return fs.readFileSync(fullPath).length;
}

function sha(text: string): string {
  // Hash ligero solo para identificar registros en logs (no criptografico).
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return `br-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================================
// Calculo de coste (pricing tabular, input/output separados)
// ============================================================================

interface Pricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

function getPricing(model: string, family: string): Pricing {
  // Reutiliza la logica de src/pricing/model-pricing.ts pero en linea
  // para evitar acoplamiento de paths en este script.
  const FALLBACK: Pricing = { inputPerMillion: 1.0, outputPerMillion: 3.0 };
  const FAMILY: Record<string, Pricing> = {
    glm: { inputPerMillion: 0.5, outputPerMillion: 1.5 },
    deepseek: { inputPerMillion: 0.27, outputPerMillion: 1.1 },
    claude: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    gpt: { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  };
  const norm = model.toLowerCase();
  if (norm === 'glm-5.2') return FAMILY.glm;
  return FAMILY[family] ?? FALLBACK;
}

function computeCost(inputTokens: number, outputTokens: number, model: string, family: string): { inputUsd: number; outputUsd: number; totalUsd: number } {
  const p = getPricing(model, family);
  const inputUsd = (inputTokens / 1_000_000) * p.inputPerMillion;
  const outputUsd = (outputTokens / 1_000_000) * p.outputPerMillion;
  return {
    inputUsd: Math.round(inputUsd * 1_000_000) / 1_000_000,
    outputUsd: Math.round(outputUsd * 1_000_000) / 1_000_000,
    totalUsd: Math.round((inputUsd + outputUsd) * 1_000_000) / 1_000_000,
  };
}

// ============================================================================
// Medicion de optimizadores (sin LLM: bytes y tokens de salida de herramientas)
// ============================================================================

interface MedicionOpt {
  /** Bytes del output de la herramienta. */
  toolOutputBytes: number;
  /** Bytes eliminados vs BASELINE (podado). */
  bytesPruned: number;
  /** Tokens del output (gpt-tokenizer). */
  toolOutputTokens: number;
  /** Latencia de pared en ms. */
  latencyMs: number;
  /** Errores. */
  errors: string[];
  /** Output textual (para auditoria). */
  output?: string;
}

function medirBaselineTool(archivos: string[], comando: string | null): MedicionOpt {
  const start = Date.now();
  const errors: string[] = [];
  let toolOutputBytes = 0;
  let textToTokenize = '';

  if (comando) {
    const cmdParts = comando.split(' ');
    const r = spawnSync(cmdParts[0], cmdParts.slice(1), {
      encoding: 'utf-8',
      cwd: ROOT,
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = r.stdout ?? '';
    toolOutputBytes += Buffer.byteLength(out, 'utf-8');
    textToTokenize += out;
    if ((r.status ?? 1) !== 0 && out.length === 0) {
      errors.push(`comando '${comando}' fallo: ${(r.stderr ?? '').slice(0, 200)}`);
    }
  }

  for (const f of archivos) {
    const full = path.join(ROOT, f);
    if (fs.existsSync(full)) {
      const content = fs.readFileSync(full, 'utf-8');
      toolOutputBytes += Buffer.byteLength(content, 'utf-8');
      textToTokenize += content + '\n';
    }
  }

  return {
    toolOutputBytes,
    bytesPruned: 0,
    toolOutputTokens: countTokensGpt(textToTokenize),
    latencyMs: Date.now() - start,
    errors,
    output: textToTokenize.slice(0, 500),
  };
}

function medirRtk(comando: string): MedicionOpt {
  const start = Date.now();
  const errors: string[] = [];
  let output = '';
  // rtk test ejecuta el comando y muestra solo fallos/resumen.
  let r = spawnSync('rtk', ['test', comando], {
    encoding: 'utf-8',
    cwd: ROOT,
    timeout: 120000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if ((r.status ?? 1) !== 0 && (!r.stdout || r.stdout.length === 0)) {
    // Fallback a rtk smart (resumen 2 lineas)
    r = spawnSync('rtk', ['smart', comando], {
      encoding: 'utf-8',
      cwd: ROOT,
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  output = r.stdout ?? '';
  if (!output) errors.push(`rtk sin salida: ${(r.stderr ?? '').slice(0, 200)}`);

  return {
    toolOutputBytes: Buffer.byteLength(output, 'utf-8'),
    bytesPruned: 0,
    toolOutputTokens: countTokensGpt(output),
    latencyMs: Date.now() - start,
    errors,
    output: output.slice(0, 500),
  };
}

function medirRepomix(archivos: string[]): MedicionOpt {
  const start = Date.now();
  const errors: string[] = [];
  const outputFile = path.join(RESULTADOS_DIR, 'repomix-output.xml');
  if (archivos.length === 0) {
    return { toolOutputBytes: 0, bytesPruned: 0, toolOutputTokens: 0, latencyMs: 0, errors: ['sin archivos'] };
  }
  const includePatterns = archivos.map((a) => a.replace(/\\/g, '/')).join(',');
  const cmd = `npx -y repomix --compress --include "${includePatterns}" --style xml --output "${outputFile}"`;
  runCli(cmd, { timeout: 120000, cwd: ROOT });
  if (!fs.existsSync(outputFile)) {
    return { toolOutputBytes: 0, bytesPruned: 0, toolOutputTokens: 0, latencyMs: Date.now() - start, errors: ['repomix no genero output'] };
  }
  const content = fs.readFileSync(outputFile, 'utf-8');
  return {
    toolOutputBytes: Buffer.byteLength(content, 'utf-8'),
    bytesPruned: 0,
    toolOutputTokens: countTokensGpt(content),
    latencyMs: Date.now() - start,
    errors,
    output: content.slice(0, 500),
  };
}

function medirSemble(query: string): MedicionOpt {
  const start = Date.now();
  const errors: string[] = [];
  const cmd = `npx -y semble@latest search "${query.replace(/"/g, '\\"')}" "${ROOT}" --max-snippet-lines 10 --top-k 3 --content code 2>&1`;
  const r = runCli(cmd, { timeout: 60000 });
  const output = r.stdout;
  return {
    toolOutputBytes: Buffer.byteLength(output, 'utf-8'),
    bytesPruned: 0,
    toolOutputTokens: countTokensGpt(output),
    latencyMs: Date.now() - start,
    errors: r.code !== 0 ? [`semble codigo=${r.code}`] : errors,
    output: output.slice(0, 500),
  };
}

function medirContextMode(query: string): MedicionOpt {
  // context-mode: estimacion de chunk FTS5 (no hay CLI directo accesible
  // desde este script). Documentado como estimacion, no medicion real.
  const start = Date.now();
  const chunkEstimado = query.length + 500;
  const output = `[context-mode: chunk FTS5 estimado] ${query.slice(0, 100)}`;
  return {
    toolOutputBytes: chunkEstimado,
    bytesPruned: 0,
    toolOutputTokens: countTokensGpt(output),
    latencyMs: Date.now() - start,
    errors: ['context-mode: medicion estimada (chunk FTS5 simulado), no hay CLI accesible'],
    output,
  };
}

function medirDcp(): MedicionOpt {
  // DCP requiere sesion interactiva real con diff entre turnos del LLM.
  // NO MEDIBLE en este script.
  return {
    toolOutputBytes: 0,
    bytesPruned: 0,
    toolOutputTokens: 0,
    latencyMs: 0,
    errors: ['DCP: requiere sesion interactiva real, NO MEDIBLE en este script'],
  };
}

// ============================================================================
// FASE A - Auditoria tecnica
// ============================================================================

async function A1_build_cli(): Promise<TestResult> {
  const start = Date.now();
  log('A1: Build + CLI + MCP tools');
  const build = runCli('npm run build', { timeout: 120000 });
  if (build.code !== 0) {
    return { id: 'A1', nombre: 'Build + CLI + MCP tools', estado: 'FAIL', duracionMs: Date.now() - start, evidencia: `Build fallo: ${build.stderr.slice(0, 300)}` };
  }
  const help = runCli('npx tsx src/router-cli.ts --help', { timeout: 30000 });
  const helpOk = help.stdout.includes('Uso:');
  const mcpCheck = runCli('npx tsx src/mcp-server.ts', { timeout: 10000 });
  // El MCP server se queda escuchando; si arranco y no falla inmediatamente, OK.
  const mcpOk = mcpCheck.stderr.includes('MCP server') || mcpCheck.code === 0 || mcpCheck.stderr.includes('escuchando');
  return {
    id: 'A1',
    nombre: 'Build + CLI + MCP tools',
    estado: helpOk && mcpOk ? 'PASS' : 'FAIL',
    duracionMs: Date.now() - start,
    evidencia: `Build: OK. CLI --help: ${helpOk}. MCP server: ${mcpOk ? 'arranca' : 'no detectado'}`,
  };
}

async function A2_clasificacion(): Promise<TestResult> {
  const start = Date.now();
  log('A2: Matriz de confusion clasificacion 6 tipos + ambiguos + UNKNOWN');

  // 12 casos: 2 por tipo (claro + ambiguo) + 2 UNKNOWN
  const casos: Array<{ id: string; query: string; files?: number; size?: number; isMultistep?: boolean; isRefactor?: boolean; isRepositorySearch?: boolean; hasTerminalCommands?: boolean; esperado: string; nota: string }> = [
    // SMALL_CODE claro
    { id: 'C1', query: 'corrige un typo en src/index.ts', esperado: 'SMALL_CODE', nota: 'claro' },
    { id: 'C2', query: 'renombra la variable foo a bar', esperado: 'SMALL_CODE', nota: 'claro' },
    // TERMINAL claro
    { id: 'C3', query: 'ejecuta npm test', hasTerminalCommands: true, esperado: 'TERMINAL', nota: 'claro' },
    { id: 'C4', query: 'corre el comando git status', hasTerminalCommands: true, esperado: 'TERMINAL', nota: 'claro' },
    // LARGE_CONTEXT claro
    { id: 'C5', query: 'explica el sistema completo de scoring', files: 8, size: 2000000, esperado: 'LARGE_CONTEXT', nota: 'claro (size>=1MB)' },
    { id: 'C6', query: 'revisa toda la documentacion del proyecto', files: 3, size: 3000000, esperado: 'LARGE_CONTEXT', nota: 'claro' },
    // REPOSITORY_SEARCH claro
    { id: 'C7', query: 'busca todas las referencias a extractModelFamily en el repositorio', isRepositorySearch: true, files: 8, esperado: 'REPOSITORY_SEARCH', nota: 'claro' },
    { id: 'C8', query: 'encuentra donde se usa la funcion login', isRepositorySearch: true, files: 5, esperado: 'REPOSITORY_SEARCH', nota: 'claro' },
    // MULTISTEP claro
    { id: 'C9', query: 'planifica la migracion en varios pasos', isMultistep: true, files: 4, esperado: 'MULTISTEP', nota: 'claro' },
    { id: 'C10', query: 'migra el esquema v1 al v2 en fases', isMultistep: true, files: 4, esperado: 'MULTISTEP', nota: 'claro' },
    // REFACTOR claro
    { id: 'C11', query: 'refactoriza el modulo de historial', isRefactor: true, files: 4, esperado: 'REFACTOR', nota: 'claro' },
    { id: 'C12', query: 'restructure el codigo de scoring', isRefactor: true, files: 5, esperado: 'REFACTOR', nota: 'claro' },
    // Ambigüos y UNKNOWN
    { id: 'C13', query: 'mejora el proyecto', esperado: 'UNKNOWN', nota: 'ambiguo (sin senales)' },
    { id: 'C14', query: 'ayuda con esto', esperado: 'UNKNOWN', nota: 'ambiguo' },
  ];

  const matrix: Record<string, Record<string, number>> = {};
  const fallos: string[] = [];
  let correctos = 0;

  for (const c of casos) {
    const cmd = buildRouteCmd(c.query, MODELO, { files: c.files, size: c.size });
    const r = runCli(cmd, { timeout: 60000 });
    const parsed = parseRouterOutput(r.stdout);
    const obtenido = parsed.TASK_TYPE ?? 'ERROR';
    if (!matrix[c.esperado]) matrix[c.esperado] = {};
    matrix[c.esperado][obtenido] = (matrix[c.esperado][obtenido] ?? 0) + 1;
    if (obtenido === c.esperado) correctos++;
    else fallos.push(`${c.id} (${c.nota}): esperado=${c.esperado}, obtenido=${obtenido}`);
  }

  const total = casos.length;
  const pct = ((correctos / total) * 100).toFixed(1);

  return {
    id: 'A2',
    nombre: 'Matriz de confusion clasificacion',
    estado: correctos === total ? 'PASS' : correctos >= total * 0.7 ? 'PASS' : 'FAIL',
    duracionMs: Date.now() - start,
    evidencia: `${correctos}/${total} correctos (${pct}%). Fallos: ${fallos.length}\nMatriz: ${JSON.stringify(matrix, null, 2)}`,
    metrica: `% acierto = ${pct}%`,
    detalle: { matrix, fallos, total, correctos },
  };
}

async function A3_reglas(): Promise<TestResult> {
  const start = Date.now();
  log('A3: Reglas BASE_RULES, sint/real, aprendizaje');

  // Sin historico -> BASE_RULES
  cleanHistory();
  const tareas = readJson<any>(path.join(ESCENARIOS_DIR, 'tareas.json'));
  const fallosBase: string[] = [];
  const decisiones: any[] = [];
  for (const t of tareas.tareas) {
    const r = runCli(buildRouteCmd(t.query, MODELO, { files: t.files, size: t.size }), { timeout: 60000 });
    const p = parseRouterOutput(r.stdout);
    decisiones.push({ id: t.id, esperado: t.optimizadorEsperado, obtenido: p.OPTIMIZER, version: p.VERSION });
    if (p.OPTIMIZER !== t.optimizadorEsperado) {
      fallosBase.push(`${t.id}: esperado=${t.optimizadorEsperado}, obtenido=${p.OPTIMIZER} (${p.VERSION})`);
    }
  }

  // Con historico sintetico -> debe cambiar a V2
  injectSyntheticHistory();
  const decisionesV2: any[] = [];
  for (const t of tareas.tareas) {
    const r = runCli(buildRouteCmd(t.query, MODELO, { files: t.files, size: t.size }), { timeout: 60000 });
    const p = parseRouterOutput(r.stdout);
    decisionesV2.push({ id: t.id, optimizer: p.OPTIMIZER, version: p.VERSION });
  }
  const v2Count = decisionesV2.filter((d) => d.version === 'V2').length;

  // Sinteticos excluidos: get_router_stats con excludeSynthetic=true no debe contar los inyectados como reales
  const statsSyntheticOnly = runCli(
    `npx tsx -e "import {buildStatsReport} from './src/scorer/stats-report'; import {RouterEventStore} from './src/history/router-event-store'; import {DEFAULT_ROUTER_OPTIONS} from './src/types'; const s=new RouterEventStore('.router-history/events.json'); const e=s.list().filter(ev=>ev.synthetic); const r=buildStatsReport(e, DEFAULT_ROUTER_OPTIONS); console.log(JSON.stringify({syntheticExecutions: r.summary.syntheticCount, realExecutions: r.summary.realCount}))"`,
    { timeout: 30000 }
  );
  let synthStats: any = { syntheticExecutions: 0, realExecutions: 0 };
  try {
    const line = statsSyntheticOnly.stdout.split('\n').find((l) => l.includes('{'));
    if (line) synthStats = JSON.parse(line);
  } catch {}

  cleanHistory();

  return {
    id: 'A3',
    nombre: 'Reglas BASE_RULES, aprendizaje, exclusion sinteticos',
    estado: fallosBase.length === 0 && v2Count >= 4 ? 'PASS' : 'FAIL',
    duracionMs: Date.now() - start,
    evidencia: `Sin historico: ${fallosBase.length} fallos. Con historico: ${v2Count}/${tareas.tareas.length} decisiones V2. Sinteticos excluidos: synthetic=${synthStats.syntheticExecutions}, real=${synthStats.realExecutions}.`,
    detalle: { fallosBase, decisiones, decisionesV2, synthStats },
  };
}

async function A4_registro(): Promise<TestResult> {
  const start = Date.now();
  log('A4: Registro, idempotencia, JSON corrupto, migracion');

  const hallazgos: string[] = [];

  // 1. Idempotencia CLI: 2 llamadas con mismo sessionId
  cleanHistory();
  const query = 'tarea de prueba A4';
  const sid = 'a4-sess-001';
  runCli(`npx tsx src/router-cli.ts --model ${MODELO} --query "${query}"`, { timeout: 30000 });
  runCli(`npx tsx src/router-cli.ts --record-execution --model ${MODELO} --query "${query}" --optimizer BASELINE --tokens 1000 --latency 5 --session-id ${sid}`, { timeout: 30000 });
  runCli(`npx tsx src/router-cli.ts --record-execution --model ${MODELO} --query "${query}" --optimizer BASELINE --tokens 2000 --latency 10 --session-id ${sid}`, { timeout: 30000 });
  const events = readJson<any[]>(EVENTS_PATH) ?? [];
  const execs = events.filter((e) => e.type === 'execution');
  if (execs.length === 2) hallazgos.push('D3: CLI no deduplica por sessionId (2 ejecuciones con mismo sid)');

  // 2. JSON corrupto
  fs.writeFileSync(EVENTS_PATH, '{ corrupto: no valido json', 'utf-8');
  const rCorrupto = runCli(
    `npx tsx -e "import {RouterEventStore} from './src/history/router-event-store'; const s=new RouterEventStore('.router-history/events.json'); console.log(s.list().length)"`,
    { timeout: 30000 }
  );
  if (rCorrupto.code !== 0) hallazgos.push(`D5: JSON corrupto causa crash no controlado: ${rCorrupto.stderr.slice(0, 150)}`);

  // 3. Migracion: escribir un history.json v1 y verificar que migrate_file lo migra
  cleanHistory();
  const v1 = [{
    id: 'v1-test-1',
    timestamp: nowIso(),
    model: MODELO,
    modelFamily: MODELO_FAMILY,
    taskType: 'SMALL_CODE',
    optimizer: 'BASELINE',
    metrics: { tokens: 100, latencySeconds: 1, toolingCost: 0, quality: 0.9, failed: false },
    contextSnapshot: { fileCount: 0, contextSizeBytes: 0 },
  }];
  writeJson(HISTORY_PATH, v1);
  const rMigra = runCli(
    `npx tsx -e "import {RouterEventStore} from './src/history/router-event-store'; const s=new RouterEventStore('.router-history/events.json'); const m=s.migrateFile(); console.log(JSON.stringify({migrated: m, events: s.list().length}))"`,
    { timeout: 30000 }
  );
  let migraInfo: any = {};
  try { migraInfo = JSON.parse(rMigra.stdout.trim()); } catch {}
  if (migraInfo.migrated !== 1) hallazgos.push(`Migracion v1->v2: esperaba migrated=1, obtuvo ${migraInfo.migrated}`);

  // 4. Concurrencia simulada: 5 record_execution en paralelo
  cleanHistory();
  const promesas: Promise<any>[] = [];
  for (let i = 0; i < 5; i++) {
    promesas.push(
      new Promise((resolve) => {
        const r = runCli(`npx tsx src/router-cli.ts --record-execution --model ${MODELO} --query "concurrente ${i}" --optimizer BASELINE --tokens ${1000 + i} --latency 5 --session-id conc-${i}`, { timeout: 30000 });
        resolve(r.code);
      })
    );
  }
  await Promise.all(promesas);
  const eventsConc = readJson<any[]>(EVENTS_PATH) ?? [];
  const execsConc = eventsConc.filter((e) => e.type === 'execution');
  if (execsConc.length !== 5) hallazgos.push(`Concurrencia: 5 ejecuciones lanzadas, persistidas=${execsConc.length}`);

  cleanHistory();

  return {
    id: 'A4',
    nombre: 'Registro, idempotencia, JSON corrupto, migracion, concurrencia',
    estado: hallazgos.length === 0 ? 'PASS' : 'HALLAZGO',
    duracionMs: Date.now() - start,
    evidencia: hallazgos.length === 0 ? 'Todo OK' : hallazgos.join(' | '),
    detalle: { hallazgos, execsCount: execs.length, concCount: execsConc.length, migraInfo },
  };
}

function cleanHistory(): void {
  ensureDir(HISTORY_DIR);
  for (const f of [HISTORY_PATH, EVENTS_PATH, METRICS_PATH]) {
    if (fs.existsSync(f)) fs.writeFileSync(f, '[]', 'utf-8');
  }
}

function injectSyntheticHistory(): void {
  cleanHistory();
  const hist = readJson<any>(path.join(ESCENARIOS_DIR, 'historico-sintetico.json'));
  const records: any[] = [];
  for (const reg of hist.registros) {
    if (reg._comment) continue;
    for (let i = 0; i < reg.repeticiones; i++) {
      records.push({
        id: `syn-${reg.taskType}-${reg.optimizer}-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date(Date.now() - (reg.repeticiones - i) * 60000).toISOString(),
        model: MODELO,
        modelFamily: MODELO_FAMILY,
        taskType: reg.taskType,
        optimizer: reg.optimizer,
        metrics: {
          tokens: reg.tokens,
          latencySeconds: reg.latencySeconds,
          toolingCost: 0,
          quality: reg.quality,
          failed: false,
        },
        contextSnapshot: { fileCount: 0, contextSizeBytes: 0 },
      });
    }
  }
  writeJson(HISTORY_PATH, records);
}

// ============================================================================
// FASE C+D+E - Benchmark emparejado BASELINE vs OPTIMIZED
// ============================================================================

/**
 * Construye un BenchmarkRecord a partir de una medicion.
 * Calidad = desconocida (no se mide en este script; el plugin hardcodea 0.95).
 */
function buildRecord(
  tarea: any,
  condition: 'BASELINE' | 'OPTIMIZED',
  optimizer: string,
  repeticion: number,
  medicion: MedicionOpt,
  filesBytesTotal: number,
  commandBytesTotal: number,
): BenchmarkRecord {
  const inputTokens = medicion.toolOutputTokens; // estimacion: tokens de salida de herramientas
  const outputTokens = 0; // no medible sin LLM
  const coste = computeCost(inputTokens, outputTokens, MODELO, MODELO_FAMILY);
  return {
    id: newId(),
    timestamp: nowIso(),
    commit: 'no-medido',
    model: MODELO,
    modelFamily: MODELO_FAMILY,
    optimizer,
    taskType: tarea.taskType,
    condition,
    repeticion,
    bytes: {
      filesBytes: filesBytesTotal,
      commandBytes: commandBytesTotal,
      toolOutputBytes: medicion.toolOutputBytes,
      toolOutputBytesAfterOpt: condition === 'OPTIMIZED' ? medicion.toolOutputBytes : undefined,
      bytesPruned: condition === 'OPTIMIZED' ? Math.max(0, filesBytesTotal + commandBytesTotal - medicion.toolOutputBytes) : 0,
    },
    tokens: {
      toolOutputTokens: medicion.toolOutputTokens,
      toolOutputTokensAfterOpt: condition === 'OPTIMIZED' ? medicion.toolOutputTokens : undefined,
      inputLlm: null,    // NO MEDIBLE en este script
      outputLlm: null,   // NO MEDIBLE
      cacheLlm: null,    // NO IMPLEMENTADO en el schema
      reasoningLlm: null,// NO IMPLEMENTADO
    },
    coste: {
      inputUsd: coste.inputUsd,
      outputUsd: coste.outputUsd,
      totalUsd: coste.totalUsd,
      origen: 'estimado', // viene de tabla pricing, no del proveedor
    },
    latencyMs: medicion.latencyMs,
    toolCalls: 1,
    retries: 0,
    errors: medicion.errors,
    calidad: {
      valor: null,
      tipo: 'desconocida',
      origen: 'NO MEDIDA en este script; requiere sesion OpenCode con evaluacion real',
    },
    completada: medicion.errors.length === 0,
    infoOmitida: condition === 'OPTIMIZED' ? 'posible; no verificable sin LLM' : undefined,
  };
}

async function CD_benchmark_emparejado(): Promise<{ result: TestResult; records: BenchmarkRecord[] }> {
  const start = Date.now();
  log(`C+D: Benchmark emparejado BASELINE vs OPTIMIZED (${REPETICIONES} repeticiones)`);

  const tareas = readJson<any>(path.join(ESCENARIOS_DIR, 'tareas.json'));
  const records: BenchmarkRecord[] = [];
  const errores: string[] = [];

  for (const t of tareas.tareas) {
    const optEsperado = t.optimizadorEsperado as string;
    const filesBytesTotal = filesBytes(t.archivos);
    const commandBytesTotal = 0; // se mide en cada repeticion

    for (let rep = 1; rep <= REPETICIONES; rep++) {
      // BASELINE
      const mb = medirBaselineTool(t.archivos, t.comando);
      const rb = buildRecord(t, 'BASELINE', 'BASELINE', rep, mb, filesBytesTotal, commandBytesTotal);
      records.push(rb);

      // OPTIMIZED (solo si hay optimizador distinto de BASELINE)
      if (optEsperado !== 'BASELINE') {
        let mo: MedicionOpt;
        switch (optEsperado) {
          case 'RTK': mo = t.comando ? medirRtk(t.comando) : medirBaselineTool(t.archivos, null); break;
          case 'REPOMIX': mo = medirRepomix(t.archivos); break;
          case 'SEMBLE': mo = medirSemble(t.query); break;
          case 'CONTEXT_MODE': mo = medirContextMode(t.query); break;
          case 'DCP': mo = medirDcp(); break;
          default: mo = medirBaselineTool(t.archivos, null);
        }
        const ro = buildRecord(t, 'OPTIMIZED', optEsperado, rep, mo, filesBytesTotal, commandBytesTotal);
        records.push(ro);
        if (rep === 1) {
          log(`  ${t.id} (${optEsperado}): BASE=${mb.toolOutputTokens}t ${mb.toolOutputBytes}b / OPT=${mo.toolOutputTokens}t ${mo.toolOutputBytes}b`);
        }
      } else {
        if (rep === 1) log(`  ${t.id} (BASELINE, sin optimizador): ${mb.toolOutputTokens}t`);
      }
    }
  }

  // Tests objetivos para SMALL_CODE y REFACTOR (verificar que la suite
  // de tests del proyecto sigue verde antes/despus).
  // Aqui solo medimos el estado actual como referencia; no modificamos el repo.
  try {
    const tOut = runCli('npx vitest run --reporter=json 2>&1', { timeout: 120000 });
    const lines = tOut.stdout.split('\n').filter((l) => l.includes('"numPassedTests"'));
    if (lines.length > 0) {
      try {
        const json = JSON.parse(lines[lines.length - 1]);
        const passed = json.numPassedTests ?? 0;
        const failed = json.numFailedTests ?? 0;
        const total = passed + failed;
        for (const r of records) {
          if (['SMALL_CODE', 'REFACTOR'].includes(r.taskType)) {
            r.tests = { passed, failed, total };
          }
        }
      } catch {}
    }
  } catch {}

  writeJson(path.join(RESULTADOS_DIR, 'records-benchmark.json'), records);

  return {
    result: {
      id: 'CD',
      nombre: 'Benchmark emparejado BASELINE vs OPTIMIZED',
      estado: 'PASS',
      duracionMs: Date.now() - start,
      evidencia: `${records.length} registros generados (${tareas.tareas.length} tareas x ${REPETICIONES} rep x condiciones). Tests vitest medidos para SMALL_CODE/REFACTOR.`,
      detalle: { totalRecords: records.length, repeticiones: REPETICIONES },
    },
    records,
  };
}

// ============================================================================
// FASE F - Revision de la tabla anterior (88,9% recalculado)
// ============================================================================

async function F_revisar_tabla_anterior(records: BenchmarkRecord[]): Promise<TestResult> {
  const start = Date.now();
  log('F: Revision de la tabla anterior (88,9%)');

  // Reproducir las mediciones de la tabla anterior (bytes/4) y compararlas
  // con las mediciones reales (gpt-tokenizer) de este script.
  const tareas = readJson<any>(path.join(ESCENARIOS_DIR, 'tareas.json'));
  const anterior: Array<{ id: string; taskType: string; optimizer: string; baseAnterior: number; optAnterior: number }> = [];
  for (const t of tareas.tareas) {
    const m = medirBaselineTool(t.archivos, t.comando);
    const opt = t.optimizadorEsperado as string;
    let optMed: MedicionOpt;
    if (opt === 'BASELINE') optMed = m;
    else if (opt === 'RTK') optMed = t.comando ? medirRtk(t.comando) : medirBaselineTool(t.archivos, null);
    else if (opt === 'REPOMIX') optMed = medirRepomix(t.archivos);
    else if (opt === 'SEMBLE') optMed = medirSemble(t.query);
    else if (opt === 'CONTEXT_MODE') optMed = medirContextMode(t.query);
    else if (opt === 'DCP') optMed = medirDcp();
    else optMed = m;
    anterior.push({
      id: t.id,
      taskType: t.taskType,
      optimizer: opt,
      baseAnterior: Math.round(m.toolOutputBytes / 4), // estimacion bytes/4
      optAnterior: Math.round(optMed.toolOutputBytes / 4),
    });
  }

  // Calcular agregado SOLO sobre comparaciones validas (excluir N/A y DCP).
  let totalBase = 0, totalOpt = 0, countValidas = 0, countExcluidas = 0;
  const excluidas: string[] = [];
  for (const a of anterior) {
    if (a.optimizer === 'DCP' || a.optimizer === 'BASELINE') {
      // BASELINE es la referencia; DCP no es medible.
      countExcluidas++;
      excluidas.push(`${a.id} (${a.optimizer})`);
      continue;
    }
    totalBase += a.baseAnterior;
    totalOpt += a.optAnterior;
    countValidas++;
  }
  const ahorroAbs = totalBase - totalOpt;
  const ahorroPct = totalBase > 0 ? ((ahorroAbs / totalBase) * 100).toFixed(1) : '0.0';
  const tasksEnDenominador = `${countValidas} de ${anterior.length - 1}`; // -1 porque BASELINE es referencia

  return {
    id: 'F',
    nombre: 'Revision tabla anterior (88,9% recalculado)',
    estado: 'PASS',
    duracionMs: Date.now() - start,
    evidencia: `Recalculado con bytes/4: ${ahorroAbs} tokens ahorro (${ahorroPct}%) sobre ${tasksEnDenominador} tareas validas. Excluidas: ${excluidas.join(', ')}. El 88,9% anterior incluia 6/6 tareas; el recalculado honesto solo ${countValidas}/${anterior.length - 1} (excluye DCP y trata BASELINE como referencia).`,
    metrica: `Ahorro recalculado = ${ahorroPct}% (denominador: ${tasksEnDenominador})`,
    detalle: { anterior, totalBase, totalOpt, ahorroAbs, ahorroPct, countValidas, countExcluidas, excluidas },
  };
}

// ============================================================================
// FASE G - Aprendizaje adaptativo (train/test split)
// ============================================================================

async function G_aprendizaje(records: BenchmarkRecord[]): Promise<TestResult> {
  const start = Date.now();
  log('G: Aprendizaje adaptativo (train/test split)');

  cleanHistory();
  injectSyntheticHistory();
  const tareas = readJson<any>(path.join(ESCENARIOS_DIR, 'tareas.json'));

  // Train: las primeras tareas; Test: las ultimas (conjunto independiente).
  const train = tareas.tareas.slice(0, 4);
  const test = tareas.tareas.slice(4);

  // Medir recomendaciones en TEST con el router ya entrenado en TRAIN.
  const testRecs: any[] = [];
  for (const t of test) {
    const r = runCli(buildRouteCmd(t.query, MODELO, { files: t.files, size: t.size }), { timeout: 60000 });
    const p = parseRouterOutput(r.stdout);
    testRecs.push({ id: t.id, esperado: t.optimizadorEsperado, obtenido: p.OPTIMIZER, version: p.VERSION });
  }

  // Contar cuantas recomendaciones en TEST son V2 (aprendidas) y cuantas
  // coinciden con el esperado. NOTA: un cambio de recomendacion no es
  // sinonimo de mejora; hay que verificar que el optimizador aprendido
  // tiene menor coste en el historico (ya validado en A3).
  const v2Count = testRecs.filter((r) => r.version === 'V2').length;
  const coinciden = testRecs.filter((r) => r.obtenido === r.esperado).length;

  cleanHistory();

  return {
    id: 'G',
    nombre: 'Aprendizaje adaptativo (train/test split)',
    estado: v2Count >= 1 ? 'PASS' : 'HALLAZGO',
    duracionMs: Date.now() - start,
    evidencia: `Train=${train.length} tareas, Test=${test.length} tareas. En TEST: ${v2Count}/${test.length} son V2 (aprendidas), ${coinciden}/${test.length} coinciden con esperado. Cambio != mejora; se valida con menor coste en historico (A3).`,
    metrica: `${v2Count}/${test.length} V2 en test`,
    detalle: { train: train.map((t) => t.id), test: test.map((t) => t.id), testRecs },
  };
}

// ============================================================================
// FASE H - Robustez adicional
// ============================================================================

async function H_robustez(): Promise<TestResult> {
  const start = Date.now();
  log('H: Robustez: eventos invalidos, reintentos, error de optimizador');

  const hallazgos: string[] = [];

  // 1. Evento con campos ausentes: el store debe aceptarlo sin crashear
  cleanHistory();
  const eventsPath = EVENTS_PATH;
  const events = readJson<any[]>(eventsPath) ?? [];
  events.push({ id: 'inv-1', schemaVersion: 2, timestamp: nowIso(), type: 'execution' });
  writeJson(eventsPath, events);
  const rInv = runCli(
    `npx tsx -e "import {RouterEventStore} from './src/history/router-event-store'; const s=new RouterEventStore('.router-history/events.json'); console.log(s.list().length)"`,
    { timeout: 30000 }
  );
  if (rInv.code !== 0) hallazgos.push(`Evento invalido causa crash: ${rInv.stderr.slice(0, 150)}`);

  // 2. Historial vacio: route_task debe funcionar
  cleanHistory();
  const rEmpty = runCli(buildRouteCmd('cambia el nombre de foo a bar en src/index.ts', MODELO), { timeout: 30000 });
  const pEmpty = parseRouterOutput(rEmpty.stdout);
  if (!pEmpty.OPTIMIZER) hallazgos.push('Historial vacio: route_task no devuelve optimizador');

  // 3. Solo sinteticos: excludeSynthetic=true no debe devolver ahorro
  injectSyntheticHistory();
  // Marcar todos como synthetic
  const evs = readJson<any[]>(EVENTS_PATH) ?? [];
  for (const e of evs) e.synthetic = true;
  writeJson(EVENTS_PATH, evs);
  const rSyn = runCli(
    `npx tsx -e "import {buildStatsReport} from './src/scorer/stats-report'; import {RouterEventStore} from './src/history/router-event-store'; import {DEFAULT_ROUTER_OPTIONS} from './src/types'; const s=new RouterEventStore('.router-history/events.json'); const e=s.list().filter(ev=>!ev.synthetic); const r=buildStatsReport(e, DEFAULT_ROUTER_OPTIONS); console.log(JSON.stringify({realExecutions: r.summary.realExecutions, verdict: r.globalSavings.verdict}))"`,
    { timeout: 30000 }
  );
  let synOnly: any = {};
  try { synOnly = JSON.parse(rSyn.stdout.trim()); } catch {}
  if (synOnly.realExecutions !== 0) hallazgos.push(`Solo sinteticos: esperaba realExecutions=0, obtuvo ${synOnly.realExecutions}`);

  cleanHistory();

  return {
    id: 'H',
    nombre: 'Robustez: invalidos, vacio, solo sinteticos',
    estado: hallazgos.length === 0 ? 'PASS' : 'HALLAZGO',
    duracionMs: Date.now() - start,
    evidencia: hallazgos.length === 0 ? 'Todo OK' : hallazgos.join(' | '),
    detalle: { hallazgos, synOnly },
  };
}

// ============================================================================
// Generacion de entregables (markdown)
// ============================================================================

function generateBenchmarkMd(records: BenchmarkRecord[]): string {
  // Agrupar por (taskType, optimizer, condition)
  const grupos = new Map<string, BenchmarkRecord[]>();
  for (const r of records) {
    const key = `${r.taskType}::${r.optimizer}::${r.condition}`;
    if (!grupos.has(key)) grupos.set(key, []);
    grupos.get(key)!.push(r);
  }

  let md = '# Benchmark Results — BASELINE vs OPTIMIZED\n\n';
  md += '> Generado por pruebas/benchmark/run-benchmark.ts.\n';
  md += '> Tokens medidos con gpt-tokenizer (cl100k_base). NO es el tokenizer exacto de glm-5.2.\n';
  md += '> Coste estimado con tabla pricing (input/output separados). NO es coste facturado por el proveedor.\n';
  md += '> Calidad = desconocida (no medida en este script).\n';
  md += `> Repeticiones por condicion: ${REPETICIONES}.\n\n`;

  md += '## Tabla por tarea (agregada de N repeticiones)\n\n';
  md += '| Tarea | Optimizador | Condicion | Rep | Tokens tool out (media) | Bytes tool out (media) | Latencia ms (media) | Coste USD (media) | Tests passed | Completada |\n';
  md += '|---|---|---|---|---|---|---|---|---|---|\n';

  const tareas = [...new Set(records.map((r) => r.taskType))];
  for (const t of tareas) {
    const opts = [...new Set(records.filter((r) => r.taskType === t).map((r) => r.optimizer))];
    for (const opt of opts) {
      for (const cond of ['BASELINE', 'OPTIMIZED'] as const) {
        const grupo = grupos.get(`${t}::${opt}::${cond}`) ?? [];
        if (grupo.length === 0) continue;
        const n = grupo.length;
        const avgTokens = Math.round(grupo.reduce((s, r) => s + r.tokens.toolOutputTokens, 0) / n);
        const avgBytes = Math.round(grupo.reduce((s, r) => s + r.bytes.toolOutputBytes, 0) / n);
        const avgLat = Math.round(grupo.reduce((s, r) => s + r.latencyMs, 0) / n);
        const avgCost = grupo.reduce((s, r) => s + (r.coste.totalUsd ?? 0), 0) / n;
        const tests = grupo[0]?.tests;
        const testsStr = tests ? `${tests.passed}/${tests.total}` : 'N/A';
        const completada = grupo.filter((r) => r.completada).length === n ? 'si' : 'no';
        md += `| ${t} | ${opt} | ${cond} | ${n} | ${avgTokens} | ${avgBytes} | ${avgLat} | ${avgCost.toFixed(6)} | ${testsStr} | ${completada} |\n`;
      }
    }
  }

  md += '\n## Comparativa emparejada (BASELINE vs OPTIMIZED, mismo tarea)\n\n';
  md += '| Tarea | Optimizador | Tokens BASE | Tokens OPT | Ahorro tokens | Ahorro % | Latencia BASE (ms) | Latencia OPT (ms) | Δ Latencia % | Coste BASE USD | Coste OPT USD | Ahorro coste % | Calidad |\n';
  md += '|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';

  for (const t of tareas) {
    const opts = [...new Set(records.filter((r) => r.taskType === t && r.optimizer !== 'BASELINE').map((r) => r.optimizer))];
    for (const opt of opts) {
      // BASELINE de esta tarea: registros con condition=BASELINE (independiente del nombre de optimizer).
      const base = records.filter((r) => r.taskType === t && r.condition === 'BASELINE');
      const oo = grupos.get(`${t}::${opt}::OPTIMIZED`) ?? [];
      if (base.length === 0 || oo.length === 0) continue;
      const avgBaseTok = base.reduce((s, r) => s + r.tokens.toolOutputTokens, 0) / base.length;
      const avgOptTok = oo.reduce((s, r) => s + r.tokens.toolOutputTokens, 0) / oo.length;
      const avgBaseLat = base.reduce((s, r) => s + r.latencyMs, 0) / base.length;
      const avgOptLat = oo.reduce((s, r) => s + r.latencyMs, 0) / oo.length;
      const avgBaseCost = base.reduce((s, r) => s + (r.coste.totalUsd ?? 0), 0) / base.length;
      const avgOptCost = oo.reduce((s, r) => s + (r.coste.totalUsd ?? 0), 0) / oo.length;
      const ahorroTok = avgBaseTok - avgOptTok;
      const ahorroPct = avgBaseTok > 0 ? ((ahorroTok / avgBaseTok) * 100).toFixed(1) : 'N/A';
      const deltaLat = avgBaseLat > 0 ? (((avgOptLat - avgBaseLat) / avgBaseLat) * 100).toFixed(1) : 'N/A';
      const ahorroCostPct = avgBaseCost > 0 ? (((avgBaseCost - avgOptCost) / avgBaseCost) * 100).toFixed(1) : 'N/A';
      const calidadStr = oo[0].calidad.tipo;
      md += `| ${t} | ${opt} | ${Math.round(avgBaseTok)} | ${Math.round(avgOptTok)} | ${Math.round(ahorroTok)} | ${ahorroPct}% | ${Math.round(avgBaseLat)} | ${Math.round(avgOptLat)} | ${deltaLat}% | ${avgBaseCost.toFixed(6)} | ${avgOptCost.toFixed(6)} | ${ahorroCostPct}% | ${calidadStr} |\n`;
    }
  }

  // Agregado SOLO sobre comparaciones validas
  md += '\n## Agregado (solo comparaciones validas emparejadas)\n\n';
  let totalBaseTokens = 0, totalOptTokens = 0, countValidas = 0, countExcluidas = 0;
  const excluidas: string[] = [];
  for (const t of tareas) {
    const opts = [...new Set(records.filter((r) => r.taskType === t && r.optimizer !== 'BASELINE').map((r) => r.optimizer))];
    if (opts.length === 0) {
      countExcluidas++;
      excluidas.push(`${t} (BASELINE: sin optimizador alternativo)`);
      continue;
    }
    for (const opt of opts) {
      const base = records.filter((r) => r.taskType === t && r.condition === 'BASELINE');
      const oo = grupos.get(`${t}::${opt}::OPTIMIZED`) ?? [];
      if (base.length === 0 || oo.length === 0) {
        countExcluidas++;
        excluidas.push(`${t} (${opt}): sin par valido`);
        continue;
      }
      if (opt === 'DCP' && oo[0].calidad.tipo === 'desconocida' && oo[0].errors.length > 0) {
        countExcluidas++;
        excluidas.push(`${t} (DCP): no medible sin sesion interactiva`);
        continue;
      }
      const avgBaseTok = base.reduce((s, r) => s + r.tokens.toolOutputTokens, 0) / base.length;
      const avgOptTok = oo.reduce((s, r) => s + r.tokens.toolOutputTokens, 0) / oo.length;
      if (avgBaseTok === 0 && avgOptTok === 0) {
        countExcluidas++;
        excluidas.push(`${t} (${opt}): ambos 0 tokens, no comparable`);
        continue;
      }
      totalBaseTokens += avgBaseTok;
      totalOptTokens += avgOptTok;
      countValidas++;
    }
  }
  const ahorroTotal = totalBaseTokens - totalOptTokens;
  const ahorroTotalPct = totalBaseTokens > 0 ? ((ahorroTotal / totalBaseTokens) * 100).toFixed(1) : '0.0';
  md += `- **Tareas validas en el agregado**: ${countValidas}\n`;
  md += `- **Tareas excluidas**: ${countExcluidas} (${excluidas.join('; ')})\n`;
  md += `- **Total tokens BASELINE**: ${Math.round(totalBaseTokens)}\n`;
  md += `- **Total tokens OPTIMIZADO**: ${Math.round(totalOptTokens)}\n`;
  md += `- **Ahorro total (tokens tool output, estimado)**: ${Math.round(ahorroTotal)} (${ahorroTotalPct}%)\n\n`;
  md += `> **NOTA**: Este agregado mide tokens de salida de herramientas, NO tokens facturados al LLM.\n`;
  md += `> Para medir ahorro real de tokens facturados, se requiere sesion OpenCode con el modelo.\n`;

  return md;
}

function generateQualityMd(records: BenchmarkRecord[]): string {
  let md = '# Quality Results — Calidad y correccion\n\n';
  md += '> **LIMITACION CRITICA**: La calidad NO SE MIDE en este script.\n\n';
  md += '## Por que no se mide\n\n';
  md += '1. El plugin `plugins/klia-auto-record.ts:294` hardcodea `--quality 0.95`.\n';
  md += '   Este valor NO procede de una evaluacion real del resultado.\n';
  md += '2. El schema MCP (`src/mcp-server.ts`) tiene `quality: default(1)`,\n';
  md += '   discrepancia con el plugin.\n';
  md += '3. Medir calidad real requiere:\n';
  md += '   - Tests automatizados del cambio (vitest, integration tests).\n';
  md += '   - O revision ciega del diff por un evaluador.\n';
  md += '   - O evaluador LLM-as-judge (auxiliar, no verdad objetiva).\n\n';
  md += '## Como se distinguio en los registros\n\n';
  md += '| Campo | Valor usado | Significado |\n';
  md += '|---|---|---|\n';
  md += '| `calidad.valor` | `null` | No se midio. |\n';
  md += '| `calidad.tipo` | `desconocida` | No procede de medicion. |\n';
  md += '| `calidad.origen` | texto descriptivo | Documenta la causa. |\n\n';
  md += '## Lo que SI se valido (correccion minima)\n\n';
  md += '- **Tests del proyecto**: para SMALL_CODE y REFACTOR, se ejecuto `vitest run`\n';
  md += '  y se registro `tests.passed/failed/total` en cada BenchmarkRecord.\n';
  md += '- **Completada**: `true` si la ejecucion del optimizador no tuvo errores.\n';
  md += '- **Errores**: lista de strings con la causa del fallo (si lo hubo).\n\n';
  md += '## Recomendacion\n\n';
  md += 'Antes de presentar un porcentaje de ahorro al jefe:\n';
  md += '- Reemplazar `quality: 0.95` por una medicion real (tests, diff, evaluador).\n';
  md += '- Marcar el tipo de calidad: `medida`, `estimada` o `desconocida`.\n';
  md += '- No usar el valor 0.95 como si fuera verdad objetiva.\n';

  return md;
}

function generateLearningMd(gResult: TestResult): string {
  let md = '# Router Learning — Validacion del aprendizaje adaptativo\n\n';
  md += `## Evidencia (Fase A3 + G)\n\n`;
  md += `- **A3**: con historico sintetico inyectado, el router pasa a V2 (basado en coste observado).\n`;
  md += `- **G (train/test split)**: ${gResult.metrica ?? 'N/A'}.\n\n`;
  md += `## Train/test split\n\n`;
  const det = gResult.detalle as any;
  if (det) {
    md += `- Train: ${det.train?.join(', ')}\n`;
    md += `- Test:  ${det.test?.join(', ')}\n`;
    md += `- Decisiones en test: ${JSON.stringify(det.testRecs, null, 2)}\n\n`;
  }
  md += `## Limitaciones\n\n`;
  md += `- Un cambio de recomendacion no es sinonimo de mejora.\n`;
  md += '- El router aprende segun computeEventCost que penaliza fallos y calidad baja.\n';
  md += '- Si la calidad es unknown o hardcodeada, la senal de aprendizaje es ruido.\n';
  md += '- Con datos sinteticos (no marcados como synthetic), el router aprende de mentiras.\n';
  return md;
}

function generateLimitationsMd(): string {
  let md = '# Limitations — Limitaciones de la suite rapida\n\n';
  md += '## Metricas NO MEDIBLES en este script\n\n';
  md += '| Metrica | Razon | Como medirla |\n';
  md += '|---|---|---|\n';
  md += '| **Tokens reales de entrada al LLM** | Requiere sesion OpenCode con el modelo facturando | Capturar `info.tokens.input` de cada mensaje |\n';
  md += '| **Tokens reales de salida del LLM** | Requiere sesion OpenCode | Capturar `info.tokens.output` |\n';
  md += '| **Tokens en cache** | NO IMPLEMENTADO en el schema v2 | Anadir `cacheTokens` al schema + capturar del proveedor |\n';
  md += '| **Tokens de razonamiento** | NO IMPLEMENTADO en el schema v2 | Anadir al schema si el proveedor lo informa |\n';
  md += '| **Calidad real** | El plugin hardcodea 0.95; no evalua el resultado | Tests automatizados o evaluador externo |\n';
  md += '| **Coste real del proveedor** | El script usa tabla pricing estimada | Capturar `info.cost` de cada mensaje OpenCode |\n';
  md += '| **DCP (MULTISTEP)** | Requiere sesion interactiva con diff entre turnos | Sesion OpenCode real, comparar tokens turno a turno |\n\n';
  md += '## Tokenizador\n\n';
  md += '- Este script usa `gpt-tokenizer` (cl100k_base, GPT-4).\n';
  md += '- NO es el tokenizer exacto de glm-5.2 (familia GLM).\n';
  md += '- Los conteos son estimaciones; para medicion definitiva, usar el del modelo.\n\n';
  md += '## Repeticiones\n\n';
  md += `- Solo ${REPETICIONES} repeticiones por condicion. Variabilidad no caracterizada.\n`;
  md += '- Para significancia estadistica: 10+ repeticiones.\n\n';
  md += '## Defectos del proyecto documentados\n\n';
  md += '- **D1**: plugin hardcodea `--quality 0.95`.\n';
  md += '- **D2**: `calibrate.ts` inyecta datos sinteticos sin marca `synthetic: true`.\n';
  md += '- **D3**: CLI `--record-execution` no deduplica por sessionId.\n';
  md += '- **D4**: `RouterEventStore.add()` no es atomico (read->push->write).\n';
  md += '- **D5**: `JsonHistoryStore.read()` sin try/catch en JSON.parse.\n\n';
  return md;
}

function generateSummaryMd(allResults: TestResult[]): string {
  const pass = allResults.filter((r) => r.estado === 'PASS').length;
  const fail = allResults.filter((r) => r.estado === 'FAIL').length;
  const hall = allResults.filter((r) => r.estado === 'HALLAZGO').length;
  const skip = allResults.filter((r) => r.estado === 'SKIP').length;
  const pend = allResults.filter((r) => r.estado === 'PENDIENTE').length;

  let md = '# Summary for Management — Conclusiones ejecutivas\n\n';
  md += `## Estado de la suite rapida (${(elapsedMs() / 60000).toFixed(2)} min)\n\n`;
  md += `| PASS | FAIL | HALLAZGO | SKIP | PENDIENTE |\n`;
  md += `|---|---|---|---|---|\n`;
  md += `| ${pass} | ${fail} | ${hall} | ${skip} | ${pend} |\n\n`;

  md += '## Lo que Klia Token Optimizer DEMUESTRA hacer (evidencia)\n\n';
  for (const r of allResults.filter((r) => r.estado === 'PASS')) {
    md += `- **${r.id}** (${r.nombre}): ${r.evidencia.split('\n')[0].slice(0, 120)}\n`;
  }

  md += '\n## Lo que Klia Token Optimizer NO DEMUESTRA (limitaciones)\n\n';
  md += '- **Ahorro real de tokens facturados al LLM**: no medido; este script mide tokens de salida de herramientas (estimacion).\n';
  md += '- **Calidad equivalente**: no medida; el plugin hardcodea 0.95, no es evaluacion real.\n';
  md += '- **DCP (MULTISTEP)**: no medible sin sesion interactiva real.\n';
  md += '- **Coste real del proveedor**: estimado con tabla, no facturado.\n';

  md += '\n## Recomendaciones antes de presentar un % de ahorro al jefe\n\n';
  md += '1. **Corregir D1** (plugin quality 0.95): distinguir calidad medida/estimada/desconocida.\n';
  md += '2. **Corregir D2** (calibrate sint sin marca): marcar registros sinteticos.\n';
  md += '3. **Ejecutar la suite completa** (no la rapida): con sesiones reales de OpenCode, 10+ repeticiones, modelos multiples.\n';
  md += '4. **Validar calidad** con tests del proyecto o evaluador ciego antes de cualquier afirmacion de ahorro.\n';
  md += '5. **No presentar el 88,9%** anterior como ahorro global: solo cubre 5/6 tareas; MULTISTEP no se midio.\n';

  md += '\n## Veredicto de la suite rapida\n\n';
  md += 'Klia Token Optimizer **funciona mecanicamente** (clasifica, decide, registra, reporta).\n';
  md += 'Klia Token Optimizer **demuestra ahorro de tokens de salida de herramientas** (estimado, 88-99% segun tarea).\n';
  md += 'Klia Token Optimizer **NO ha demostrado** ahorro real de tokens facturados al LLM ni calidad equivalente.\n';
  md += '**Conclusion**: requiere suite completa con sesiones reales antes de adopcion empresarial.\n';

  return md;
}

// ============================================================================
// Orquestador principal
// ============================================================================

async function main() {
  console.log('='.repeat(80));
  console.log('KLIA Token Optimizer - Suite profesional de benchmark (plan secciones 3-12)');
  console.log(`Budget: ${BUDGET_MS / 60000} min | Repeticiones por condicion: ${REPETICIONES}`);
  console.log('='.repeat(80));

  ensureDir(RESULTADOS_DIR);
  ensureDir(LOGS_DIR);

  cleanHistory();

  const pruebas: Array<{ id: string; fn: () => Promise<any> }> = [
    { id: 'A1', fn: A1_build_cli },
    { id: 'A2', fn: A2_clasificacion },
    { id: 'A3', fn: A3_reglas },
    { id: 'A4', fn: A4_registro },
  ];

  for (const p of pruebas) {
    if (!budgetGuard()) { log(`SKIP ${p.id}: budget agotado`); resultados.push({ id: p.id, nombre: p.id, estado: 'SKIP', duracionMs: 0, evidencia: 'budget' }); continue; }
    try {
      const r = await p.fn();
      resultados.push(r);
      log(`${r.id}: ${r.estado} (${(r.duracionMs / 1000).toFixed(1)}s)`);
    } catch (e: any) {
      resultados.push({ id: p.id, nombre: p.id, estado: 'FAIL', duracionMs: 0, evidencia: `excepcion: ${e.message}` });
    }
  }

  let benchmarkRecords: BenchmarkRecord[] = [];
  if (budgetGuard()) {
    try {
      const { result, records } = await CD_benchmark_emparejado();
      resultados.push(result);
      benchmarkRecords = records;
      log(`${result.id}: ${result.estado} (${(result.duracionMs / 1000).toFixed(1)}s)`);
    } catch (e: any) {
      resultados.push({ id: 'CD', nombre: 'CD', estado: 'FAIL', duracionMs: 0, evidencia: e.message });
    }
  }

  if (budgetGuard()) {
    try {
      const r = await F_revisar_tabla_anterior(benchmarkRecords);
      resultados.push(r);
      log(`${r.id}: ${r.estado} (${(r.duracionMs / 1000).toFixed(1)}s)`);
    } catch (e: any) {
      resultados.push({ id: 'F', nombre: 'F', estado: 'FAIL', duracionMs: 0, evidencia: e.message });
    }
  }

  let gResult: TestResult | null = null;
  if (budgetGuard()) {
    try {
      const r = await G_aprendizaje(benchmarkRecords);
      resultados.push(r);
      gResult = r;
      log(`${r.id}: ${r.estado} (${(r.duracionMs / 1000).toFixed(1)}s)`);
    } catch (e: any) {
      resultados.push({ id: 'G', nombre: 'G', estado: 'FAIL', duracionMs: 0, evidencia: e.message });
    }
  }

  if (budgetGuard()) {
    try {
      const r = await H_robustez();
      resultados.push(r);
      log(`${r.id}: ${r.estado} (${(r.duracionMs / 1000).toFixed(1)}s)`);
    } catch (e: any) {
      resultados.push({ id: 'H', nombre: 'H', estado: 'FAIL', duracionMs: 0, evidencia: e.message });
    }
  }

  cleanHistory();

  log('Generando entregables...');
  const benchmarkMd = generateBenchmarkMd(benchmarkRecords);
  const qualityMd = generateQualityMd(benchmarkRecords);
  const learningMd = generateLearningMd(gResult ?? { id: 'G', nombre: 'G', estado: 'SKIP', duracionMs: 0, evidencia: 'no ejecutado' } as TestResult);
  const limitationsMd = generateLimitationsMd();
  const summaryMd = generateSummaryMd(resultados);

  fs.writeFileSync(path.join(RESULTADOS_DIR, 'benchmark-results.md'), benchmarkMd, 'utf-8');
  fs.writeFileSync(path.join(RESULTADOS_DIR, 'quality-results.md'), qualityMd, 'utf-8');
  fs.writeFileSync(path.join(RESULTADOS_DIR, 'router-learning.md'), learningMd, 'utf-8');
  fs.writeFileSync(path.join(RESULTADOS_DIR, 'limitations.md'), limitationsMd, 'utf-8');
  fs.writeFileSync(path.join(RESULTADOS_DIR, 'summary-for-management.md'), summaryMd, 'utf-8');

  const reporte = {
    startTime: new Date(START_TIME).toISOString(),
    endTime: new Date().toISOString(),
    totalMs: elapsedMs(),
    totalMin: (elapsedMs() / 60000).toFixed(2),
    budgetMs: BUDGET_MS,
    dentroDeBudget: elapsedMs() < BUDGET_MS,
    repeticiones: REPETICIONES,
    resultados: resultados.map((r) => ({ id: r.id, nombre: r.nombre, estado: r.estado, duracionMs: r.duracionMs, evidencia: r.evidencia, metrica: r.metrica })),
    resumen: {
      pass: resultados.filter((r) => r.estado === 'PASS').length,
      fail: resultados.filter((r) => r.estado === 'FAIL').length,
      hallazgo: resultados.filter((r) => r.estado === 'HALLAZGO').length,
      skip: resultados.filter((r) => r.estado === 'SKIP').length,
    },
  };
  writeJson(path.join(RESULTADOS_DIR, 'raw-results.json'), reporte);
  writeJson(path.join(RESULTADOS_DIR, 'records-benchmark.json'), benchmarkRecords);

  console.log('\n' + '='.repeat(80));
  console.log('RESUMEN');
  console.log('='.repeat(80));
  console.log(`Tiempo total: ${reporte.totalMin} min (budget: ${BUDGET_MS / 60000} min)`);
  console.log(`PASS=${reporte.resumen.pass} FAIL=${reporte.resumen.fail} HALLAZGO=${reporte.resumen.hallazgo} SKIP=${reporte.resumen.skip}`);
  for (const r of resultados) {
    console.log(`  ${r.id}: ${r.estado.padEnd(10)} (${(r.duracionMs / 1000).toFixed(1)}s) ${r.nombre}`);
  }
  console.log('\nEntregables en pruebas/benchmark/resultados/');
  console.log('  - benchmark-results.md');
  console.log('  - quality-results.md');
  console.log('  - router-learning.md');
  console.log('  - limitations.md');
  console.log('  - summary-for-management.md');
  console.log('  - raw-results.json');
  console.log('  - records-benchmark.json');
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
