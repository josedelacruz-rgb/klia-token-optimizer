import { describe, expect, it } from 'vitest';
import { selectOptimizer, evaluateOptimizer } from '../../src/selector/optimizer-selector';
import { JsonHistoryStore, createExecutionRecord } from '../../src/history/history-store';
import type { ExecutionRecord, Optimizer, TaskType } from '../../src/types';
import * as path from 'path';
import * as fs from 'fs';

const tmpDir = path.join(__dirname, '.tmp-selector');
const tmpFile = path.join(tmpDir, 'history.json');

function makeRecord(
  model: string,
  taskType: TaskType,
  optimizer: Optimizer,
  tokens: number,
): ExecutionRecord {
  return createExecutionRecord(
    model,
    model.split('-')[0],
    taskType,
    optimizer,
    {
      tokens,
      latencySeconds: 100,
      toolingCost: optimizer === 'BASELINE' ? 0 : 0.5,
      quality: 0.98,
      failed: false,
    },
    { fileCount: 5, contextSizeBytes: 50_000 },
  );
}

describe('selectOptimizer', () => {
  it('sin historial usa V0 y baseline', async () => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    const history = new JsonHistoryStore({ filePath: tmpFile });
    const decision = await selectOptimizer('glm-5.2', 'MULTISTEP', { history });
    expect(decision.optimizer).toBe('DCP');
    expect(decision.version).toBe('V0');
    expect(decision.confidence).toBe(0);
  });

  it('con evidencia a favor de DCP en GLM/MULTISTEP elige DCP', async () => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    const history = new JsonHistoryStore({ filePath: tmpFile });
    for (let i = 0; i < 5; i++) {
      await history.add(makeRecord('glm-5.2', 'MULTISTEP', 'BASELINE', 10000));
      await history.add(makeRecord('glm-5.2', 'MULTISTEP', 'DCP', 5800));
    }
    const decision = await selectOptimizer('glm-5.2', 'MULTISTEP', { history });
    expect(decision.optimizer).toBe('DCP');
    expect(decision.version).toBe('V2');
    expect(decision.confidence).toBeGreaterThan(0.6);
  });

  it('con evidencia negativa de DCP en DeepSeek/MULTISTEP fallback a baseline', async () => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    const history = new JsonHistoryStore({ filePath: tmpFile });
    for (let i = 0; i < 5; i++) {
      await history.add(makeRecord('deepseek-v4', 'MULTISTEP', 'BASELINE', 10000));
      await history.add(makeRecord('deepseek-v4', 'MULTISTEP', 'DCP', 12100));
    }
    const decision = await selectOptimizer('deepseek-v4', 'MULTISTEP', { history });
    expect(decision.optimizer).toBe('BASELINE');
    expect(decision.confidence).toBeGreaterThan(0.6);
  });

  it('ignora optimizadores fuera de la regla base cuando el histórico no tiene candidatos', async () => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    const history = new JsonHistoryStore({ filePath: tmpFile });
    for (let i = 0; i < 5; i++) {
      await history.add(makeRecord('glm-5.2', 'MULTISTEP', 'BASELINE', 10000));
      // RTK no es candidato para MULTISTEP, por tanto se ignora.
      await history.add(makeRecord('glm-5.2', 'MULTISTEP', 'RTK', 2000));
    }
    // Como no hay observaciones de DCP, el mejor entre los conocidos y permitidos es BASELINE.
    const decision = await selectOptimizer('glm-5.2', 'MULTISTEP', { history });
    expect(decision.optimizer).toBe('BASELINE');
    expect(decision.version).toBe('V2');
    // RTK no debe aparecer entre las alternativas mostradas.
    const optimizers = decision.alternatives?.map((a) => a.optimizer) ?? [];
    expect(optimizers).not.toContain('RTK');
  });

  it('descarta un optimizador y conmuta a BASELINE cuando su coste relativo es >= 1.0', async () => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    const history = new JsonHistoryStore({ filePath: tmpFile });
    for (let i = 0; i < 5; i++) {
      await history.add(makeRecord('deepseek-v4', 'LARGE_CONTEXT', 'BASELINE', 10000));
      // SEMBLE gasta un 40% más de tokens
      await history.add(makeRecord('deepseek-v4', 'LARGE_CONTEXT', 'SEMBLE', 14000));
    }
    const decision = await selectOptimizer('deepseek-v4', 'LARGE_CONTEXT', { history });
    expect(decision.optimizer).toBe('BASELINE');
    expect(decision.reason).toContain('se descarta SEMBLE');
    expect(decision.reason).toContain('no ahorra');
  });
});

describe('evaluateOptimizer', () => {
  it('calcula coste relativo', () => {
    const records: ExecutionRecord[] = [
      makeRecord('glm-5.2', 'REFACTOR', 'BASELINE', 10000),
      makeRecord('glm-5.2', 'REFACTOR', 'RTK', 5800),
    ];
    const score = evaluateOptimizer(records, 'RTK');
    expect(score.relativeCost).toBeLessThan(1);
  });
});
