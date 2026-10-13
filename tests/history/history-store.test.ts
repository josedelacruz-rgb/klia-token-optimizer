import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { JsonHistoryStore, createExecutionRecord } from '../../src/history/history-store';

const tmpDir = path.join(__dirname, '.tmp-history');
const tmpFile = path.join(tmpDir, 'history.json');

describe('JsonHistoryStore', () => {
  beforeEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('crea el archivo si no existe y devuelve lista vacía', async () => {
    const store = new JsonHistoryStore({ filePath: tmpFile });
    const list = await store.list();
    expect(list).toEqual([]);
  });

  it('almacena y recupera registros', async () => {
    const store = new JsonHistoryStore({ filePath: tmpFile });
    const record = createExecutionRecord(
      'deepseek-v4',
      'deepseek',
      'MULTISTEP',
      'DCP',
      { tokens: 12000, latencySeconds: 100, toolingCost: 0.5, quality: 0.98, failed: false },
      { fileCount: 5, contextSizeBytes: 50_000 },
    );
    await store.add(record);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].model).toBe('deepseek-v4');
  });

  it('filtra por modelo, tarea y optimizador', async () => {
    const store = new JsonHistoryStore({ filePath: tmpFile });
    await store.add(
      createExecutionRecord(
        'glm-5.2',
        'glm',
        'MULTISTEP',
        'DCP',
        { tokens: 8000, latencySeconds: 80, toolingCost: 0.4, quality: 0.98, failed: false },
        { fileCount: 5, contextSizeBytes: 50_000 },
      ),
    );
    await store.add(
      createExecutionRecord(
        'glm-5.2',
        'glm',
        'MULTISTEP',
        'BASELINE',
        { tokens: 10000, latencySeconds: 60, toolingCost: 0, quality: 0.98, failed: false },
        { fileCount: 5, contextSizeBytes: 50_000 },
      ),
    );
    await store.add(
      createExecutionRecord(
        'deepseek-v4',
        'deepseek',
        'MULTISTEP',
        'DCP',
        { tokens: 12000, latencySeconds: 100, toolingCost: 0.5, quality: 0.98, failed: false },
        { fileCount: 5, contextSizeBytes: 50_000 },
      ),
    );

    const glmDcp = await store.query('glm-5.2', 'MULTISTEP', 'DCP');
    expect(glmDcp).toHaveLength(1);

    const glmAll = await store.query('glm-5.2', 'MULTISTEP');
    expect(glmAll).toHaveLength(2);

    const ds = await store.query('deepseek-v4', 'MULTISTEP', 'DCP');
    expect(ds).toHaveLength(1);
  });
});
