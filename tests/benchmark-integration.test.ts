import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildContextFromQuery,
  buildRecord,
  createAdaptiveRouter,
} from '../src/index';

const tmpDir = path.join(__dirname, '.tmp-benchmark');
const tmpFile = path.join(tmpDir, 'history.json');

function clean() {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * Matriz de costes relativos del prompt del usuario (aproximada a tokens).
 * Se usan como datos de entrenamiento iniciales.
 */
const GLM_RELATIVE_COSTS: Record<string, Record<string, number>> = {
  T5_MULTISTEP: { DCP: 0.58, RTK: 0.91, CONTEXT_MODE: 0.83, BASELINE: 1.0 },
  T6_REFACTOR: { DCP: 0.59, RTK: 0.58, CONTEXT_MODE: 0.71, BASELINE: 1.0 },
};

const DEEPSEEK_RELATIVE_COSTS: Record<string, Record<string, number>> = {
  T5_MULTISTEP: { DCP: 1.21, RTK: 1.2, CONTEXT_MODE: 1.45, BASELINE: 1.0 },
  T6_REFACTOR: { DCP: 1.25, RTK: 1.1, CONTEXT_MODE: 1.72, BASELINE: 1.0 },
};

function seedBenchmarkData(
  router: ReturnType<typeof createAdaptiveRouter>,
  model: string,
  taskKey: string,
  taskType: 'MULTISTEP' | 'REFACTOR',
  costs: Record<string, number>,
) {
  const baseTokens = 10_000;
  const query = taskType === 'MULTISTEP' ? 'planifica migración en 5 pasos' : 'refactoriza auth';
  const ctx = buildContextFromQuery(model, query, {
    fileCount: taskType === 'MULTISTEP' ? 8 : 12,
    contextSizeBytes: 200_000,
    isMultistep: taskType === 'MULTISTEP',
    isRefactor: taskType === 'REFACTOR',
  });

  const promises: Promise<void>[] = [];
  for (const [optimizer, relativeCost] of Object.entries(costs)) {
    const tokens = Math.round(baseTokens * relativeCost);
    const record = buildRecord(ctx, optimizer as import('../src/types').Optimizer, {
      tokens,
      latencySeconds: 100,
      toolingCost: optimizer === 'BASELINE' ? 0 : 0.5,
      quality: 0.98,
      failed: false,
    });
    for (let i = 0; i < 5; i++) {
      promises.push(router.recordExecution(record));
    }
  }
  return Promise.all(promises);
}

describe('Benchmark GLM-5.2 + DeepSeek', () => {
  it('GLM/MULTISTEP elige DCP', async () => {
    clean();
    const router = createAdaptiveRouter({ historyPath: tmpFile, enableExploration: false });
    await seedBenchmarkData(router, 'glm-5.2', 'T5_MULTISTEP', 'MULTISTEP', GLM_RELATIVE_COSTS.T5_MULTISTEP);

    const ctx = buildContextFromQuery('glm-5.2', 'planifica migración en 5 pasos', {
      fileCount: 8,
      contextSizeBytes: 200_000,
      isMultistep: true,
    });
    const decision = await router.route(ctx);
    expect(decision.optimizer).toBe('DCP');
    expect(decision.taskType).toBe('MULTISTEP');
  });

  it('GLM/REFACTOR elige RTK', async () => {
    clean();
    const router = createAdaptiveRouter({ historyPath: tmpFile, enableExploration: false });
    await seedBenchmarkData(router, 'glm-5.2', 'T6_REFACTOR', 'REFACTOR', GLM_RELATIVE_COSTS.T6_REFACTOR);

    const ctx = buildContextFromQuery('glm-5.2', 'refactoriza auth', {
      fileCount: 12,
      contextSizeBytes: 200_000,
      isRefactor: true,
    });
    const decision = await router.route(ctx);
    expect(decision.optimizer).toBe('RTK');
    expect(decision.taskType).toBe('REFACTOR');
  });

  it('DeepSeek/MULTISTEP fallback a BASELINE', async () => {
    clean();
    const router = createAdaptiveRouter({ historyPath: tmpFile, enableExploration: false });
    await seedBenchmarkData(router, 'deepseek-v4', 'T5_MULTISTEP', 'MULTISTEP', DEEPSEEK_RELATIVE_COSTS.T5_MULTISTEP);

    const ctx = buildContextFromQuery('deepseek-v4', 'planifica migración en 5 pasos', {
      fileCount: 8,
      contextSizeBytes: 200_000,
      isMultistep: true,
    });
    const decision = await router.route(ctx);
    expect(decision.optimizer).toBe('BASELINE');
    expect(decision.taskType).toBe('MULTISTEP');
  });

  it('DeepSeek/REFACTOR fallback a BASELINE', async () => {
    clean();
    const router = createAdaptiveRouter({ historyPath: tmpFile, enableExploration: false });
    await seedBenchmarkData(router, 'deepseek-v4', 'T6_REFACTOR', 'REFACTOR', DEEPSEEK_RELATIVE_COSTS.T6_REFACTOR);

    const ctx = buildContextFromQuery('deepseek-v4', 'refactoriza auth', {
      fileCount: 12,
      contextSizeBytes: 200_000,
      isRefactor: true,
    });
    const decision = await router.route(ctx);
    expect(decision.optimizer).toBe('BASELINE');
    expect(decision.taskType).toBe('REFACTOR');
  });

  it('un modelo nuevo sin historial usa baseline y luego aprende', async () => {
    clean();
    const router = createAdaptiveRouter({ historyPath: tmpFile, enableExploration: false });

    const ctx = buildContextFromQuery('claude-sonnet-4', 'corrige un typo', {
      fileCount: 1,
      contextSizeBytes: 5_000,
    });
    const first = await router.route(ctx);
    expect(first.optimizer).toBe('BASELINE');
    expect(first.version).toBe('V0');

    // Registrar varias ejecuciones que muestren que DCP es peor en SMALL_CODE.
    for (let i = 0; i < 5; i++) {
      await router.recordExecution(
        buildRecord(ctx, 'BASELINE', {
          tokens: 5000,
          latencySeconds: 20,
          toolingCost: 0,
          quality: 0.99,
          failed: false,
        }),
      );
      await router.recordExecution(
        buildRecord(ctx, 'DCP', {
          tokens: 7000,
          latencySeconds: 40,
          toolingCost: 0.5,
          quality: 0.99,
          failed: false,
        }),
      );
    }

    const second = await router.route(ctx);
    expect(second.optimizer).toBe('BASELINE');
    expect(second.version).toBe('V2');
  });
});
