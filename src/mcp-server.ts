#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
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
import { buildCostMatrix, keyFor } from './scorer/expected-cost-scorer';
import { buildStatsReport } from './scorer/stats-report';
import { computeCostUsd } from './pricing/model-pricing';
import { DEFAULT_ROUTER_OPTIONS } from './types';
import type { Optimizer, RouterOptions, RouterEvent } from './types';
import { readJsonSync } from './utils/json';
import { createLogger } from './mcp/logger';
import { RouteTaskSchema, RecordExecutionSchema, GetStatsSchema, tools } from './mcp/tools';

function loadRouterOptionsFromEnv(): Partial<RouterOptions> {
  const parseFloatEnv = (name: string): number | undefined => {
    const value = process.env[name];
    if (value === undefined || value === '') return undefined;
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  };

  return {
    minConfidence: parseFloatEnv('ROUTER_MIN_CONFIDENCE'),
    explorationRate: parseFloatEnv('ROUTER_EXPLORATION_RATE'),
    minSamples: parseFloatEnv('ROUTER_MIN_SAMPLES'),
    latencyWeight: parseFloatEnv('ROUTER_LATENCY_WEIGHT'),
    toolingCostWeight: parseFloatEnv('ROUTER_TOOLING_COST_WEIGHT'),
    failurePenalty: parseFloatEnv('ROUTER_FAILURE_PENALTY'),
    qualityPenalty: parseFloatEnv('ROUTER_QUALITY_PENALTY'),
  };
}

function findProjectRoot(): string {
  let current = __dirname;
  while (current !== path.dirname(current)) {
    const packageJson = path.join(current, 'package.json');
    if (fs.existsSync(packageJson)) {
      try {
        const pkg = readJsonSync(packageJson) as { name?: string };
        if (pkg.name === 'klia-token-optimizer') {
          return current;
        }
      } catch {
        // continuar
      }
    }
    current = path.dirname(current);
  }
  return path.resolve(__dirname, '..');
}

function resolvePath(value: string): string {
  if (path.isAbsolute(value)) return value;
  return path.resolve(findProjectRoot(), value);
}

/**
 * Genera un sessionId aleatorio corto si no se proporciona uno.
 */
function newSessionId(): string {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main() {
  const rawHistoryPath = process.env.ROUTER_HISTORY_PATH ?? './.router-history/history.json';
  const rawEventsPath = process.env.ROUTER_EVENTS_PATH ?? './.router-history/events.json';
  const rawMetricsPath = process.env.ROUTER_METRICS_PATH ?? './.router-history/mcp-metrics.json';
  const historyPath = resolvePath(rawHistoryPath);
  const eventsPath = resolvePath(rawEventsPath);
  const metricsPath = resolvePath(rawMetricsPath);
  const logPath =
    process.env.ROUTER_LOG_PATH ?? resolvePath('./.router-history/mcp-server.log.json');
  const routerOptions = { ...DEFAULT_ROUTER_OPTIONS, ...loadRouterOptionsFromEnv() };
  const logger = createLogger(logPath);

  const router = createAdaptiveRouter({
    historyPath,
    enableExploration: false,
    routerOptions,
    modelFamilyExtractor: extractModelFamily,
  });
  // Store legacy para compatibilidad (mcp-metrics.json).
  const metricsStore = new McpMetricsStore(metricsPath);
  // Store unificado v2.
  const eventStore = new RouterEventStore(eventsPath);

  logger.log('info', 'Router MCP server inicializando', {
    historyPath,
    eventsPath,
    metricsPath,
    logPath,
  });

  const server = new Server(
    {
      name: 'klia-token-optimizer',
      version: '2.0.0',
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.log('debug', 'ListToolsRequest recibido', { toolCount: tools.length });
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    logger.log('info', 'CallToolRequest recibido', { toolName: name });

    try {
      if (name === 'route_task') {
        const args = RouteTaskSchema.parse(rawArgs);
        const sessionId = args.sessionId ?? newSessionId();
        const normalizedModel = normalizeModel(args.model);
        // Si no se pasa projectId, derivarlo del cwd para segmentar por proyecto.
        const projectId = args.projectId ?? process.cwd();
        const ctx = buildContextFromQuery(normalizedModel, args.query, {
          fileCount: args.fileCount,
          contextSizeBytes: args.contextSizeBytes,
          toolCallsExpected: args.toolCallsExpected,
          hasTerminalCommands: args.hasTerminalCommands,
          isRefactor: args.isRefactor,
          isRepositorySearch: args.isRepositorySearch,
          isMultistep: args.isMultistep,
        });

        const sizeCategory = (await import('./classifier/task-classifier')).classifyContextSize(
          ctx.signals,
        );
        const decision = await router.route(ctx, {
          explorationRate: args.explore ? routerOptions.explorationRate : 0,
        });

        // Análisis completo: conserva señales secundarias para tareas mixtas.
        const analysis = analyzeTask(ctx.signals);

        // Registrar evento unificado v2 (decisión).
        const decisionEvent = createDecisionEvent({
          sessionId,
          projectId,
          query: args.query,
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
          source: 'mcp',
        });
        await eventStore.add(decisionEvent);

        // Mantener registro en el store legacy por compatibilidad.
        metricsStore.record({
          timestamp: decisionEvent.timestamp,
          model: ctx.model,
          modelFamily: extractModelFamily(ctx.model),
          taskType: decision.taskType,
          optimizer: decision.optimizer,
          version: decision.version,
          confidence: decision.confidence,
        });

        logger.log('info', 'route_task completado', { sizeCategory, decision, sessionId });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ...decision, sessionId }, null, 2),
            },
          ],
        };
      }

      if (name === 'record_execution') {
        const args = RecordExecutionSchema.parse(rawArgs);
        const normalizedModel = normalizeModel(args.model);
        const ctx = buildContextFromQuery(normalizedModel, args.query, {
          fileCount: args.fileCount,
          contextSizeBytes: args.contextSizeBytes,
        });

        const inputTokens = args.inputTokens ?? 0;
        const outputTokens = args.outputTokens ?? 0;
        const totalTokens = args.tokens;

        // Si no se pasa costUsd, estimarlo con la tabla de pricing.
        const family = extractModelFamily(ctx.model) ?? undefined;
        const costUsd =
          args.costUsd ?? computeCostUsd(inputTokens, outputTokens, ctx.model, family);

        // Registro legacy (ExecutionRecord) para que el router adaptativo
        // siga aprendiendo. Tambien nos da el taskType ya clasificado.
        const record = buildRecord(ctx, args.optimizer, {
          tokens: totalTokens,
          latencySeconds: args.latencySeconds,
          toolingCost: args.toolingCost,
          quality: args.quality,
          failed: args.failed,
        });
        await router.recordExecution(record);

        // Análisis completo: conserva señales secundarias para tareas mixtas.
        const analysis = analyzeTask(ctx.signals);

        // Evento unificado v2 (ejecución).
        const projectId = args.projectId ?? process.cwd();
        const executionEvent = createExecutionEvent({
          sessionId: args.sessionId,
          projectId,
          query: args.query,
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
            optimizer: args.optimizer,
            inputTokens,
            outputTokens,
            totalTokens,
            latencySeconds: args.latencySeconds,
            costUsd,
            toolingCost: args.toolingCost,
            quality: args.quality,
            failed: args.failed,
            retries: args.retries,
            errorMessage: args.errorMessage,
            contextSizeBytesAfter: args.contextSizeBytesAfter,
            tokensPruned: args.tokensPruned,
            actualToolCalls: args.actualToolCalls,
            routerLatencyMs: args.routerLatencyMs,
            startedAt: args.startedAt,
            completedAt: args.completedAt,
          },
          source: args.source,
          synthetic: args.synthetic,
        });
        await eventStore.add(executionEvent);

        metricsStore.record({
          timestamp: executionEvent.timestamp,
          model: ctx.model,
          modelFamily: extractModelFamily(ctx.model),
          taskType: executionEvent.taskType,
          optimizer: args.optimizer,
          version: 'EXECUTION',
          confidence: 1,
          tokens: totalTokens,
          latencySeconds: args.latencySeconds,
          quality: args.quality,
          failed: args.failed,
        });

        logger.log('info', 'record_execution completado', {
          recordId: record.id,
          eventId: executionEvent.id,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  recorded: true,
                  recordId: record.id,
                  eventId: executionEvent.id,
                  sessionId: args.sessionId ?? null,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (name === 'get_router_stats') {
        const args = GetStatsSchema.parse(rawArgs ?? {});

        // Formato legacy: devuelve el costMatrix antiguo para compatibilidad.
        if (args.format === 'legacy') {
          const allRecords = await new (await import('./history/history-store')).JsonHistoryStore({
            filePath: historyPath,
          }).list();
          const filtered = allRecords.filter((r) => {
            const matchesModel = !args.model || r.model === args.model;
            const matchesTask = !args.taskType || r.taskType === args.taskType;
            return matchesModel && matchesTask;
          });

          const matrix = buildCostMatrix(filtered, routerOptions);
          const serializableMatrix: Record<
            string,
            Partial<Record<Optimizer, { relativeCost: number | null; sampleCount: number }>>
          > = {};
          for (const [key, scores] of matrix) {
            serializableMatrix[key] = {};
            for (const [optimizer, score] of scores) {
              serializableMatrix[key][optimizer] = {
                relativeCost: score.relativeCost,
                sampleCount: score.sampleCount,
              };
            }
          }

          const stats = {
            format: 'legacy',
            totalRecords: filtered.length,
            uniqueModels: [...new Set(filtered.map((r) => r.model))],
            costMatrix: serializableMatrix,
            mcpUsageSummary: metricsStore.summary(),
          };
          logger.log('info', 'get_router_stats (legacy) completado', { format: 'legacy' });
          return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
        }

        // Formato v2 (default): reporte enriquecido.
        let events = eventStore.list();
        if (args.model) {
          events = events.filter((e) => e.model === args.model);
        }
        if (args.taskType) {
          events = events.filter((e) => e.taskType === args.taskType);
        }
        if (args.excludeSynthetic) {
          events = events.filter((e) => !e.synthetic);
        }

        const report = buildStatsReport(events, routerOptions);
        logger.log('info', 'get_router_stats (v2) completado', {
          totalEvents: events.length,
          totalExecutions: report.summary.totalExecutions,
        });
        return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
      }

      if (name === 'migrate_history') {
        const migrated = eventStore.migrateFile();
        logger.log('info', 'migrate_history completado', { migratedCount: migrated });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { migrated: migrated > 0, migratedCount: migrated, eventsPath },
                null,
                2,
              ),
            },
          ],
        };
      }

      throw new Error(`Tool desconocida: ${name}`);
    } catch (err) {
      logger.log('error', 'Error en CallToolRequest', {
        toolName: name,
        error: (err as Error).message,
      });
      throw err;
    }
  });

  const transport = new StdioServerTransport();

  transport.onerror = (err) => {
    logger.log('error', 'Error en transporte MCP', { error: err.message });
  };

  transport.onclose = () => {
    logger.log('info', 'Transporte MCP cerrado');
  };

  await server.connect(transport);

  console.error(`Router MCP server v2.0.0 escuchando en stdio`);
  console.error(`History (v1): ${historyPath}`);
  console.error(`Events (v2): ${eventsPath}`);
  console.error(`Metrics: ${metricsPath}`);
  console.error(`Logs: ${logPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
