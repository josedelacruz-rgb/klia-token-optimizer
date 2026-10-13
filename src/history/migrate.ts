import type {
  ExecutionRecord,
  McpUsageMetricLike,
  Optimizer,
  RouterEvent,
  RouterEventSource,
  TaskType,
} from '../types';
import { ROUTER_EVENT_SCHEMA_VERSION } from '../types';

/**
 * Genera un id estable para RouterEvent, mismo formato que ExecutionRecord.
 */
export function newEventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Heurístico para detectar si un registro v1 es sintético.
 *
 * Los registros del benchmark tienen timestamps agrupados (mismo segundo),
 * quality con muchos decimales (random) y tokens redondos.
 * El CLI siempre pone quality=0.98 y tokens=size/20+files*100.
 */
export function looksSynthetic(record: ExecutionRecord): boolean {
  // El CLI placeholder usa exactamente quality=0.98
  if (record.metrics.quality === 0.98) {
    // Pero el benchmark también puede usar 0.98 por casualidad; combinamos
    // con la fórmula de tokens del CLI.
    const cliTokens = Math.round(
      record.contextSnapshot.contextSizeBytes / 20 + record.contextSnapshot.fileCount * 100,
    );
    if (record.metrics.tokens === cliTokens) return true;
  }
  // quality con >6 decimales suele venir de Math.random() del benchmark.
  const q = record.metrics.quality;
  const decimales = q.toString().split('.')[1];
  if (decimales && decimales.length >= 10) return true;
  // tokens en múltiplos de 60+random*60 (CLI): no es concluyente, lo dejamos.
  return false;
}

/**
 * Migra un ExecutionRecord (v1) a un RouterEvent (v2) de tipo 'execution'.
 */
export function migrateExecutionRecord(
  record: ExecutionRecord,
  source: RouterEventSource = 'mcp',
  synthetic?: boolean,
): RouterEvent {
  const isSyn = synthetic ?? looksSynthetic(record);
  return {
    id: record.id,
    schemaVersion: ROUTER_EVENT_SCHEMA_VERSION,
    timestamp: record.timestamp,
    type: 'execution',
    sessionId: undefined,
    projectId: undefined,
    query: '',
    model: record.model,
    modelFamily: record.modelFamily ?? '',
    taskType: record.taskType,
    signals: {
      fileCount: record.contextSnapshot.fileCount,
      contextSizeBytes: record.contextSnapshot.contextSizeBytes,
      toolCallsExpected: record.contextSnapshot.toolCallsExpected,
    },
    execution: {
      optimizer: record.optimizer,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: record.metrics.tokens,
      latencySeconds: record.metrics.latencySeconds,
      costUsd: undefined,
      toolingCost: record.metrics.toolingCost,
      quality: record.metrics.quality,
      failed: record.metrics.failed,
    },
    source,
    synthetic: isSyn,
  };
}

/**
 * Migra una métrica MCP (v1) a un RouterEvent (v2) de tipo 'decision'
 * si no tiene tokens (decisión pura) o 'execution' si los tiene.
 */
export function migrateMcpMetric(
  metric: McpUsageMetricLike,
  source: RouterEventSource = 'mcp',
): RouterEvent {
  const hasExecutionMetrics =
    metric.tokens !== undefined || metric.latencySeconds !== undefined;

  if (hasExecutionMetrics) {
    return {
      id: newEventId(),
      schemaVersion: ROUTER_EVENT_SCHEMA_VERSION,
      timestamp: metric.timestamp,
      type: 'execution',
      query: '',
      model: metric.model,
      modelFamily: metric.modelFamily,
      taskType: metric.taskType as TaskType,
      signals: { fileCount: 0, contextSizeBytes: 0 },
      execution: {
        optimizer: metric.optimizer as Optimizer,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: metric.tokens ?? 0,
        latencySeconds: metric.latencySeconds ?? 0,
        costUsd: undefined,
        toolingCost: 0,
        quality: metric.quality ?? 1,
        failed: metric.failed ?? false,
      },
      source,
    };
  }

  return {
    id: newEventId(),
    schemaVersion: ROUTER_EVENT_SCHEMA_VERSION,
    timestamp: metric.timestamp,
    type: 'decision',
    query: '',
    model: metric.model,
    modelFamily: metric.modelFamily,
    taskType: metric.taskType as TaskType,
    signals: { fileCount: 0, contextSizeBytes: 0 },
    decision: {
      optimizer: metric.optimizer as Optimizer,
      version: (metric.version === 'EXECUTION'
        ? 'V0'
        : (metric.version as 'V0' | 'V1' | 'V2' | 'V3')) ?? 'V0',
      confidence: metric.confidence,
      reason: '',
    },
    source,
  };
}

/**
 * Migra un conjunto de registros v1 (ExecutionRecord[]) a eventos v2.
 */
export function migrateV1ToV2(
  records: ExecutionRecord[],
  options: { source?: RouterEventSource; forceSynthetic?: boolean } = {},
): RouterEvent[] {
  const source = options.source ?? 'mcp';
  return records.map((r) =>
    migrateExecutionRecord(r, source, options.forceSynthetic),
  );
}

/**
 * Comprueba si un archivo JSON ya está migrado a v2.
 * Si el primer elemento tiene schemaVersion === 2, se considera migrado.
 */
export function isMigratedToV2(events: unknown[]): boolean {
  if (events.length === 0) return true;
  const first = events[0] as { schemaVersion?: number };
  return first?.schemaVersion === ROUTER_EVENT_SCHEMA_VERSION;
}
