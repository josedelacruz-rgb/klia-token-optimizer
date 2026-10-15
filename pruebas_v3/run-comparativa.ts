#!/usr/bin/env node
/**
 * run-comparativa.ts - Prueba comparativa BASELINE vs OPTIMIZER en opencode real
 *
 * Protocolo simplificado para portatiles viejos:
 * - 3 tareas cortas (<90s cada una)
 * - Sin LARGE_CONTEXT, REPO_SEARCH ni REPOMIX
 * - Mide bytes de output de opencode run (no opencode stats que es acumulado)
 * - Timeout de 90s por tarea
 *
 * Uso:
 *   npx tsx pruebas_v3/run-comparativa.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(__dirname, '..');
const OPENCODE_JSON = path.join(ROOT, 'opencode.json');
const BASELINE_CONFIG = path.join(ROOT, 'opencode.baseline.json');
const OPTIMIZER_CONFIG = path.join(ROOT, 'opencode.optimizer.json');
const BACKUP_CONFIG = path.join(ROOT, 'opencode.json.backup-comparativa');
const RESULTADOS_DIR = path.join(__dirname, 'resultados');
const REPORTE_PATH = path.join(RESULTADOS_DIR, 'reporte-comparativa.md');
const DATOS_JSON_PATH = path.join(RESULTADOS_DIR, 'datos-comparativa.json');

interface Tarea {
  id: string;
  nombre: string;
  prompt: string;
}

// 3 tareas donde los optimizadores demuestran valor real:
// T1-TERMINAL_LARGE: comando con salida grande -> RTK comprime
// T2-REPO_SEARCH: buscar implementacion entre muchos archivos -> SEMBLE localiza
// T3-LARGE_CONTEXT: explicar modulo completo -> REPOMIX empaqueta firmas
const TAREAS: Tarea[] = [
  {
    id: 'T1-TERMINAL_LARGE',
    nombre: 'Git log con diffs completos',
    prompt: 'ejecuta git log -p --all -3 y resumenme los cambios principales',
  },
  {
    id: 'T2-REPO_SEARCH',
    nombre: 'Buscar donde se maneja el historial',
    prompt: 'busca en el repositorio donde se implementa el almacenamiento del historial y la persistencia de eventos',
  },
  {
    id: 'T3-LARGE_CONTEXT',
    nombre: 'Explicar modulo de scoring completo',
    prompt: 'explica como funciona el sistema de scoring y seleccion de optimizadores leyendo los archivos relevantes',
  },
];

interface MedicionTarea {
  taskId: string;
  taskName: string;
  exito: boolean;
  duracionMs: number;
  outputBytes: number;
  outputTokens: number;
  error?: string;
}

interface ResultadoFase {
  fase: 'BASELINE' | 'OPTIMIZER';
  tareas: MedicionTarea[];
  totalOutputBytes: number;
  totalOutputTokens: number;
  totalDuracionMs: number;
}

function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function runCommand(cmd: string, args: string[], options: { cwd?: string; timeout?: number } = {}): { stdout: string; stderr: string; code: number; durationMs: number } {
  const start = Date.now();
  try {
    const res = spawnSync(cmd, args, {
      cwd: options.cwd ?? ROOT,
      encoding: 'utf-8',
      shell: true,
      maxBuffer: 10 * 1024 * 1024,
      timeout: options.timeout ?? 90000,
    });
    return {
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      code: res.status ?? (res.error ? 1 : 0),
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      stdout: '',
      stderr: err.message || String(err),
      code: 1,
      durationMs: Date.now() - start,
    };
  }
}

function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 3.7));
}

function switchConfig(configPath: string): void {
  console.log(`   Config -> ${path.basename(configPath)}`);
  fs.copyFileSync(configPath, OPENCODE_JSON);
}

function backupConfig(): void {
  if (fs.existsSync(OPENCODE_JSON)) {
    fs.copyFileSync(OPENCODE_JSON, BACKUP_CONFIG);
    console.log(`   Config original respaldada`);
  }
}

function restoreConfig(): void {
  if (fs.existsSync(BACKUP_CONFIG)) {
    fs.copyFileSync(BACKUP_CONFIG, OPENCODE_JSON);
    try { fs.unlinkSync(BACKUP_CONFIG); } catch {}
    console.log(`   Config original restaurada`);
  }
}

function ejecutarTarea(tarea: Tarea): MedicionTarea {
  console.log(`     [${tarea.id}] ${tarea.prompt.slice(0, 50)}...`);

  // En Windows, opencode es un .cmd/.ps1. Necesitamos shell: true.
  // El prompt se pasa como un solo argumento entre comillas dobles.
  const start = Date.now();
  let res: { stdout: string; stderr: string; code: number; durationMs: number };
  try {
    const fullCmd = `opencode run "${tarea.prompt.replace(/"/g, '\\"')}" --auto`;
    const r = spawnSync(fullCmd, {
      cwd: ROOT,
      encoding: 'utf-8',
      shell: true,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120000,
    });
    res = {
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      code: r.status ?? (r.error ? 1 : 0),
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    res = {
      stdout: '',
      stderr: err.message || String(err),
      code: 1,
      durationMs: Date.now() - start,
    };
  }

  const output = res.stdout + (res.stderr || '');
  const outputBytes = Buffer.byteLength(res.stdout, 'utf-8');
  const outputTokens = estimateTokens(res.stdout);
  const exito = res.code === 0;

  if (!exito) {
    console.log(`     [WARN] exit=${res.code} stderr=${res.stderr.slice(0, 100)}`);
  }

  return {
    taskId: tarea.id,
    taskName: tarea.nombre,
    exito,
    duracionMs: res.durationMs,
    outputBytes,
    outputTokens,
    error: exito ? undefined : res.stderr.slice(0, 200),
  };
}

function ejecutarFase(fase: 'BASELINE' | 'OPTIMIZER', configPath: string): ResultadoFase {
  console.log(`\n===============================================================`);
  console.log(`FASE ${fase}`);
  console.log(`===============================================================`);

  switchConfig(configPath);

  // Esperar 3s para que opencode relea la config
  runCommand('timeout', ['/t', '3', '/nobreak'], { timeout: 10000 });

  const tareas: MedicionTarea[] = [];
  for (const tarea of TAREAS) {
    const medicion = ejecutarTarea(tarea);
    tareas.push(medicion);
    console.log(`     -> ${medicion.outputTokens} tokens, ${(medicion.duracionMs / 1000).toFixed(1)}s, ${medicion.exito ? 'OK' : 'FAIL'}`);
  }

  const totalOutputBytes = tareas.reduce((a, t) => a + t.outputBytes, 0);
  const totalOutputTokens = tareas.reduce((a, t) => a + t.outputTokens, 0);
  const totalDuracionMs = tareas.reduce((a, t) => a + t.duracionMs, 0);

  console.log(`   TOTAL ${fase}: ${totalOutputTokens} tokens, ${(totalDuracionMs / 1000).toFixed(1)}s`);

  return {
    fase,
    tareas,
    totalOutputBytes,
    totalOutputTokens,
    totalDuracionMs,
  };
}

function generarReporte(baseline: ResultadoFase, optimizer: ResultadoFase): void {
  const ahorroTokens = baseline.totalOutputTokens - optimizer.totalOutputTokens;
  const pct = baseline.totalOutputTokens > 0 ? ((ahorroTokens / baseline.totalOutputTokens) * 100).toFixed(1) : '0';

  let md = `# Reporte Comparativo: opencode BASELINE vs opencode OPTIMIZER\n\n`;
  md += `**Fecha:** ${new Date().toISOString()}\n`;
  md += `**Protocolo:** 2 fases, ${TAREAS.length} tareas por fase, ${TAREAS.length * 2} ejecuciones totales\n\n`;

  md += `## Resumen Global\n\n`;
  md += `| Metrica | BASELINE | OPTIMIZER | Diferencia |\n`;
  md += `|:---|---:|---:|---:|\n`;
  md += `| Tokens de salida | ${baseline.totalOutputTokens.toLocaleString()} | ${optimizer.totalOutputTokens.toLocaleString()} | ${ahorroTokens.toLocaleString()} |\n`;
  md += `| Bytes de salida | ${baseline.totalOutputBytes.toLocaleString()} | ${optimizer.totalOutputBytes.toLocaleString()} | ${(baseline.totalOutputBytes - optimizer.totalOutputBytes).toLocaleString()} |\n`;
  md += `| Duracion total (s) | ${(baseline.totalDuracionMs / 1000).toFixed(1)} | ${(optimizer.totalDuracionMs / 1000).toFixed(1)} | ${((baseline.totalDuracionMs - optimizer.totalDuracionMs) / 1000).toFixed(1)} |\n`;
  md += `| Ahorro % | 0% | - | **${pct}%** |\n\n`;

  md += `## Resultados por Tarea\n\n`;
  md += `| ID | Tarea | Tokens B | Tokens O | Ahorro | Ahorro % | Tiempo B (s) | Tiempo O (s) |\n`;
  md += `|:---|:---|---:|---:|---:|---:|---:|---:|\n`;

  for (let i = 0; i < TAREAS.length; i++) {
    const b = baseline.tareas[i];
    const o = optimizer.tareas[i];
    const diff = b.outputTokens - o.outputTokens;
    const p = b.outputTokens > 0 ? ((diff / b.outputTokens) * 100).toFixed(1) : '0';
    md += `| ${b.taskId} | ${b.taskName} | ${b.outputTokens} | ${o.outputTokens} | ${diff} | ${p}% | ${(b.duracionMs / 1000).toFixed(1)} | ${(o.duracionMs / 1000).toFixed(1)} |\n`;
  }

  md += `\n## Configuracion\n\n`;
  md += `| Componente | BASELINE | OPTIMIZER |\n`;
  md += `|:---|:---|:---|\n`;
  md += `| semble | desactivado | activado |\n`;
  md += `| repomix | desactivado | activado |\n`;
  md += `| serena | desactivado | activado |\n`;
  md += `| klia-auto-record | desactivado | activado |\n`;
  md += `| KLIA_FORCE_BASELINE | 1 | no |\n\n`;

  md += `## Conclusion\n\n`;
  if (ahorroTokens > 0) {
    md += `OPTIMIZER ahorro **${ahorroTokens.toLocaleString()} tokens (${pct}%)** frente a BASELINE.\n`;
  } else if (ahorroTokens < 0) {
    md += `OPTIMIZER uso **${Math.abs(ahorroTokens).toLocaleString()} tokens mas** que BASELINE.\n`;
  } else {
    md += `Sin diferencia.\n`;
  }

  fs.writeFileSync(REPORTE_PATH, md, 'utf-8');

  const datos = {
    fecha: new Date().toISOString(),
    tareas: TAREAS.map(t => t.id),
    baseline,
    optimizer,
    resumen: {
      totalBaseline: baseline.totalOutputTokens,
      totalOptimizer: optimizer.totalOutputTokens,
      ahorro: ahorroTokens,
      ahorroPct: parseFloat(pct),
    },
  };
  fs.writeFileSync(DATOS_JSON_PATH, JSON.stringify(datos, null, 2), 'utf-8');
}

async function main() {
  console.log('===============================================================');
  console.log('PRUEBA COMPARATIVA: BASELINE vs OPTIMIZER');
  console.log('===============================================================');
  console.log(`Tareas: ${TAREAS.length} | Fases: 2 | Total: ${TAREAS.length * 2}`);
  console.log(`Timeout por tarea: 120s`);
  console.log(`Duracion estimada: ~12 min`);
  console.log('');

  ensureDirectory(RESULTADOS_DIR);
  backupConfig();

  try {
    // FASE 1: BASELINE
    const baseline = ejecutarFase('BASELINE', BASELINE_CONFIG);

    console.log('\n   Pausa 5s...');
    runCommand('timeout', ['/t', '5', '/nobreak'], { timeout: 10000 });

    // FASE 2: OPTIMIZER
    const optimizer = ejecutarFase('OPTIMIZER', OPTIMIZER_CONFIG);

    // Reporte
    generarReporte(baseline, optimizer);

    console.log('\n===============================================================');
    console.log('COMPLETADO');
    console.log(`Reporte: ${REPORTE_PATH}`);
    console.log(`Datos:   ${DATOS_JSON_PATH}`);
    console.log('===============================================================');
  } finally {
    restoreConfig();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error fatal:', err);
    restoreConfig();
    process.exit(1);
  });
}
