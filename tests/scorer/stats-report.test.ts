import { describe, expect, it } from 'vitest';
import { buildStatsReport, computeEventCost } from '../../src/scorer/stats-report';
import { createExecutionEvent } from '../../src/history/router-event-store';
import { DEFAULT_ROUTER_OPTIONS } from '../../src/types';
import type { Optimizer, RouterEvent } from '../../src/types';

function makeExec(
  model: string,
  family: string,
  taskType: RouterEvent['taskType'],
  optimizer: Optimizer,
  tokens: number,
  latency: number,
  quality = 0.95,
  failed = false,
): RouterEvent {
  return createExecutionEvent({
    query: 'test',
    model,
    modelFamily: family,
    taskType,
    signals: { fileCount: 1, contextSizeBytes: 1000 },
    execution: {
      optimizer,
      inputTokens: Math.round(tokens * 0.8),
      outputTokens: Math.round(tokens * 0.2),
      totalTokens: tokens,
      latencySeconds: latency,
      toolingCost: optimizer === 'BASELINE' ? 0 : 0.5,
      quality,
      failed,
    },
    source: 'mcp',
  });
}

describe('computeEventCost', () => {
  it('combina tokens, latencia, tooling, calidad y fallos', () => {
    const e = makeExec('glm-5.2', 'glm', 'MULTISTEP', 'DCP', 8000, 100, 0.98, false);
    const cost = computeEventCost(e, DEFAULT_ROUTER_OPTIONS);
    const expected = 8000 + 100 * 1 + 0.5 * 1 + 0 + 3 * (1 - 0.98);
    expect(cost).toBeCloseTo(expected, 1);
  });

  it('penaliza fallos', () => {
    const ok = makeExec('glm-5.2', 'glm', 'MULTISTEP', 'DCP', 8000, 100, 0.98, false);
    const failed = makeExec('glm-5.2', 'glm', 'MULTISTEP', 'DCP', 8000, 100, 0.98, true);
    const costOk = computeEventCost(ok, DEFAULT_ROUTER_OPTIONS);
    const costFailed = computeEventCost(failed, DEFAULT_ROUTER_OPTIONS);
    expect(costFailed).toBeCloseTo(costOk + DEFAULT_ROUTER_OPTIONS.failurePenalty, 1);
  });
});

describe('buildStatsReport', () => {
  it('devuelve resumen vacio cuando no hay eventos', () => {
    const report = buildStatsReport([]);
    expect(report.summary.totalExecutions).toBe(0);
    expect(report.summary.totalDecisions).toBe(0);
    expect(report.summary.confidenceLevel).toBe('Insuficiente');
    expect(report.byModel).toHaveLength(0);
    expect(report.byModelTask).toHaveLength(0);
    expect(report.globalSavings.weightedSavingsPercent).toBe(0);
  });

  it('calcula resumen basico con pocos eventos', () => {
    const events: RouterEvent[] = [
      makeExec('glm-5.2', 'glm', 'MULTISTEP', 'BASELINE', 10000, 100),
      makeExec('glm-5.2', 'glm', 'MULTISTEP', 'DCP', 8000, 90),
    ];
    const report = buildStatsReport(events);
    expect(report.summary.totalExecutions).toBe(2);
    expect(report.summary.uniqueModels).toEqual(['glm-5.2']);
    expect(report.summary.uniqueModelFamilies).toEqual(['glm']);
    expect(report.summary.uniqueTaskTypes).toEqual(['MULTISTEP']);
    expect(report.summary.dateRange.from).toBe(events[0].timestamp);
    expect(report.summary.dateRange.to).toBe(events[1].timestamp);
  });

  it('marca confianza como Bajo entre 10 y 30 ejecuciones', () => {
    const events: RouterEvent[] = [];
    for (let i = 0; i < 15; i++) {
      events.push(makeExec('glm-5.2', 'glm', 'MULTISTEP', 'BASELINE', 10000, 100));
    }
    const report = buildStatsReport(events);
    expect(report.summary.confidenceLevel).toBe('Bajo');
  });

  it('calcula celdas ricas por (modelo, tarea, optimizador) con ahorro vs BASELINE', () => {
    // 3 muestras BASELINE a 10000 tokens, 3 muestras DCP a 8000 tokens
    const events: RouterEvent[] = [
      ...Array(3)
        .fill(null)
        .map(() => makeExec('glm-5.2', 'glm', 'MULTISTEP', 'BASELINE', 10000, 100)),
      ...Array(3)
        .fill(null)
        .map(() => makeExec('glm-5.2', 'glm', 'MULTISTEP', 'DCP', 8000, 90)),
    ];
    const report = buildStatsReport(events);

    expect(report.byModelTask).toHaveLength(1);
    const row = report.byModelTask[0];
    expect(row.model).toBe('glm-5.2');
    expect(row.taskType).toBe('MULTISTEP');
    expect(row.baseline?.samples).toBe(3);
    expect(row.baseline?.avgTokens).toBe(10000);

    const dcp = row.optimizers.find((c) => c.optimizer === 'DCP');
    expect(dcp).toBeDefined();
    expect(dcp!.samples).toBe(3);
    expect(dcp!.avgTokens).toBe(8000);
    expect(dcp!.avgLatency).toBe(90);
    expect(dcp!.savingsTokens).toBe(2000);
    expect(dcp!.savingsPercent).toBe(20);
    expect(dcp!.verdict).toBe('AHORRO');
    expect(dcp!.winner).toBe(true);
    expect(row.bestOptimizer).toBe('DCP');
  });

  it('marca veredicto PERDIDA si el optimizador sale mas caro que BASELINE', () => {
    const events: RouterEvent[] = [
      ...Array(3)
        .fill(null)
        .map(() => makeExec('glm-5.2', 'glm', 'MULTISTEP', 'BASELINE', 8000, 90)),
      ...Array(3)
        .fill(null)
        .map(() => makeExec('glm-5.2', 'glm', 'MULTISTEP', 'DCP', 10000, 100)),
    ];
    const report = buildStatsReport(events);
    const dcp = report.byModelTask[0].optimizers.find((c) => c.optimizer === 'DCP');
    expect(dcp!.verdict).toBe('PERDIDA');
    expect(dcp!.winner).toBe(false);
  });

  it('no elige ganador con menos de minSamples muestras', () => {
    // minSamples por defecto = 3. DCP solo tiene 2 muestras.
    const events: RouterEvent[] = [
      ...Array(3)
        .fill(null)
        .map(() => makeExec('glm-5.2', 'glm', 'MULTISTEP', 'BASELINE', 10000, 100)),
      ...Array(2)
        .fill(null)
        .map(() => makeExec('glm-5.2', 'glm', 'MULTISTEP', 'DCP', 8000, 90)),
    ];
    const report = buildStatsReport(events);
    const dcp = report.byModelTask[0].optimizers.find((c) => c.optimizer === 'DCP');
    // Con < minSamples, el veredicto es NEUTRO y no es ganador
    expect(dcp!.verdict).toBe('NEUTRO');
    expect(dcp!.winner).toBe(false);
    expect(report.byModelTask[0].bestOptimizer).toBeNull();
  });

  it('calcula ahorro ponderado global', () => {
    // 1 combinacion: BASELINE 10000, DCP 8000 -> 20% ahorro, 3 muestras DCP ganador
    const events: RouterEvent[] = [
      ...Array(3)
        .fill(null)
        .map(() => makeExec('glm-5.2', 'glm', 'MULTISTEP', 'BASELINE', 10000, 100)),
      ...Array(3)
        .fill(null)
        .map(() => makeExec('glm-5.2', 'glm', 'MULTISTEP', 'DCP', 8000, 90)),
    ];
    const report = buildStatsReport(events);
    expect(report.globalSavings.weightedSavingsPercent).toBe(20);
    expect(report.globalSavings.totalTokensSaved).toBe(2000);
    expect(report.globalSavings.verdict).toBe('El router aporta valor claro.');
  });

  it('veredicto moderado cuando ahorro esta entre 5 y 15', () => {
    const events: RouterEvent[] = [
      ...Array(3)
        .fill(null)
        .map(() => makeExec('glm-5.2', 'glm', 'MULTISTEP', 'BASELINE', 10000, 100)),
      ...Array(3)
        .fill(null)
        .map(() => makeExec('glm-5.2', 'glm', 'MULTISTEP', 'DCP', 9000, 95)), // 10% ahorro
    ];
    const report = buildStatsReport(events);
    expect(report.globalSavings.weightedSavingsPercent).toBe(10);
    expect(report.globalSavings.verdict).toBe('El router aporta valor moderado.');
  });

  it('veredicto negativo cuando el router empeora', () => {
    const events: RouterEvent[] = [
      ...Array(3)
        .fill(null)
        .map(() => makeExec('glm-5.2', 'glm', 'MULTISTEP', 'BASELINE', 8000, 90)),
      ...Array(3)
        .fill(null)
        .map(() => makeExec('glm-5.2', 'glm', 'MULTISTEP', 'DCP', 10000, 100)),
    ];
    const report = buildStatsReport(events);
    expect(report.globalSavings.weightedSavingsPercent).toBe(-25);
    expect(report.globalSavings.verdict).toContain('NO aporta ahorro');
  });

  it('separa eventos sinteticos de reales en el summary', () => {
    const events: RouterEvent[] = [
      makeExec('glm-5.2', 'glm', 'MULTISTEP', 'BASELINE', 10000, 100),
      {
        ...makeExec('glm-5.2', 'glm', 'MULTISTEP', 'DCP', 8000, 90),
        synthetic: true,
        source: 'benchmark',
      },
    ];
    const report = buildStatsReport(events);
    expect(report.summary.totalExecutions).toBe(2);
    expect(report.summary.syntheticCount).toBe(1);
    expect(report.summary.realCount).toBe(1);
  });

  it('agrupa por modelo en byModel', () => {
    const events: RouterEvent[] = [
      ...Array(3)
        .fill(null)
        .map(() => makeExec('glm-5.2', 'glm', 'MULTISTEP', 'BASELINE', 10000, 100)),
      ...Array(3)
        .fill(null)
        .map(() => makeExec('glm-5.2', 'glm', 'MULTISTEP', 'DCP', 8000, 90)),
      ...Array(3)
        .fill(null)
        .map(() => makeExec('deepseek-v4', 'deepseek', 'MULTISTEP', 'BASELINE', 12000, 110)),
      ...Array(3)
        .fill(null)
        .map(() => makeExec('deepseek-v4', 'deepseek', 'MULTISTEP', 'DCP', 9000, 95)),
    ];
    const report = buildStatsReport(events);
    expect(report.byModel).toHaveLength(2);
    const glm = report.byModel.find((m) => m.model === 'glm-5.2');
    expect(glm!.executions).toBe(6);
    expect(glm!.bestOptimizer).toBe('DCP');
    expect(glm!.savingsVsBaselinePercent).toBe(20);
  });
});
