#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
  buildContextFromQuery,
  buildRecord,
  createAdaptiveRouter,
  extractModelFamily,
  normalizeModel,
} from './index';
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
import { readJsonSync, stripBom } from './utils/json';

const RouteTaskSchema = z.object({
  model: z.string().describe('Modelo o familia de LLM, por ejemplo glm-5.2'),
  query: z.string().describe('Descripción de la tarea'),
  fileCount: z.number().int().min(0).default(0).describe('Número de archivos implicados'),
  contextSizeBytes: z.number().int().min(0).default(0).describe('Tamaño total del contexto en bytes'),
  toolCallsExpected: z.enum(['low', 'medium', 'high']).optional(),
  hasTerminalCommands: z.boolean().optional(),
  isRefactor: z.boolean().optional(),
  isRepositorySearch: z.boolean().optional(),
  isMultistep: z.boolean().optional(),
  explore: z.boolean().default(false).describe('Si es true, permite exploración controlada'),
  sessionId: z.string().optional().describe('Identificador de sesión para emparejar decision+execution'),
  projectId: z.string().optional().describe('Identificador del proyecto/repo'),
});

const RecordExecutionSchema = z.object({
  model: z.string(),
  query: z.string(),
  optimizer: z.enum(['BASELINE', 'DCP', 'RTK', 'CONTEXT_MODE', 'REPOMIX', 'SEMBLE']),
  tokens: z.number().int().min(0).describe('Tokens totales consumidos (usar inputTokens+outputTokens si se conoce el desglose)'),
  inputTokens: z.number().int().min(0).optional().describe('Tokens de entrada (prompt). Si se omite, se asume 0.'),
  outputTokens: z.number().int().min(0).optional().describe('Tokens de salida (completion). Si se omite, se asume 0.'),
  latencySeconds: z.number().min(0),
  toolingCost: z.number().min(0).default(0),
  costUsd: z.number().min(0).optional().describe('Coste real en USD de la ejecución'),
  quality: z.number().min(0).max(1).default(1),
  failed: z.boolean().default(false),
  retries: z.number().int().min(0).optional().describe('Número de reintentos'),
  errorMessage: z.string().optional().describe('Mensaje de error si failed=true'),
  fileCount: z.number().int().min(0).default(0),
  contextSizeBytes: z.number().int().min(0).default(0),
  contextSizeBytesAfter: z.number().int().min(0).optional().describe('Tamaño del contexto DESPUÉS de aplicar el optimizador (bytes)'),
  tokensPruned: z.number().int().min(0).optional().describe('Tokens eliminados por el optimizador (poda, compresión, etc.)'),
  actualToolCalls: z.number().int().min(0).optional().describe('Número real de tool calls ejecutados'),
  routerLatencyMs: z.number().min(0).optional().describe('Latencia del propio router al decidir (ms)'),
  startedAt: z.string().optional().describe('Timestamp ISO de inicio de la ejecución'),
  completedAt: z.string().optional().describe('Timestamp ISO de finalización de la ejecución'),
  sessionId: z.string().optional().describe('Debe coincidir con el sessionId de route_task para emparejar'),
  projectId: z.string().optional(),
  source: z.enum(['mcp', 'cli', 'benchmark', 'manual']).default('mcp'),
  synthetic: z.boolean().default(false).describe('Marcar true si los datos son sintéticos (benchmark, simulación)'),
});

const GetStatsSchema = z.object({
  model: z.string().optional().describe('Filtrar por modelo exacto'),
  taskType: z
    .enum(['SMALL_CODE', 'TERMINAL', 'LARGE_CONTEXT', 'REPOSITORY_SEARCH', 'MULTISTEP', 'REFACTOR'])
    .optional()
    .describe('Filtrar por tipo de tarea'),
  excludeSynthetic: z
    .boolean()
    .optional()
    .default(true)
    .describe('Si true (default), excluye datos sintéticos del reporte. Pasar false para incluir benchmark/simulación.'),
  format: z.enum(['v2', 'legacy']).optional().default('v2').describe('v2 = reporte enriquecido, legacy = costMatrix antiguo'),
});

const tools: Tool[] = [
  {
    name: 'route_task',
    description:
      'Selecciona el optimizador de contexto más adecuado para una tarea dado un modelo y señales de contexto. Devuelve el optimizador, la confianza, la versión del router y las alternativas consideradas. Devuelve un sessionId para emparejar con record_execution.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Modelo o familia de LLM' },
        query: { type: 'string', description: 'Descripción de la tarea' },
        fileCount: { type: 'integer', default: 0, description: 'Número de archivos implicados' },
        contextSizeBytes: { type: 'integer', default: 0, description: 'Tamaño total del contexto en bytes' },
        toolCallsExpected: { type: 'string', enum: ['low', 'medium', 'high'] },
        hasTerminalCommands: { type: 'boolean' },
        isRefactor: { type: 'boolean' },
        isRepositorySearch: { type: 'boolean' },
        isMultistep: { type: 'boolean' },
        explore: { type: 'boolean', default: false, description: 'Permitir exploración controlada' },
        sessionId: { type: 'string', description: 'Identificador de sesión' },
        projectId: { type: 'string', description: 'Identificador del proyecto' },
      },
      required: ['model', 'query'],
    },
  },
  {
    name: 'record_execution',
    description:
      'Registra el resultado real de una ejecución para que el router aprenda. Debe llamarse DESPUÉS de ejecutar la tarea con el optimizador elegido. Acepta inputTokens/outputTokens separados, costUsd y retries para reportes precisos.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        query: { type: 'string' },
        optimizer: { type: 'string', enum: ['BASELINE', 'DCP', 'RTK', 'CONTEXT_MODE', 'REPOMIX', 'SEMBLE'] },
        tokens: { type: 'integer', description: 'Tokens totales consumidos' },
        inputTokens: { type: 'integer', description: 'Tokens de entrada (prompt)' },
        outputTokens: { type: 'integer', description: 'Tokens de salida (completion)' },
        latencySeconds: { type: 'number', description: 'Latencia real en segundos' },
        toolingCost: { type: 'number', default: 0, description: 'Coste estimado del tooling' },
        costUsd: { type: 'number', description: 'Coste real en USD' },
        quality: { type: 'number', minimum: 0, maximum: 1, default: 1, description: 'Calidad del resultado 0..1' },
        failed: { type: 'boolean', default: false, description: 'true si la ejecución falló' },
        retries: { type: 'integer', description: 'Número de reintentos' },
        errorMessage: { type: 'string', description: 'Mensaje de error si failed=true' },
        fileCount: { type: 'integer', default: 0 },
        contextSizeBytes: { type: 'integer', default: 0 },
        sessionId: { type: 'string', description: 'Debe coincidir con el sessionId de route_task' },
        projectId: { type: 'string' },
        source: { type: 'string', enum: ['mcp', 'cli', 'benchmark', 'manual'], default: 'mcp' },
        synthetic: { type: 'boolean', default: false, description: 'true si datos sintéticos' },
      },
      required: ['model', 'query', 'optimizer', 'tokens', 'latencySeconds'],
    },
  },
  {
    name: 'get_router_stats',
    description:
      'Devuelve estadísticas enriquecidas del router: resumen global, desglose por modelo, desglose por (modelo, tarea) con celdas ricas (tokens absolutos, latencia, calidad, % ahorro, veredicto) y ahorro global ponderado. Por defecto usa format=v2 (enriquecido). Usa format=legacy para el costMatrix antiguo.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Filtrar por modelo exacto' },
        taskType: {
          type: 'string',
          enum: ['SMALL_CODE', 'TERMINAL', 'LARGE_CONTEXT', 'REPOSITORY_SEARCH', 'MULTISTEP', 'REFACTOR'],
          description: 'Filtrar por tipo de tarea',
        },
        excludeSynthetic: { type: 'boolean', default: true, description: 'Excluir datos sintéticos (default: true)' },
        format: { type: 'string', enum: ['v2', 'legacy'], default: 'v2' },
      },
    },
  },
  {
    name: 'migrate_history',
    description:
      'Migra el histórico v1 (ExecutionRecord) al esquema v2 (RouterEvent). Marca como synthetic=true los registros que parezcan del benchmark o CLI. Idempotente: si ya está migrado, no hace nada.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

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

function createLogger(logPath: string) {
  return {
    log(level: string, message: string, meta?: Record<string, unknown>) {
      const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        meta,
      };
      try {
        let logs: unknown[] = [];
        if (fs.existsSync(logPath)) {
          const raw = fs.readFileSync(logPath, 'utf-8');
          logs = raw.trim() ? JSON.parse(stripBom(raw)) : [];
        }
        logs.push(entry);
        fs.writeFileSync(logPath, JSON.stringify(logs, null, 2), 'utf-8');
      } catch (err) {
        console.error('[klia-token-optimizer log error]', err);
      }
    },
  };
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
  const logPath = process.env.ROUTER_LOG_PATH ?? resolvePath('./.router-history/mcp-server.log.json');
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
    logger.log('info', 'CallToolRequest recibido', { toolName: name, rawArgs });

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

        const sizeCategory = (await import('./classifier/task-classifier')).classifyContextSize(ctx.signals);
        const decision = await router.route(ctx, {
          explorationRate: args.explore ? routerOptions.explorationRate : 0,
        });

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
        const costUsd = args.costUsd ?? computeCostUsd(inputTokens, outputTokens, ctx.model, family);

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
                { recorded: true, recordId: record.id, eventId: executionEvent.id, sessionId: args.sessionId ?? null },
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
        rawArgs,
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
