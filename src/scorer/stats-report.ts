import type {
  Optimizer,
  RouterEvent,
  RouterOptions,
  TaskType,
} from '../types';
import { DEFAULT_ROUTER_OPTIONS } from '../types';
import { computeCostUsd, getPricing } from '../pricing/model-pricing';

/**
 * Celda enriquecida para un optimizador dentro de una combinación (modelo, tarea).
 * Sustituye al {relativeCost, sampleCount} del esquema v1.
 */
export interface OptimizerCell {
  optimizer: Optimizer;
  samples: number;
  avgTokens: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgLatency: number;
  avgQuality: number;
  failureRate: number;
  /** Coste absoluto medio combinando tokens, latencia, tooling, fallo, calidad. */
  avgAbsoluteCost: number;
  /** Coste relativo al BASELINE de la misma combinación. null si no hay baseline. */
  relativeCost: number | null;
  /** Ahorro frente a BASELINE en tokens absolutos (positivo = ahorro). */
  savingsTokens: number | null;
  /** Ahorro frente a BASELINE en % (positivo = ahorro). */
  savingsPercent: number | null;
  /** Ahorro estimado en USD frente a BASELINE. */
  savingsUsd: number | null;
  /** Veredicto legible: AHORRO | PERDIDA | NEUTRO. */
  verdict: 'AHORRO' | 'PERDIDA' | 'NEUTRO';
  /** true si es el optimizador con menor coste (mayor ahorro) y samples >= minSamples. */
  winner: boolean;
}

export interface ModelTaskRow {
  model: string;
  modelFamily: string;
  taskType: TaskType;
  /** Muestras totales en la combinación. */
  totalSamples: number;
  /** Datos del BASELINE si existe. */
  baseline: {
    samples: number;
    avgTokens: number;
    avgLatency: number;
    avgQuality: number;
    avgAbsoluteCost: number;
  } | null;
  /** Una celda por cada optimizador con muestras. */
  optimizers: OptimizerCell[];
  /** Optimizador ganador (mayor ahorro con samples suficientes). */
  bestOptimizer: Optimizer | null;
}

export interface ModelRow {
  model: string;
  modelFamily: string;
  executions: number;
  avgTokens: number;
  avgLatency: number;
  avgQuality: number;
  failureRate: number;
  /** Mejor optimizador global para este modelo. */
  bestOptimizer: Optimizer | null;
  /** Ahorro medio ponderado vs BASELINE (%). */
  savingsVsBaselinePercent: number;
  /** Ahorro total en tokens frente a BASELINE. */
  savingsVsBaselineTokens: number;
}

export interface RouterStatsReport {
  summary: {
    totalDecisions: number;
    totalExecutions: number;
    syntheticCount: number;
    realCount: number;
    /** Número de modelos con al menos una ejecución real (no sintética). */
    realModels: number;
    uniqueModels: string[];
    uniqueModelFamilies: string[];
    uniqueTaskTypes: TaskType[];
    dateRange: { from: string | null; to: string | null };
    confidenceLevel: 'Insuficiente' | 'Bajo' | 'Medio' | 'Alto';
    /** Decisiones sin ejecución asociada (por sessionId). */
    orphanDecisions: number;
    /** Decisiones emparejadas con ejecución. */
    matchedDecisions: number;
  };
  byModel: ModelRow[];
  byModelTask: ModelTaskRow[];
  globalSavings: {
    /** Ahorro ponderado global (%). */
    weightedSavingsPercent: number;
    /** Tokens totales ahorrados vs BASELINE (suma ponderada). */
    totalTokensSaved: number;
    /** USD totales ahorrados vs BASELINE. */
    totalUsdSaved: number;
    /** Veredicto literal legible. */
    verdict: string;
  };
  /** Calibración de la confianza declarada vs resultado real. */
  confidenceCalibration: {
    /** Pares decisión+ejecución emparejados por sessionId. */
    pairsMatched: number;
    /** Confianza media declarada en las decisiones emparejadas. */
    avgDeclaredConfidence: number;
    /** Calidad media real de las ejecuciones emparejadas. */
    avgActualQuality: number;
    /** Tasa de fallo cuando confidence >= minConfidence. */
    failureRateHighConfidence: number;
    /** Score de calibración 0..1 (1 = bien calibrado). */
    calibrationScore: number;
    /** Veredicto de calibración legible. */
    verdict: string;
  };
}

/**
 * Calcula el coste absoluto de un evento de ejecución.
 * Misma fórmula que computeRecordCost del esquema v1, pero sobre RouterEvent.
 */
export function computeEventCost(
  event: RouterEvent,
  options: Required<RouterOptions>,
): number {
  if (!event.execution) return Infinity;
  const m = event.execution;
  const tokens = m.totalTokens > 0 ? m.totalTokens : m.inputTokens + m.outputTokens;
  let cost = tokens;
  cost += m.latencySeconds * options.latencyWeight;
  cost += m.toolingCost * options.toolingCostWeight;
  if (m.failed) {
    cost += options.failurePenalty;
  }
  cost += options.qualityPenalty * (1 - m.quality);
  return cost;
}

interface AggregatedExec {
  samples: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalLatency: number;
  totalQuality: number;
  failures: number;
  totalCost: number;
}

function aggregateExecutions(events: RouterEvent[]): AggregatedExec {
  const agg: AggregatedExec = {
    samples: 0,
    totalTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalLatency: 0,
    totalQuality: 0,
    failures: 0,
    totalCost: 0,
  };
  for (const e of events) {
    if (!e.execution) continue;
    agg.samples++;
    agg.totalTokens += e.execution.totalTokens || (e.execution.inputTokens + e.execution.outputTokens);
    agg.totalInputTokens += e.execution.inputTokens;
    agg.totalOutputTokens += e.execution.outputTokens;
    agg.totalLatency += e.execution.latencySeconds;
    agg.totalQuality += e.execution.quality;
    if (e.execution.failed) agg.failures++;
  }
  return agg;
}

/**
 * Construye el reporte enriquecido de estadísticas a partir de eventos v2.
 */
export function buildStatsReport(
  events: RouterEvent[],
  options: RouterOptions = {},
): RouterStatsReport {
  const opts = { ...DEFAULT_ROUTER_OPTIONS, ...options };
  const executions = events.filter((e) => e.type === 'execution' && e.execution);
  const decisions = events.filter((e) => e.type === 'decision');

  // --- summary ---
  const timestamps = events.map((e) => e.timestamp).sort();
  const realExecutions = executions.filter((e) => !e.synthetic);
  const syntheticExecutions = executions.filter((e) => e.synthetic);
  const totalReal = realExecutions.length;
  const totalSynthetic = syntheticExecutions.length;

  const uniqueModels = [...new Set(executions.map((e) => e.model))].sort();
  const uniqueFamilies = [...new Set(executions.map((e) => e.modelFamily))].sort();
  const uniqueTaskTypes = [...new Set(executions.map((e) => e.taskType))].sort() as TaskType[];
  const realModels = new Set(realExecutions.map((e) => e.model)).size;

  const confidenceLevel: RouterStatsReport['summary']['confidenceLevel'] =
    executions.length < 10
      ? 'Insuficiente'
      : executions.length <= 30
        ? 'Bajo'
        : executions.length <= 100
          ? 'Medio'
          : 'Alto';

  // --- Agrupar ejecuciones por (modelo, tarea) ---
  const groupByModelTask = new Map<string, RouterEvent[]>();
  for (const e of executions) {
    const key = `${e.model}::${e.taskType}`;
    if (!groupByModelTask.has(key)) groupByModelTask.set(key, []);
    groupByModelTask.get(key)!.push(e);
  }

  const byModelTask: ModelTaskRow[] = [];
  const winnerRows: { savingsPercent: number; samples: number }[] = [];

  for (const [key, groupEvents] of groupByModelTask) {
    const [model, taskType] = key.split('::') as [string, TaskType];
    const modelFamily = groupEvents[0]?.modelFamily ?? '';

    // Agrupar por optimizador dentro de la combinación
    const byOptimizer = new Map<Optimizer, RouterEvent[]>();
    for (const e of groupEvents) {
      const opt = e.execution!.optimizer;
      if (!byOptimizer.has(opt)) byOptimizer.set(opt, []);
      byOptimizer.get(opt)!.push(e);
    }

    // Calcular baseline si existe
    const baselineEvents = byOptimizer.get('BASELINE') ?? [];
    const baselineAgg = aggregateExecutions(baselineEvents);
    const baselineAvgCost =
      baselineAgg.samples > 0
        ? groupEvents
            .filter((e) => e.execution!.optimizer === 'BASELINE')
            .reduce((sum, e) => sum + computeEventCost(e, opts), 0) / baselineAgg.samples
        : null;
    const baselineAvgTokens = baselineAgg.samples > 0 ? baselineAgg.totalTokens / baselineAgg.samples : null;

    const cells: OptimizerCell[] = [];
    let bestCell: OptimizerCell | null = null;

    for (const [optimizer, optEvents] of byOptimizer) {
      const agg = aggregateExecutions(optEvents);
      const avgTokens = agg.samples > 0 ? agg.totalTokens / agg.samples : 0;
      const avgInputTokens = agg.samples > 0 ? agg.totalInputTokens / agg.samples : 0;
      const avgOutputTokens = agg.samples > 0 ? agg.totalOutputTokens / agg.samples : 0;
      const avgLatency = agg.samples > 0 ? agg.totalLatency / agg.samples : 0;
      const avgQuality = agg.samples > 0 ? agg.totalQuality / agg.samples : 0;
      const failureRate = agg.samples > 0 ? agg.failures / agg.samples : 0;
      const avgAbsoluteCost =
        agg.samples > 0
          ? optEvents.reduce((sum, e) => sum + computeEventCost(e, opts), 0) / agg.samples
          : Infinity;

      let relativeCost: number | null = null;
      let savingsTokens: number | null = null;
      let savingsPercent: number | null = null;
      let savingsUsd: number | null = null;

      if (baselineAvgCost !== null && baselineAvgCost > 0) {
        relativeCost = avgAbsoluteCost / baselineAvgCost;
      }
      if (baselineAvgTokens !== null) {
        savingsTokens = baselineAvgTokens - avgTokens;
        savingsPercent = baselineAvgTokens > 0 ? ((baselineAvgTokens - avgTokens) / baselineAvgTokens) * 100 : 0;
      }

      // Ahorro en USD: convertir tokens ahorrados a coste USD.
      if (savingsTokens !== null && savingsTokens > 0) {
        const pricing = getPricing(model, modelFamily);
        // Aproximación: el ahorro en tokens se prorrea como mix de input/output.
        // Usamos el precio medio como estimación conservadora.
        const avgPrice = (pricing.inputPerMillion + pricing.outputPerMillion) / 2;
        savingsUsd = Math.round((savingsTokens / 1_000_000) * avgPrice * 1_000_000) / 1_000_000;
      } else {
        savingsUsd = 0;
      }

      let verdict: OptimizerCell['verdict'] = 'NEUTRO';
      if (savingsPercent !== null && agg.samples >= opts.minSamples) {
        if (savingsPercent > 0.5) verdict = 'AHORRO';
        else if (savingsPercent < -0.5) verdict = 'PERDIDA';
      }

      const cell: OptimizerCell = {
        optimizer,
        samples: agg.samples,
        avgTokens: round1(avgTokens),
        avgInputTokens: round1(avgInputTokens),
        avgOutputTokens: round1(avgOutputTokens),
        avgLatency: round1(avgLatency),
        avgQuality: round3(avgQuality),
        failureRate: round3(failureRate),
        avgAbsoluteCost: round3(avgAbsoluteCost === Infinity ? Infinity : avgAbsoluteCost),
        relativeCost: relativeCost === null ? null : round3(relativeCost),
        savingsTokens: savingsTokens === null ? null : Math.round(savingsTokens),
        savingsPercent: savingsPercent === null ? null : round1(savingsPercent),
        savingsUsd,
        verdict,
        winner: false,
      };
      cells.push(cell);

      // Considerar como ganador si tiene samples suficientes, menor coste
      // Y realmente ahorra frente a BASELINE (savingsPercent > 0).
      if (agg.samples >= opts.minSamples && optimizer !== 'BASELINE') {
        const isCheaper =
          bestCell === null ||
          avgAbsoluteCost < (bestCell.avgAbsoluteCost === Infinity ? Infinity : bestCell.avgAbsoluteCost);
        const savesVsBaseline =
          cell.savingsPercent !== null && cell.savingsPercent > 0;
        if (isCheaper && savesVsBaseline) {
          bestCell = cell;
        }
      }
    }

    // Marcar el ganador en la celda correspondiente
    let bestOptimizer: Optimizer | null = null;
    if (bestCell !== null) {
      bestCell.winner = true;
      bestOptimizer = bestCell.optimizer;
      if (bestCell.savingsPercent !== null) {
        winnerRows.push({ savingsPercent: bestCell.savingsPercent, samples: bestCell.samples });
      }
    }

    byModelTask.push({
      model,
      modelFamily,
      taskType,
      totalSamples: groupEvents.length,
      baseline: baselineAgg.samples
        ? {
            samples: baselineAgg.samples,
            avgTokens: round1(baselineAgg.totalTokens / baselineAgg.samples),
            avgLatency: round1(baselineAgg.totalLatency / baselineAgg.samples),
            avgQuality: round3(baselineAgg.totalQuality / baselineAgg.samples),
            avgAbsoluteCost: round3(baselineAvgCost ?? 0),
          }
        : null,
      optimizers: cells.sort((a, b) => {
        // Ordenar: ganador primero, luego por coste ascendente
        if (a.winner !== b.winner) return a.winner ? -1 : 1;
        const ca = a.avgAbsoluteCost === Infinity ? Number.MAX_VALUE : a.avgAbsoluteCost;
        const cb = b.avgAbsoluteCost === Infinity ? Number.MAX_VALUE : b.avgAbsoluteCost;
        return ca - cb;
      }),
      bestOptimizer,
    });
  }

  // --- byModel ---
  const groupByModel = new Map<string, RouterEvent[]>();
  for (const e of executions) {
    if (!groupByModel.has(e.model)) groupByModel.set(e.model, []);
    groupByModel.get(e.model)!.push(e);
  }

  const byModel: ModelRow[] = [];
  for (const [model, modelEvents] of groupByModel) {
    const agg = aggregateExecutions(modelEvents);
    const modelFamily = modelEvents[0]?.modelFamily ?? '';

    // Mejor optimizador para este modelo: el que más se repite como bestOptimizer en byModelTask
    const modelRows = byModelTask.filter((r) => r.model === model);
    const optimizersWins = new Map<Optimizer, number>();
    for (const row of modelRows) {
      if (row.bestOptimizer) {
        optimizersWins.set(row.bestOptimizer, (optimizersWins.get(row.bestOptimizer) ?? 0) + 1);
      }
    }
    let bestOptimizer: Optimizer | null = null;
    let maxWins = 0;
    for (const [opt, wins] of optimizersWins) {
      if (wins > maxWins) {
        maxWins = wins;
        bestOptimizer = opt;
      }
    }

    // Ahorro medio ponderado vs BASELINE para este modelo
    const modelWinners = modelRows
      .filter((r) => r.bestOptimizer !== null)
      .flatMap((r) => r.optimizers.filter((c) => c.winner));
    let weightedSavings = 0;
    let totalSamplesWinners = 0;
    let totalTokensSaved = 0;
    for (const c of modelWinners) {
      if (c.savingsPercent !== null) {
        weightedSavings += c.savingsPercent * c.samples;
        totalSamplesWinners += c.samples;
      }
      if (c.savingsTokens !== null) {
        totalTokensSaved += c.savingsTokens * c.samples;
      }
    }
    const savingsPercent = totalSamplesWinners > 0 ? weightedSavings / totalSamplesWinners : 0;
    const savingsTokens = totalSamplesWinners > 0 ? Math.round(totalTokensSaved / totalSamplesWinners) : 0;

    byModel.push({
      model,
      modelFamily,
      executions: agg.samples,
      avgTokens: round1(agg.samples > 0 ? agg.totalTokens / agg.samples : 0),
      avgLatency: round1(agg.samples > 0 ? agg.totalLatency / agg.samples : 0),
      avgQuality: round3(agg.samples > 0 ? agg.totalQuality / agg.samples : 0),
      failureRate: round3(agg.samples > 0 ? agg.failures / agg.samples : 0),
      bestOptimizer,
      savingsVsBaselinePercent: round1(savingsPercent),
      savingsVsBaselineTokens: savingsTokens,
    });
  }

  // --- globalSavings ---
  // Considera TODOS los optimizadores no-baseline con samples suficientes,
  // no solo los ganadores. Así, si el router empeora, el ahorro es negativo.
  let weightedGlobal = 0;
  let totalSamplesGlobal = 0;
  let totalTokensSavedGlobal = 0;
  let totalUsdSavedGlobal = 0;
  for (const row of byModelTask) {
    if (!row.baseline) continue; // sin baseline no hay comparacion posible
    for (const c of row.optimizers) {
      if (c.optimizer === 'BASELINE') continue;
      if (c.samples < opts.minSamples) continue;
      if (c.savingsPercent !== null) {
        weightedGlobal += c.savingsPercent * c.samples;
        totalSamplesGlobal += c.samples;
      }
      if (c.savingsTokens !== null) {
        totalTokensSavedGlobal += c.savingsTokens * c.samples;
      }
      if (c.savingsUsd !== null) {
        totalUsdSavedGlobal += c.savingsUsd * c.samples;
      }
    }
  }
  const weightedSavingsPercent = totalSamplesGlobal > 0 ? weightedGlobal / totalSamplesGlobal : 0;
  const totalTokensSaved =
    totalSamplesGlobal > 0 ? Math.round(totalTokensSavedGlobal / totalSamplesGlobal) : 0;
  const totalUsdSaved =
    totalSamplesGlobal > 0
      ? Math.round((totalUsdSavedGlobal / totalSamplesGlobal) * 1_000_000) / 1_000_000
      : 0;

  let verdict: string;
  if (weightedSavingsPercent >= 15) {
    verdict = 'El router aporta valor claro.';
  } else if (weightedSavingsPercent >= 5) {
    verdict = 'El router aporta valor moderado.';
  } else if (weightedSavingsPercent >= 0) {
    verdict = 'El router no aporta ahorro significativo aun.';
  } else {
    verdict = 'El router NO aporta ahorro con la evidencia actual. Revisar reglas o acumular mas muestras.';
  }

  // --- Calibración de confianza y decisiones huérfanas ---
  // Emparejar decisiones con ejecuciones por sessionId.
  const decisionsBySession = new Map<string, RouterEvent>();
  for (const d of decisions) {
    if (d.sessionId) {
      decisionsBySession.set(d.sessionId, d);
    }
  }
  const executionsBySession = new Map<string, RouterEvent>();
  for (const e of executions) {
    if (e.sessionId) {
      executionsBySession.set(e.sessionId, e);
    }
  }

  let matched = 0;
  let orphanDecisions = 0;
  let totalDeclaredConfidence = 0;
  let totalActualQuality = 0;
  let highConfidenceFailures = 0;
  let highConfidenceTotal = 0;

  for (const [sid, decision] of decisionsBySession) {
    const execution = executionsBySession.get(sid);
    if (execution && execution.execution) {
      matched++;
      const declaredConf = decision.decision?.confidence ?? 0;
      const actualQuality = execution.execution.quality;
      totalDeclaredConfidence += declaredConf;
      totalActualQuality += actualQuality;
      if (declaredConf >= opts.minConfidence) {
        highConfidenceTotal++;
        if (execution.execution.failed) highConfidenceFailures++;
      }
    } else {
      orphanDecisions++;
    }
  }

  const avgDeclaredConfidence = matched > 0 ? totalDeclaredConfidence / matched : 0;
  const avgActualQuality = matched > 0 ? totalActualQuality / matched : 0;
  const failureRateHighConfidence =
    highConfidenceTotal > 0 ? highConfidenceFailures / highConfidenceTotal : 0;
  // Score de calibración: 1 - |confianza - calidad| (penalizado por fallos en alta confianza)
  const calibrationScore = matched > 0
    ? Math.max(0, 1 - Math.abs(avgDeclaredConfidence - avgActualQuality) - failureRateHighConfidence)
    : 0;

  let calibrationVerdict: string;
  if (matched === 0) {
    calibrationVerdict = 'Sin datos suficientes para calibrar (no hay pares decisión+ejecución).';
  } else if (calibrationScore >= 0.7) {
    calibrationVerdict = 'Confianza bien calibrada.';
  } else if (calibrationScore >= 0.4) {
    calibrationVerdict = 'Confianza con desviación moderada. Revisar muestras.';
  } else {
    calibrationVerdict = 'Confianza mal calibrada. El router sobreestima su certeza.';
  }

  return {
    summary: {
      totalDecisions: decisions.length,
      totalExecutions: executions.length,
      syntheticCount: totalSynthetic,
      realCount: totalReal,
      realModels,
      uniqueModels,
      uniqueModelFamilies: uniqueFamilies,
      uniqueTaskTypes,
      dateRange: {
        from: timestamps[0] ?? null,
        to: timestamps[timestamps.length - 1] ?? null,
      },
      confidenceLevel,
      orphanDecisions,
      matchedDecisions: matched,
    },
    byModel: byModel.sort((a, b) => b.executions - a.executions),
    byModelTask: byModelTask.sort((a, b) => {
      if (a.model !== b.model) return a.model.localeCompare(b.model);
      return a.taskType.localeCompare(b.taskType);
    }),
    globalSavings: {
      weightedSavingsPercent: round1(weightedSavingsPercent),
      totalTokensSaved,
      totalUsdSaved,
      verdict,
    },
    confidenceCalibration: {
      pairsMatched: matched,
      avgDeclaredConfidence: round3(avgDeclaredConfidence),
      avgActualQuality: round3(avgActualQuality),
      failureRateHighConfidence: round3(failureRateHighConfidence),
      calibrationScore: round3(calibrationScore),
      verdict: calibrationVerdict,
    },
  };
}

function round1(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 10) / 10;
}
function round3(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 1000) / 1000;
}
