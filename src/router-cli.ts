#!/usr/bin/env node
import * as fs from 'fs';
import {
  buildContextFromQuery,
  buildRecord,
  createAdaptiveRouter,
  extractModelFamily,
  normalizeModel,
} from './index';
import { analyzeTask } from './classifier/task-classifier';
import { McpMetricsStore } from './history/mcp-metrics-store';
import {
  RouterEventStore,
  createDecisionEvent,
  createExecutionEvent,
} from './history/router-event-store';
import { computeCostUsd } from './pricing/model-pricing';
import { runStatsCli } from './scripts/stats-display';
import { ALL_OPTIMIZERS } from './types';
import type { Optimizer, RouterEvent } from './types';
import { readJsonSync } from './utils/json';

/**
 * CLI unificado para el router adaptativo.
 *
 * Modos:
 *   1. Decidir optimizador (solo registra la decision, no metricas sinteticas):
 *      router --model <modelo> --query "<tarea>" [--files N] [--size N] [--history path] [--explore]
 *
 *   2. Actualizar registro con métricas reales tras ejecutar:
 *      router --record-id <id> [--tokens N] [--latency N] [--quality 0..1] [--failed] [--history path]
 *
 *   3. Registrar ejecucion con metricas reales (usado por el plugin de opencode):
 *      router --record-execution --model <modelo> --query "<tarea>" --optimizer <opt>
 *             --tokens N [--input-tokens N] [--output-tokens N] --latency N
 *             [--quality 0..1] [--cost-usd N] [--session-id <id>] [--failed]
 *             [--history path] [--events path] [--metrics path]
 *
 * Nota: A partir de la v2.0.0, el CLI ya NO registra métricas sinteticas.
 * Antes se generaba un ExecutionRecord con tokens=size/20+files*100 y quality=0.98
 * que contaminaba el historico. Ahora solo se registra la decision (sin metricas)
 * en el store unificado events.json. Para registrar metricas reales, usar
 * `record_execution` del MCP o `--record-execution` (usado por el plugin automatico).
 */
export async function runRouterCli(argv: string[]): Promise<void> {
  const args = argv.slice(2);

  // Comando `stats`: informe profesional con 8 secciones y colores ANSI.
  if (args[0] === 'stats') {
    await runStatsCli(argv);
    process.exit(0);
  }

  if (args.includes('--help') || args.length === 0) {
    console.log(`Uso:
   router stats [opciones]              Informe profesional (8 secciones, ANSI)
   router --model <modelo> --query "<tarea>" [--files N] [--size N] [--history path] [--explore]
   router --record-id <id> [--tokens N] [--latency N] [--quality 0..1] [--failed] [--history path]
   router --record-execution --model <modelo> --query "<tarea>" --optimizer <opt>
           --tokens N [--input-tokens N] [--output-tokens N] --latency N
           [--quality 0..1] [--cost-usd N] [--session-id <id>] [--failed]
           [--history path] [--events path] [--metrics path]

Ejemplos:
   router stats
   router stats --model glm-5.2 --real-only
   router --model glm-5.2 --query "refactoriza auth" --files 12 --size 250000
   router --record-id 1791207861095-5jro5tu --tokens 9500 --latency 88 --quality 0.98
   router --record-execution --model glm-5.2 --query "refactoriza auth" --optimizer DCP --tokens 9500 --input-tokens 8000 --output-tokens 1500 --latency 88 --quality 0.95 --session-id abc123

Nota: \`router stats\` muestra un informe profesional con 8 secciones.
El modo --model solo registra la decision del router (sin metricas).
Para registrar metricas reales, ejecuta la tarea y usa --record-id,
--record-execution o record_execution del MCP.
`);
    process.exit(0);
  }

  const pathModule = await import('path');

  const recordIdFlag = args.indexOf('--record-id');
  const historyFlag = args.indexOf('--history');
  const eventsFlag = args.indexOf('--events');
  const historyPath =
    historyFlag !== -1
      ? args[historyFlag + 1]
      : pathModule.join(process.cwd(), '.router-history', 'history.json');
  const eventsPath =
    eventsFlag !== -1
      ? args[eventsFlag + 1]
      : pathModule.join(process.cwd(), '.router-history', 'events.json');

  // Modo actualizar métricas reales
  if (recordIdFlag !== -1) {
    const recordId = args[recordIdFlag + 1];
    if (!fs.existsSync(historyPath)) {
      console.error(`Histórico no encontrado: ${historyPath}`);
      process.exit(1);
    }
    const records: import('./types').ExecutionRecord[] = readJsonSync(
      historyPath,
    ) as import('./types').ExecutionRecord[];
    const idx = records.findIndex((r) => r.id === recordId);
    if (idx === -1) {
      console.error(`Registro no encontrado: ${recordId}`);
      process.exit(1);
    }

    const tokensFlag = args.indexOf('--tokens');
    const latencyFlag = args.indexOf('--latency');
    const qualityFlag = args.indexOf('--quality');
    const failedFlag = args.indexOf('--failed');

    if (tokensFlag !== -1) records[idx].metrics.tokens = parseInt(args[tokensFlag + 1], 10);
    if (latencyFlag !== -1) records[idx].metrics.latencySeconds = parseFloat(args[latencyFlag + 1]);
    if (qualityFlag !== -1) records[idx].metrics.quality = parseFloat(args[qualityFlag + 1]);
    if (failedFlag !== -1) records[idx].metrics.failed = true;

    fs.writeFileSync(historyPath, JSON.stringify(records, null, 2), 'utf-8');
    console.log(`Registro actualizado: ${recordId}`);
    console.log(JSON.stringify(records[idx].metrics, null, 2));
    process.exit(0);
  }

  // Modo registrar ejecucion completa con metricas reales
  // (usado por el plugin automatico de opencode)
  const recordExecFlag = args.indexOf('--record-execution');
  if (recordExecFlag !== -1) {
    const modelExecFlag = args.indexOf('--model');
    const queryExecFlag = args.indexOf('--query');
    const optimizerFlag = args.indexOf('--optimizer');
    const tokensExecFlag = args.indexOf('--tokens');
    const inputTokensFlag = args.indexOf('--input-tokens');
    const outputTokensFlag = args.indexOf('--output-tokens');
    const latencyExecFlag = args.indexOf('--latency');
    const qualityExecFlag = args.indexOf('--quality');
    const costUsdFlag = args.indexOf('--cost-usd');
    const sessionIdFlag = args.indexOf('--session-id');
    const failedExecFlag = args.indexOf('--failed');
    const metricsFlag = args.indexOf('--metrics');
    const contextAfterFlag = args.indexOf('--context-after');
    const tokensPrunedFlag = args.indexOf('--tokens-pruned');
    const actualToolCallsFlag = args.indexOf('--actual-tool-calls');
    const routerLatencyFlag = args.indexOf('--router-latency-ms');
    const startedAtFlag = args.indexOf('--started-at');
    const completedAtFlag = args.indexOf('--completed-at');

    if (
      modelExecFlag === -1 ||
      queryExecFlag === -1 ||
      optimizerFlag === -1 ||
      tokensExecFlag === -1 ||
      latencyExecFlag === -1
    ) {
      console.error('Faltan parametros obligatorios para --record-execution.');
      console.error('Requerido: --model, --query, --optimizer, --tokens, --latency');
      process.exit(1);
    }

    const execModel = normalizeModel(args[modelExecFlag + 1]);
    const execQuery = args[queryExecFlag + 1];
    const execOptimizerRaw = args[optimizerFlag + 1];
    if (!ALL_OPTIMIZERS.includes(execOptimizerRaw as Optimizer)) {
      console.error(
        `Optimizador invalido: ${execOptimizerRaw}. Validos: ${ALL_OPTIMIZERS.join(', ')}`,
      );
      process.exit(1);
    }
    const execOptimizer = execOptimizerRaw as Optimizer;
    const execTokens = parseInt(args[tokensExecFlag + 1], 10);
    const execInputTokens = inputTokensFlag !== -1 ? parseInt(args[inputTokensFlag + 1], 10) : 0;
    const execOutputTokens = outputTokensFlag !== -1 ? parseInt(args[outputTokensFlag + 1], 10) : 0;
    const execLatency = parseFloat(args[latencyExecFlag + 1]);
    const execQuality = qualityExecFlag !== -1 ? parseFloat(args[qualityExecFlag + 1]) : 1;
    const execCostUsd =
      costUsdFlag !== -1
        ? parseFloat(args[costUsdFlag + 1])
        : computeCostUsd(
            execInputTokens,
            execOutputTokens,
            execModel,
            extractModelFamily(execModel) ?? undefined,
          );
    const execSessionId = sessionIdFlag !== -1 ? args[sessionIdFlag + 1] : undefined;
    const execFailed = failedExecFlag !== -1;
    const execContextAfter =
      contextAfterFlag !== -1 ? parseInt(args[contextAfterFlag + 1], 10) : undefined;
    const execTokensPruned =
      tokensPrunedFlag !== -1 ? parseInt(args[tokensPrunedFlag + 1], 10) : undefined;
    const execActualToolCalls =
      actualToolCallsFlag !== -1 ? parseInt(args[actualToolCallsFlag + 1], 10) : undefined;
    const execRouterLatencyMs =
      routerLatencyFlag !== -1 ? parseFloat(args[routerLatencyFlag + 1]) : undefined;
    const execStartedAt = startedAtFlag !== -1 ? args[startedAtFlag + 1] : undefined;
    const execCompletedAt = completedAtFlag !== -1 ? args[completedAtFlag + 1] : undefined;
    const metricsPath =
      metricsFlag !== -1
        ? args[metricsFlag + 1]
        : pathModule.join(process.cwd(), '.router-history', 'mcp-metrics.json');

    // 1. Registro legacy (ExecutionRecord) para que el router adaptativo aprenda
    const ctx = buildContextFromQuery(execModel, execQuery, {});
    const record = buildRecord(ctx, execOptimizer, {
      tokens: execTokens,
      latencySeconds: execLatency,
      toolingCost: 0,
      quality: execQuality,
      failed: execFailed,
    });

    const router = createAdaptiveRouter({ historyPath });
    await router.recordExecution(record);

    // 2. Evento unificado v2 (ejecucion)
    const eventStore = new RouterEventStore(eventsPath);
    const analysis = analyzeTask(ctx.signals);
    const executionEvent = createExecutionEvent({
      sessionId: execSessionId,
      query: execQuery,
      model: ctx.model,
      modelFamily: extractModelFamily(ctx.model) ?? '',
      taskType: record.taskType,
      signals: {
        fileCount: ctx.signals.fileCount,
        contextSizeBytes: ctx.signals.contextSizeBytes,
        toolCallsExpected: ctx.signals.toolCallsExpected,
      },
      analysis,
      execution: {
        optimizer: execOptimizer,
        inputTokens: execInputTokens,
        outputTokens: execOutputTokens,
        totalTokens: execTokens,
        latencySeconds: execLatency,
        costUsd: execCostUsd,
        toolingCost: 0,
        quality: execQuality,
        failed: execFailed,
        contextSizeBytesAfter: execContextAfter,
        tokensPruned: execTokensPruned,
        actualToolCalls: execActualToolCalls,
        routerLatencyMs: execRouterLatencyMs,
        startedAt: execStartedAt,
        completedAt: execCompletedAt,
      },
      source: 'mcp',
      synthetic: false,
    });
    await eventStore.add(executionEvent);

    // 3. Metricas legacy
    const metricsStore = new McpMetricsStore(metricsPath);
    metricsStore.record({
      timestamp: executionEvent.timestamp,
      model: ctx.model,
      modelFamily: extractModelFamily(ctx.model) ?? '',
      taskType: executionEvent.taskType,
      optimizer: execOptimizer,
      version: 'EXECUTION',
      confidence: 1,
      tokens: execTokens,
      latencySeconds: execLatency,
      quality: execQuality,
      failed: execFailed,
    });

    console.log(`RECORDED=true`);
    console.log(`RECORD_ID=${record.id}`);
    console.log(`EVENT_ID=${executionEvent.id}`);
    console.log(`TASK_TYPE=${record.taskType}`);
    console.log(`OPTIMIZER=${execOptimizer}`);
    console.log(`TOKENS=${execTokens}`);
    console.log(`LATENCY=${execLatency}`);
    process.exit(0);
  }

  // Modo decidir optimizador
  const modelFlag = args.indexOf('--model');
  const queryFlag = args.indexOf('--query');
  const filesFlag = args.indexOf('--files');
  const sizeFlag = args.indexOf('--size');
  const exploreFlag = args.indexOf('--explore');

  if (modelFlag === -1 || queryFlag === -1) {
    console.error('Faltan --model o --query.');
    process.exit(1);
  }

  const model = normalizeModel(args[modelFlag + 1]);
  const query = args[queryFlag + 1];
  const fileCount = filesFlag !== -1 ? parseInt(args[filesFlag + 1], 10) : 0;
  const contextSizeBytes = sizeFlag !== -1 ? parseInt(args[sizeFlag + 1], 10) : 0;

  const router = createAdaptiveRouter({
    historyPath,
    enableExploration: exploreFlag !== -1,
  });

  const ctx = buildContextFromQuery(model, query, {
    fileCount,
    contextSizeBytes,
  });

  const decision = await router.route(ctx);

  // Análisis completo: conserva señales secundarias para tareas mixtas.
  const analysis = analyzeTask(ctx.signals);

  // Registrar SOLO la decision en el store unificado v2.
  // No se registran metricas sinteticas: el historico se mantiene limpio.
  const eventStore = new RouterEventStore(eventsPath);
  const decisionEvent = createDecisionEvent({
    query,
    model: ctx.model,
    modelFamily: extractModelFamily(ctx.model) ?? '',
    taskType: decision.taskType,
    signals: {
      fileCount: ctx.signals.fileCount,
      contextSizeBytes: ctx.signals.contextSizeBytes,
      toolCallsExpected: ctx.signals.toolCallsExpected,
      hasTerminalCommands: ctx.signals.hasTerminalCommands,
      isRefactor: ctx.signals.isRefactor,
      isRepositorySearch: ctx.signals.isRepositorySearch,
      isMultistep: ctx.signals.isMultistep,
    },
    analysis,
    decision: {
      optimizer: decision.optimizer,
      version: decision.version,
      confidence: decision.confidence,
      reason: decision.reason,
      alternatives: decision.alternatives,
    },
    source: 'cli',
  });
  await eventStore.add(decisionEvent);

  console.log(`OPTIMIZER=${decision.optimizer}`);
  console.log(`TASK_TYPE=${decision.taskType}`);
  console.log(`VERSION=${decision.version}`);
  console.log(`CONFIDENCE=${decision.confidence}`);
  console.log(`REASON=${decision.reason}`);
  console.log(`SESSION_ID=${decisionEvent.sessionId ?? decisionEvent.id}`);
  console.log(`EVENT_ID=${decisionEvent.id}`);
  console.log('');
  console.log('Para registrar metricas reales tras ejecutar la tarea, usa:');
  console.log(`  record_execution (MCP) con sessionId=${decisionEvent.id}`);
  console.log('');
  console.log(JSON.stringify(decision, null, 2));
}

if (require.main === module) {
  runRouterCli(process.argv).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
