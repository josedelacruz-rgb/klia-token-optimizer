import { describe, expect, it } from 'vitest';
import {
  buildContextFromQuery,
  buildRecord,
  createAdaptiveRouter,
} from '../src/index';
import * as path from 'path';
import * as fs from 'fs';

const tmpDir = path.join(__dirname, '.tmp-router');
const tmpFile = path.join(tmpDir, 'history.json');

describe('createAdaptiveRouter', () => {
  it('enruta una tarea pequeña a baseline sin historial', async () => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    const router = createAdaptiveRouter({ historyPath: tmpFile, enableExploration: false });
    const ctx = buildContextFromQuery('glm-5.2', 'corrige un typo en index.ts', {
      fileCount: 1,
      contextSizeBytes: 5_000,
    });
    const decision = await router.route(ctx);
    expect(decision.optimizer).toBe('BASELINE');
    expect(decision.taskType).toBe('SMALL_CODE');
    expect(decision.version).toBe('V0');
  });

  it('enruta refactor a RTK y puede registrar resultados', async () => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    const router = createAdaptiveRouter({ historyPath: tmpFile, random: () => 1 });
    const ctx = buildContextFromQuery('glm-5.2', 'refactoriza auth', {
      fileCount: 12,
      contextSizeBytes: 200_000,
    });
    const decision = await router.route(ctx);
    expect(decision.optimizer).toBe('RTK');
    expect(decision.taskType).toBe('REFACTOR');

    const record = buildRecord(ctx, decision.optimizer, {
      tokens: 9000,
      latencySeconds: 80,
      toolingCost: 0.2,
      quality: 0.98,
      failed: false,
    });
    await router.recordExecution(record);
    const list = await new (await import('../src/history/history-store')).JsonHistoryStore({ filePath: tmpFile }).list();
    expect(list).toHaveLength(1);
  });

  it('aprende de historial y elige mejor optimizador', async () => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    const router = createAdaptiveRouter({ historyPath: tmpFile, enableExploration: false });
    const ctx = buildContextFromQuery('glm-5.2', 'planifica migración en 5 pasos', {
      fileCount: 8,
      contextSizeBytes: 100_000,
      isMultistep: true,
    });

    for (let i = 0; i < 5; i++) {
      const baseline = buildRecord(
        ctx,
        'BASELINE',
        { tokens: 10000, latencySeconds: 60, toolingCost: 0, quality: 0.98, failed: false },
      );
      const dcp = buildRecord(
        ctx,
        'DCP',
        { tokens: 5800, latencySeconds: 100, toolingCost: 0.5, quality: 0.98, failed: false },
      );
      await router.recordExecution(baseline);
      await router.recordExecution(dcp);
    }

    const decision = await router.route(ctx);
    expect(decision.optimizer).toBe('DCP');
    expect(decision.version).toBe('V2');
  });
});
