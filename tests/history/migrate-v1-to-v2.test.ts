import { describe, expect, it } from 'vitest';
import type { ExecutionRecord } from '../../src/types';
import {
  isMigratedToV2,
  looksSynthetic,
  migrateExecutionRecord,
  migrateMcpMetric,
  migrateV1ToV2,
} from '../../src/history/migrate';
import { ROUTER_EVENT_SCHEMA_VERSION } from '../../src/types';

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

describe('migrateExecutionRecord', () => {
  it('convierte un ExecutionRecord v1 en RouterEvent v2 de tipo execution', () => {
    const event = migrateExecutionRecord(baseRecord);
    expect(event.schemaVersion).toBe(ROUTER_EVENT_SCHEMA_VERSION);
    expect(event.type).toBe('execution');
    expect(event.id).toBe(baseRecord.id);
    expect(event.timestamp).toBe(baseRecord.timestamp);
    expect(event.model).toBe('glm-5.2');
    expect(event.modelFamily).toBe('glm');
    expect(event.taskType).toBe('MULTISTEP');
    expect(event.execution?.optimizer).toBe('DCP');
    expect(event.execution?.totalTokens).toBe(8000);
    expect(event.execution?.inputTokens).toBe(0);
    expect(event.execution?.outputTokens).toBe(0);
    expect(event.execution?.latencySeconds).toBe(100);
    expect(event.execution?.quality).toBe(0.98);
    expect(event.execution?.failed).toBe(false);
    expect(event.signals.fileCount).toBe(5);
    expect(event.signals.contextSizeBytes).toBe(50_000);
  });

  it('respeta el flag synthetic cuando se pasa explicitamente', () => {
    const event = migrateExecutionRecord(baseRecord, 'benchmark', true);
    expect(event.synthetic).toBe(true);
    expect(event.source).toBe('benchmark');
  });

  it('no marca synthetic si el registro tiene metricas reales plausibles', () => {
    const real: ExecutionRecord = {
      ...baseRecord,
      metrics: { tokens: 8421, latencySeconds: 87, toolingCost: 0.3, quality: 0.95, failed: false },
    };
    const event = migrateExecutionRecord(real);
    expect(event.synthetic).toBe(false);
  });
});

describe('looksSynthetic', () => {
  it('detecta registros del CLI placeholder (quality=0.98 y tokens=size/20+files*100)', () => {
    const cli: ExecutionRecord = {
      ...baseRecord,
      contextSnapshot: { fileCount: 12, contextSizeBytes: 250_000 },
      metrics: {
        tokens: Math.round(250_000 / 20 + 12 * 100),
        latencySeconds: 90,
        toolingCost: 0.5,
        quality: 0.98,
        failed: false,
      },
    };
    expect(looksSynthetic(cli)).toBe(true);
  });

  it('detecta registros del benchmark (quality con muchos decimales)', () => {
    const bench: ExecutionRecord = {
      ...baseRecord,
      metrics: {
        tokens: 3360,
        latencySeconds: 19,
        toolingCost: 0.64,
        quality: 0.9661857009723884, // 16 decimales, tipico de Math.random()
        failed: false,
      },
    };
    expect(looksSynthetic(bench)).toBe(true);
  });

  it('no marca como sinteticos registros con metricas plausibles reales', () => {
    const real: ExecutionRecord = {
      ...baseRecord,
      metrics: { tokens: 8421, latencySeconds: 87, toolingCost: 0.3, quality: 0.95, failed: false },
    };
    expect(looksSynthetic(real)).toBe(false);
  });
});

describe('migrateMcpMetric', () => {
  it('convierte una metrica MCP sin tokens en evento decision', () => {
    const event = migrateMcpMetric({
      timestamp: '2026-01-01T00:00:00Z',
      model: 'glm-5.2',
      modelFamily: 'glm',
      taskType: 'REFACTOR',
      optimizer: 'RTK',
      version: 'V1',
      confidence: 0.5,
    });
    expect(event.type).toBe('decision');
    expect(event.decision?.optimizer).toBe('RTK');
    expect(event.decision?.version).toBe('V1');
    expect(event.decision?.confidence).toBe(0.5);
    expect(event.execution).toBeUndefined();
  });

  it('convierte una metrica MCP con tokens en evento execution', () => {
    const event = migrateMcpMetric({
      timestamp: '2026-01-01T00:00:00Z',
      model: 'glm-5.2',
      modelFamily: 'glm',
      taskType: 'REFACTOR',
      optimizer: 'RTK',
      version: 'EXECUTION',
      confidence: 1,
      tokens: 9000,
      latencySeconds: 80,
      quality: 0.98,
      failed: false,
    });
    expect(event.type).toBe('execution');
    expect(event.execution?.totalTokens).toBe(9000);
    expect(event.execution?.latencySeconds).toBe(80);
    expect(event.execution?.optimizer).toBe('RTK');
  });
});

describe('migrateV1ToV2', () => {
  it('migra un array de ExecutionRecords a eventos v2', () => {
    const records = [
      { ...baseRecord, id: '1' },
      { ...baseRecord, id: '2', optimizer: 'BASELINE' as const, metrics: { ...baseRecord.metrics, tokens: 10000, toolingCost: 0 } },
    ];
    const events = migrateV1ToV2(records);
    expect(events).toHaveLength(2);
    expect(events[0].schemaVersion).toBe(ROUTER_EVENT_SCHEMA_VERSION);
    expect(events[0].type).toBe('execution');
    expect(events[1].execution?.optimizer).toBe('BASELINE');
  });

  it('respeta el source indicado', () => {
    const events = migrateV1ToV2([baseRecord], { source: 'benchmark', forceSynthetic: true });
    expect(events[0].source).toBe('benchmark');
    expect(events[0].synthetic).toBe(true);
  });
});

describe('isMigratedToV2', () => {
  it('devuelve true para array vacio', () => {
    expect(isMigratedToV2([])).toBe(true);
  });

  it('devuelve true si el primer elemento tiene schemaVersion === 2', () => {
    const events = [{ schemaVersion: ROUTER_EVENT_SCHEMA_VERSION } as never];
    expect(isMigratedToV2(events)).toBe(true);
  });

  it('devuelve false si el primer elemento no tiene schemaVersion 2', () => {
    const records = [{ id: '1' } as never];
    expect(isMigratedToV2(records)).toBe(false);
  });
});
