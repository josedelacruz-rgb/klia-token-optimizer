import type { Optimizer, RouterDecision, RouterOptions, TaskAnalysis, TaskType } from '../types';
import { DEFAULT_ROUTER_OPTIONS } from '../types';
import {
  candidatesForAnalysis,
  candidatesForTask,
  defaultOptimizerForTask,
} from '../rules/base-rules';
import { buildCostMatrix, computeRelativeCost, keyFor } from '../scorer/expected-cost-scorer';
import type { CostScore } from '../scorer/expected-cost-scorer';
import type { ExecutionRecord } from '../types';
import { extractModelFamily } from '../utils/model-family';
import type { HistoryStore } from '../history/history-store';

export interface OptimizerSelectorDeps {
  history: HistoryStore;
}

/**
 * Calcula la confianza de una estimacion de coste relativo.
 *
 * Es una funcion simple: crece con el numero de muestras hasta un maximo.
 * Puede reemplazarse por un intervalo de confianza o posterior bayesiano en V3.
 */
function confidenceFromSamples(sampleCount: number, minSamples: number): number {
  if (sampleCount === 0) return 0;
  if (sampleCount >= minSamples * 2) return 1;
  return Math.min(1, sampleCount / minSamples);
}

export async function selectOptimizer(
  model: string,
  taskType: TaskType,
  deps: OptimizerSelectorDeps,
  options: RouterOptions = {},
  forcedDefault?: Optimizer,
  analysis?: TaskAnalysis,
): Promise<RouterDecision> {
  const opts = { ...DEFAULT_ROUTER_OPTIONS, ...options };
  const candidates = analysis ? candidatesForAnalysis(analysis) : candidatesForTask(taskType);

  // V0: reglas manuales, sin historico.
  // Cuando hay analisis, la primera opcion de la lista combinada manda: asi las
  // promociones por caracteristica secundaria (ej. TERMINAL + contexto grande ->
  // DCP) tambien rigen el fallback en frio, no solo el default ciego del taskType.
  const baseline = forcedDefault ?? candidates[0] ?? defaultOptimizerForTask(taskType);

  const records = await deps.history.query(model, taskType);

  // Si no hay datos del modelo, intentar herencia por familia.
  if (records.length === 0) {
    const family = extractModelFamily(model);
    const familyRecords = await deps.history.queryByFamily(family, taskType);

    if (familyRecords.length === 0) {
      // Sin datos del modelo ni de la familia -> V0
      return {
        optimizer: baseline,
        version: 'V0',
        reason: `No hay historial para ${model}/${taskType} ni para su familia ${family}. Se usa la regla base ${baseline}${forcedDefault ? ' (forzado por contexto)' : ''}.`,
        confidence: 0,
        taskType,
      };
    }

    // Hay datos de la familia -> usarlos con confianza reducida (V1)
    return selectFromRecords(
      familyRecords,
      model,
      taskType,
      opts,
      baseline,
      candidates,
      'V1',
      `heredados de familia ${family}`,
      opts.familyConfidenceWeight,
    );
  }

  // Hay datos del modelo -> V2 (o V1 si no hay suficiente confianza)
  return selectFromRecords(records, model, taskType, opts, baseline, candidates, 'V2', '', 1);
}

/**
 * Selecciona el mejor optimizador a partir de un conjunto de registros.
 * Usado tanto para datos del modelo como para datos heredados de la familia.
 */
function selectFromRecords(
  records: ExecutionRecord[],
  model: string,
  taskType: TaskType,
  opts: Required<RouterOptions>,
  baseline: Optimizer,
  candidates: Optimizer[],
  defaultVersion: 'V1' | 'V2',
  sourceLabel: string,
  confidenceMultiplier: number,
): RouterDecision {
  const matrix = buildCostMatrix(records, opts);
  const key = keyFor(model, taskType);
  let scores = matrix.get(key);

  // Si los registros son heredados, la clave del modelo no existira en la matriz.
  // Construir scores directamente desde los registros.
  if (!scores || scores.size === 0) {
    scores = new Map<Optimizer, CostScore>();
    const optimizers = new Set<Optimizer>(records.map((r) => r.optimizer));
    for (const optimizer of optimizers) {
      scores.set(optimizer, computeRelativeCost(records, optimizer, opts));
    }
  }

  if (scores.size === 0) {
    return {
      optimizer: baseline,
      version: 'V0',
      reason: `No hay observaciones normalizables para ${model}/${taskType}. Se usa la regla base ${baseline}.`,
      confidence: 0,
      taskType,
    };
  }

  // Preparar alternativas con coste relativo.
  const alternatives: Array<{ optimizer: Optimizer; relativeCost: number; sampleCount: number }> =
    [];
  let bestOptimizer: Optimizer = baseline;
  let bestRelativeCost = Infinity;
  let bestConfidence = 0;

  for (const [optimizer, score] of scores) {
    if (!candidates.includes(optimizer) && optimizer !== 'BASELINE') {
      continue;
    }

    const rawConfidence = confidenceFromSamples(score.sampleCount, opts.minSamples);
    const confidence = rawConfidence * confidenceMultiplier;

    alternatives.push({
      optimizer,
      relativeCost: score.relativeCost ?? Infinity,
      sampleCount: score.sampleCount,
    });

    if (score.relativeCost === null || score.relativeCost === Infinity) continue;

    if (score.relativeCost < bestRelativeCost && confidence >= opts.minConfidence) {
      bestRelativeCost = score.relativeCost;
      bestOptimizer = optimizer;
      bestConfidence = confidence;
    }
  }

  // Ordenar alternativas por coste relativo.
  alternatives.sort((a, b) => a.relativeCost - b.relativeCost);

  const sourceSuffix = sourceLabel ? ` (datos ${sourceLabel})` : '';

  if (bestRelativeCost === Infinity) {
    return {
      optimizer: baseline,
      version: defaultVersion === 'V2' ? 'V1' : defaultVersion,
      reason: `Historial insuficiente para ${model}/${taskType}${sourceSuffix}. Se usa fallback ${baseline}.`,
      confidence: 0,
      taskType,
      alternatives,
    };
  }

  // Si el mejor optimizador no logra batir a BASELINE (coste relativo >= 1.0),
  // forzar descarte y conmutar inmediatamente a BASELINE.
  if (bestOptimizer !== 'BASELINE' && bestRelativeCost >= 1.0) {
    const candidateName = bestOptimizer;
    bestOptimizer = 'BASELINE';
    const baselineAlt = alternatives.find((a) => a.optimizer === 'BASELINE');
    const version: 'V1' | 'V2' = bestConfidence >= opts.minConfidence ? 'V2' : 'V1';
    return {
      optimizer: 'BASELINE',
      version,
      reason: `Para ${model}/${taskType}, se descarta ${candidateName} (coste relativo ${bestRelativeCost.toFixed(2)}x >= 1.0; no ahorra). Se conmuta a BASELINE con ${baselineAlt?.sampleCount ?? alternatives.length} muestras${sourceSuffix}.`,
      confidence: bestConfidence,
      taskType,
      alternatives,
    };
  }

  const version: 'V1' | 'V2' = bestConfidence >= opts.minConfidence ? 'V2' : 'V1';

  // Si el ganador es BASELINE y existían otros optimizadores evaluados que gastaron más, indicarlo claramente en el reason.
  const discarded = alternatives.filter((a) => a.optimizer !== 'BASELINE' && a.relativeCost >= 1.0);
  let reasonText = `Para ${model}/${taskType}, ${bestOptimizer} tiene el menor coste relativo (${bestRelativeCost.toFixed(2)}) con ${alternatives.find((a) => a.optimizer === bestOptimizer)?.sampleCount ?? 0} muestras${sourceSuffix}.`;
  if (bestOptimizer === 'BASELINE' && discarded.length > 0) {
    const discardedNames = discarded
      .map((d) => `${d.optimizer} (${d.relativeCost.toFixed(2)}x)`)
      .join(', ');
    reasonText = `Para ${model}/${taskType}, se descarta ${discardedNames} (no ahorra respecto a BASELINE). Se elige BASELINE como la opción más eficiente${sourceSuffix}.`;
  }

  return {
    optimizer: bestOptimizer,
    version,
    reason: reasonText,
    confidence: bestConfidence,
    taskType,
    alternatives,
  };
}

/**
 * Calcula el coste relativo de un optimizador candidato sin depender de history.query.
 * Util para tests y para componentes que ya tienen los registros cargados.
 */
export function evaluateOptimizer(
  records: ExecutionRecord[],
  optimizer: Optimizer,
  options: RouterOptions = {},
): ReturnType<typeof computeRelativeCost> {
  return computeRelativeCost(records, optimizer, { ...DEFAULT_ROUTER_OPTIONS, ...options });
}
