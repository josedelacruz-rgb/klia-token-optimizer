import { describe, expect, it } from 'vitest';
import {
  computeRecordCost,
  computeRelativeCost,
  buildCostMatrix,
} from '../../src/scorer/expected-cost-scorer';
import type { ExecutionRecord } from '../../src/types';

const baseRecord: ExecutionRecord = {
  id: '1',
  timestamp: '2026-01-01T00:00:00Z',
  model: 'glm-5.2',
  modelFamily: 'glm',
  taskType: 'MULTISTEP',
  optimizer: 'DCP',
  metrics: {
    tokens: 8000,
    latencySeconds: 100,
    toolingCost: 0.5,
    quality: 0.98,
    failed: false,
  },
  contextSnapshot: { fileCount: 5, contextSizeBytes: 50_000 },
};

describe('computeRecordCost', () => {
  it('combina tokens, latencia, tooling, calidad y fallos', () => {
    const cost = computeRecordCost(baseRecord, {
      minConfidence: 0.6,
      explorationRate: 0.1,
      minSamples: 3,
      latencyWeight: 1,
      toolingCostWeight: 1,
      failurePenalty: 5,
      qualityPenalty: 3,
    });
    const expected = 8000 + 100 + 0.5 + 0 + 3 * (1 - 0.98);
    expect(cost).toBeCloseTo(expected);
  });

  it('penaliza fallos', () => {
    const failedRecord = { ...baseRecord, metrics: { ...baseRecord.metrics, failed: true } };
    const costOk = computeRecordCost(baseRecord, {
      minConfidence: 0.6,
      explorationRate: 0.1,
      minSamples: 3,
      latencyWeight: 1,
      toolingCostWeight: 1,
      failurePenalty: 5,
      qualityPenalty: 3,
    });
    const costFailed = computeRecordCost(failedRecord, {
      minConfidence: 0.6,
      explorationRate: 0.1,
      minSamples: 3,
      latencyWeight: 1,
      toolingCostWeight: 1,
      failurePenalty: 5,
      qualityPenalty: 3,
    });
    expect(costFailed).toBe(costOk + 5);
  });
});

describe('computeRelativeCost', () => {
  it('devuelve Infinity si no hay observaciones del optimizador', () => {
    const score = computeRelativeCost([], 'DCP', {
      minConfidence: 0.6,
      explorationRate: 0.1,
      minSamples: 3,
      latencyWeight: 1,
      toolingCostWeight: 1,
      failurePenalty: 5,
      qualityPenalty: 3,
    });
    expect(score.relativeCost).toBe(Infinity);
    expect(score.sampleCount).toBe(0);
  });

  it('normaliza respecto al baseline', () => {
    const baseline = {
      ...baseRecord,
      optimizer: 'BASELINE' as const,
      metrics: { ...baseRecord.metrics, tokens: 10000, toolingCost: 0 },
    };
    const dcp = { ...baseRecord, optimizer: 'DCP' as const };
    const score = computeRelativeCost([baseline, dcp], 'DCP', {
      minConfidence: 0.6,
      explorationRate: 0.1,
      minSamples: 3,
      latencyWeight: 1,
      toolingCostWeight: 1,
      failurePenalty: 5,
      qualityPenalty: 3,
    });
    expect(score.relativeCost).toBeLessThan(1);
    expect(score.sampleCount).toBe(1);
  });
});

describe('buildCostMatrix', () => {
  it('agrupa por modelo y tarea', () => {
    const records: ExecutionRecord[] = [
      { ...baseRecord, model: 'glm-5.2', taskType: 'MULTISTEP', optimizer: 'DCP' },
      {
        ...baseRecord,
        model: 'glm-5.2',
        taskType: 'MULTISTEP',
        optimizer: 'BASELINE',
        metrics: { ...baseRecord.metrics, tokens: 10000, toolingCost: 0 },
      },
      { ...baseRecord, model: 'deepseek-v4', taskType: 'MULTISTEP', optimizer: 'DCP' },
      {
        ...baseRecord,
        model: 'deepseek-v4',
        taskType: 'MULTISTEP',
        optimizer: 'BASELINE',
        metrics: { ...baseRecord.metrics, tokens: 10000, toolingCost: 0 },
      },
    ];
    const matrix = buildCostMatrix(records);
    expect(matrix.has('glm-5.2::MULTISTEP')).toBe(true);
    expect(matrix.has('deepseek-v4::MULTISTEP')).toBe(true);
  });
});
