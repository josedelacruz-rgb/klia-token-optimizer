import { describe, expect, it } from 'vitest';
import { selectOptimizerWithExploration } from '../../src/selector/exploration';
import { JsonHistoryStore, createExecutionRecord } from '../../src/history/history-store';
import type { ExecutionRecord, Optimizer, TaskType } from '../../src/types';
import * as path from 'path';
import * as fs from 'fs';

const tmpDir = path.join(__dirname, '.tmp-exploration');
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

describe('selectOptimizerWithExploration', () => {
  it('explotar cuando la confianza es alta', async () => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    const history = new JsonHistoryStore({ filePath: tmpFile });
    for (let i = 0; i < 10; i++) {
      await history.add(makeRecord('glm-5.2', 'REFACTOR', 'BASELINE', 10000));
      await history.add(makeRecord('glm-5.2', 'REFACTOR', 'RTK', 5800));
    }
    const result = await selectOptimizerWithExploration('glm-5.2', 'REFACTOR', { history });
    expect(result.decision.optimizer).toBe('RTK');
    expect(result.explored).toBe(false);
  });

  it('fallback seguro si la confianza es baja y no toca explorar', async () => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    const history = new JsonHistoryStore({ filePath: tmpFile });
    // Una sola muestra no da confianza suficiente.
    await history.add(makeRecord('glm-5.2', 'REFACTOR', 'BASELINE', 10000));

    const result = await selectOptimizerWithExploration('glm-5.2', 'REFACTOR', { history }, undefined, () => 0.99);
    expect(result.decision.optimizer).toBe('RTK'); // fallback por regla base
    expect(result.explored).toBe(false);
  });

  it('explora una alternativa cuando la confianza es baja y toca explorar', async () => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    const history = new JsonHistoryStore({ filePath: tmpFile });
    await history.add(makeRecord('glm-5.2', 'TERMINAL', 'BASELINE', 10000));

    // TERMINAL candidatos: RTK, DCP. Con confianza baja y random 0, debería explorar RTK/DCP.
    const result = await selectOptimizerWithExploration('glm-5.2', 'TERMINAL', { history }, undefined, () => 0.0);
    expect(result.explored).toBe(true);
    expect(['RTK', 'DCP']).toContain(result.decision.optimizer);
  });

  it('no explora si todos los candidatos ya están probados', async () => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    const history = new JsonHistoryStore({ filePath: tmpFile });
    await history.add(makeRecord('glm-5.2', 'TERMINAL', 'RTK', 5000));
    await history.add(makeRecord('glm-5.2', 'TERMINAL', 'DCP', 6000));

    const result = await selectOptimizerWithExploration('glm-5.2', 'TERMINAL', { history }, undefined, () => 0.0);
    expect(result.explored).toBe(false);
  });
});
