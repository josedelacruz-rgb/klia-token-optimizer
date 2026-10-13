import type { ExecutionRecord, Optimizer, RouterOptions, TaskType } from '../types';
import { DEFAULT_ROUTER_OPTIONS } from '../types';

export interface CostScore {
  /** Coste absoluto combinado según la función de score. */
  absoluteCost: number;
  /** Coste relativo al baseline para la misma (modelo, tarea). null si no hay baseline. */
  relativeCost: number | null;
  /** Número de observaciones usadas. */
  sampleCount: number;
}

/**
 * Calcula el coste absoluto de un registro usando la función de score:
 *
 *   tokens
 * + latency * latencyWeight
 * + toolingCost * toolingCostWeight
 * + failurePenalty (si failed)
 * + qualityPenalty * (1 - quality)
 */
export function computeRecordCost(
  record: ExecutionRecord,
  options: Required<RouterOptions>,
): number {
  const { metrics } = record;
  let cost = metrics.tokens;
  cost += metrics.latencySeconds * options.latencyWeight;
  cost += metrics.toolingCost * options.toolingCostWeight;
  if (metrics.failed) {
    cost += options.failurePenalty;
  }
  cost += options.qualityPenalty * (1 - metrics.quality);
  return cost;
}

/**
 * Calcula el coste relativo de un optimizador para una (modelo, tarea).
 *
 * Si no hay registros baseline, el coste relativo es Infinity para indicar
 * que no se puede normalizar.
 */
export function computeRelativeCost(
  records: ExecutionRecord[],
  optimizer: Optimizer,
  options: Required<RouterOptions>,
): CostScore {
  const optimizerRecords = records.filter((r) => r.optimizer === optimizer);
  const baselineRecords = records.filter((r) => r.optimizer === 'BASELINE');

  if (optimizerRecords.length === 0) {
    return { absoluteCost: Infinity, relativeCost: Infinity, sampleCount: 0 };
  }

  const avgOptimizerCost =
    optimizerRecords.reduce((sum, r) => sum + computeRecordCost(r, options), 0) /
    optimizerRecords.length;

  const avgBaselineCost =
    baselineRecords.length > 0
      ? baselineRecords.reduce((sum, r) => sum + computeRecordCost(r, options), 0) / baselineRecords.length
      : avgOptimizerCost;

  const relativeCost = avgOptimizerCost / avgBaselineCost;

  return {
    absoluteCost: avgOptimizerCost,
    relativeCost,
    sampleCount: optimizerRecords.length,
  };
}

/**
 * Agrupa registros por (modelo, tarea) y devuelve una tabla de costes relativos.
 */
export function buildCostMatrix(
  records: ExecutionRecord[],
  options: RouterOptions = {},
): Map<string, Map<Optimizer, CostScore>> {
  const opts = { ...DEFAULT_ROUTER_OPTIONS, ...options };

  // Agrupar por modelo + tarea.
  const groups = new Map<string, ExecutionRecord[]>();
  for (const record of records) {
    const key = `${record.model}::${record.taskType}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(record);
  }

  const matrix = new Map<string, Map<Optimizer, CostScore>>();
  for (const [key, groupRecords] of groups) {
    const optimizers = new Set<Optimizer>(groupRecords.map((r) => r.optimizer));
    const scores = new Map<Optimizer, CostScore>();
    for (const optimizer of optimizers) {
      scores.set(optimizer, computeRelativeCost(groupRecords, optimizer, opts));
    }
    matrix.set(key, scores);
  }

  return matrix;
}

export function keyFor(model: string, taskType: TaskType): string {
  return `${model}::${taskType}`;
}
