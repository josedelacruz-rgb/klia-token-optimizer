import { classifyTask, extractSignalsFromQuery, analyzeTask } from './classifier/task-classifier';
import type { TaskClassifierOptions } from './classifier/task-classifier';
import { createExecutionRecord, JsonHistoryStore } from './history/history-store';
import { extractModelFamily, normalizeModel } from './utils/model-family';
import { selectOptimizerWithExploration } from './selector/exploration';
import type {
  ExecutionRecord,
  Optimizer,
  RouterContext,
  RouterDecision,
  RouterOptions,
  TaskSignals,
} from './types';
import { DEFAULT_ROUTER_OPTIONS } from './types';

export interface AdaptiveRouter {
  route(ctx: RouterContext, opts?: RouterOptions): Promise<RouterDecision>;
  recordExecution(record: ExecutionRecord): Promise<void>;
  inferTaskType(signals: TaskSignals): import('./types').TaskType;
}

export interface AdaptiveRouterOptions {
  /** Ruta del archivo JSON de histórico. */
  historyPath: string;
  /** Opciones por defecto del router. */
  routerOptions?: RouterOptions;
  /** Si es false, nunca se usa exploración automática (V3). Por defecto true. */
  enableExploration?: boolean;
  /** Función para extraer la familia de un modelo. */
  modelFamilyExtractor?: (model: string) => string | undefined;
  /** Opciones para el clasificador de tareas (umbrales de contexto grande, etc.). */
  taskClassifierOptions?: TaskClassifierOptions;
}

export function createAdaptiveRouter(config: AdaptiveRouterOptions): AdaptiveRouter {
  const history = new JsonHistoryStore({ filePath: config.historyPath });
  const baseRouterOptions = { ...DEFAULT_ROUTER_OPTIONS, ...(config.routerOptions ?? {}) };
  const enableExploration = config.enableExploration ?? true;
  const modelFamilyExtractor = config.modelFamilyExtractor ?? extractModelFamily;
  const taskClassifierOptions = config.taskClassifierOptions ?? {};

  return {
    inferTaskType(signals) {
      return classifyTask(signals, taskClassifierOptions);
    },

    async route(ctx, opts) {
      const analysis = analyzeTask(ctx.signals, taskClassifierOptions);
      const taskType = analysis.taskType;
      const options = { ...baseRouterOptions, ...(opts ?? {}) };

      // El forzado de SEMBLE para LARGE_CONTEXT extremo se elimino:
      // el tamano de contexto es una caracteristica, no un tipo de tarea.
      // SEMBLE ya es el primer candidato en BASE_RULES para LARGE_CONTEXT,
      // y el selector lo elegira si la evidencia lo respalda.

      if (enableExploration) {
        const result = await selectOptimizerWithExploration(ctx.model, taskType, { history }, options, undefined, undefined, analysis);
        return result.decision;
      }
      const records = await history.query(ctx.model, taskType);
      if (records.length === 0) {
        const { defaultOptimizerForTask } = await import('./rules/base-rules');
        const baseline = defaultOptimizerForTask(taskType);
        return {
          optimizer: baseline,
          version: 'V0',
          reason: `No hay historial para ${ctx.model}/${taskType}. Se usa la regla base ${baseline}.`,
          confidence: 0,
          taskType,
        };
      }
      const { selectOptimizer } = await import('./selector/optimizer-selector');
      return selectOptimizer(ctx.model, taskType, { history }, options, undefined, analysis);
    },

    async recordExecution(record) {
      await history.add(record);
    },
  };
}

export function buildContextFromQuery(
  model: string,
  query: string,
  base: Partial<TaskSignals> = {},
): RouterContext {
  const signals = extractSignalsFromQuery(query, base);
  return { model, signals };
}

export function buildRecord(
  ctx: RouterContext,
  optimizer: Optimizer,
  metrics: ExecutionRecord['metrics'],
  modelFamilyExtractor?: (model: string) => string | undefined,
): ExecutionRecord {
  const extractor = modelFamilyExtractor ?? extractModelFamily;
  return createExecutionRecord(
    ctx.model,
    extractor(ctx.model),
    classifyTask(ctx.signals),
    optimizer,
    metrics,
    {
      fileCount: ctx.signals.fileCount,
      contextSizeBytes: ctx.signals.contextSizeBytes,
      toolCallsExpected: ctx.signals.toolCallsExpected,
    },
  );
}

export {
  classifyTask,
  extractSignalsFromQuery,
  analyzeTask,
  createExecutionRecord,
  JsonHistoryStore,
  selectOptimizerWithExploration,
  extractModelFamily,
  normalizeModel,
  DEFAULT_ROUTER_OPTIONS,
};
export type { RouterContext, RouterDecision, RouterOptions, TaskSignals };

// Re-exportar store de metricas MCP para uso externo.
export { McpMetricsStore } from './history/mcp-metrics-store';

// Re-exportar descubrimiento de modelos KLIA.
export {
  discoverModels,
  discoverModelsFromApi,
  detectKliaApiKey,
  SNAPSHOT_MODELS,
} from './klia-discovery';
export type { DiscoveredModel, DiscoveryResult } from './klia-discovery';

// Re-exportar utilidades de modelo para uso externo.
export { isChatModel } from './utils/model-family';
