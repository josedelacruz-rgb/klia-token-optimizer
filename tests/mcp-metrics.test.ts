import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractModelFamily } from '../src/utils/model-family';
import { McpMetricsStore } from '../src/history/mcp-metrics-store';

const tmpDir = path.join(__dirname, '.tmp-mcp-metrics');
const tmpFile = path.join(tmpDir, 'metrics.json');

describe('extractModelFamily', () => {
  it('detecta familias conocidas', () => {
    expect(extractModelFamily('glm-5.2')).toBe('glm');
    expect(extractModelFamily('deepseek-v4')).toBe('deepseek');
    expect(extractModelFamily('gpt-4o')).toBe('gpt');
    expect(extractModelFamily('claude-sonnet-4')).toBe('claude');
    expect(extractModelFamily('kimi-k2.7')).toBe('kimi');
  });

  it('fallback al prefiso alfabético', () => {
    expect(extractModelFamily('foo-bar-1')).toBe('foo');
  });

  it('unknown si no hay prefijo', () => {
    expect(extractModelFamily('123-model')).toBe('unknown');
  });
});

describe('McpMetricsStore', () => {
  it('registra y resume métricas de uso del MCP', () => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    const store = new McpMetricsStore(tmpFile);

    store.record({
      timestamp: new Date().toISOString(),
      model: 'glm-5.2',
      modelFamily: 'glm',
      taskType: 'REFACTOR',
      optimizer: 'RTK',
      version: 'V2',
      confidence: 1,
      tokens: 9000,
      latencySeconds: 80,
      quality: 0.98,
      failed: false,
    });

    store.record({
      timestamp: new Date().toISOString(),
      model: 'deepseek-v4',
      modelFamily: 'deepseek',
      taskType: 'MULTISTEP',
      optimizer: 'BASELINE',
      version: 'V2',
      confidence: 1,
      tokens: 12000,
      latencySeconds: 100,
      quality: 0.95,
      failed: false,
    });

    const summary = store.summary();
    expect(summary.totalDecisions).toBe(2);
    expect(summary.totalExecutions).toBe(2);
    expect(summary.byOptimizer.RTK).toBe(1);
    expect(summary.byModelFamily.glm).toBe(1);
    expect(summary.avgQuality).toBeGreaterThan(0.9);
    expect(summary.failureRate).toBe(0);
  });
});
