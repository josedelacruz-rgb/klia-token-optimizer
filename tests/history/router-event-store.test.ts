import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  RouterEventStore,
  createDecisionEvent,
  createExecutionEvent,
} from '../../src/history/router-event-store';
import type { ExecutionRecord, RouterEvent } from '../../src/types';
import { ROUTER_EVENT_SCHEMA_VERSION } from '../../src/types';

const tmpDir = path.join(__dirname, '.tmp-event-store');
const tmpFile = path.join(tmpDir, 'events.json');

function makeDecision(): RouterEvent {
  return createDecisionEvent({
    sessionId: 'sess-1',
    query: 'refactoriza auth',
    model: 'glm-5.2',
    modelFamily: 'glm',
    taskType: 'REFACTOR',
    signals: { fileCount: 12, contextSizeBytes: 250_000 },
    decision: { optimizer: 'RTK', version: 'V1', confidence: 0.5, reason: 'test' },
    source: 'mcp',
  });
}

function makeExecution(opt: 'BASELINE' | 'DCP' | 'RTK', tokens: number): RouterEvent {
  return createExecutionEvent({
    sessionId: 'sess-1',
    query: 'refactoriza auth',
    model: 'glm-5.2',
    modelFamily: 'glm',
    taskType: 'REFACTOR',
    signals: { fileCount: 12, contextSizeBytes: 250_000 },
    execution: {
      optimizer: opt,
      inputTokens: Math.round(tokens * 0.8),
      outputTokens: Math.round(tokens * 0.2),
      totalTokens: tokens,
      latencySeconds: 80,
      toolingCost: opt === 'BASELINE' ? 0 : 0.5,
      quality: 0.95,
      failed: false,
    },
    source: 'mcp',
  });
}

describe('RouterEventStore', () => {
  beforeEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('crea el archivo si no existe y devuelve lista vacia', () => {
    const store = new RouterEventStore(tmpFile);
    expect(store.list()).toEqual([]);
  });

  it('almacena y recupera eventos', async () => {
    const store = new RouterEventStore(tmpFile);
    await store.add(makeDecision());
    await store.add(makeExecution('RTK', 9000));
    const events = store.list();
    expect(events).toHaveLength(2);
    expect(events[0].schemaVersion).toBe(ROUTER_EVENT_SCHEMA_VERSION);
    expect(events[0].type).toBe('decision');
    expect(events[1].type).toBe('execution');
    expect(events[1].execution?.inputTokens).toBe(7200);
    expect(events[1].execution?.outputTokens).toBe(1800);
  });

  it('filtra por type, model, taskType, optimizer, source y excludeSynthetic', async () => {
    const store = new RouterEventStore(tmpFile);
    await store.add(makeDecision());
    await store.add(makeExecution('BASELINE', 10000));
    await store.add(makeExecution('RTK', 9000));
    await store.add({ ...makeExecution('DCP', 9500), synthetic: true, source: 'benchmark' });

    expect(store.query({ type: 'decision' })).toHaveLength(1);
    expect(store.query({ type: 'execution' })).toHaveLength(3);
    expect(store.query({ model: 'glm-5.2' })).toHaveLength(4);
    expect(store.query({ taskType: 'REFACTOR' })).toHaveLength(4);
    expect(store.query({ type: 'execution', optimizer: 'RTK' })).toHaveLength(1);
    expect(store.query({ source: 'benchmark' })).toHaveLength(1);
    expect(store.query({ excludeSynthetic: true })).toHaveLength(3);
    expect(store.query({ sessionId: 'sess-1' })).toHaveLength(4);
  });

  it('migra registros v1 (ExecutionRecord) perezosamente en memoria', () => {
    // Escribir directamente un archivo con registros v1
    const v1Records: ExecutionRecord[] = [
      {
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
          quality: 0.95,
          failed: false,
        },
        contextSnapshot: { fileCount: 5, contextSizeBytes: 50_000 },
      },
    ];
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tmpFile, JSON.stringify(v1Records, null, 2), 'utf-8');

    const store = new RouterEventStore(tmpFile);
    const events = store.list();
    expect(events).toHaveLength(1);
    expect(events[0].schemaVersion).toBe(ROUTER_EVENT_SCHEMA_VERSION);
    expect(events[0].type).toBe('execution');
    expect(events[0].execution?.totalTokens).toBe(8000);
  });

  it('migrateFile persiste la migracion v1->v2 y devuelve el contador', () => {
    const v1Records: ExecutionRecord[] = [
      {
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
          quality: 0.95,
          failed: false,
        },
        contextSnapshot: { fileCount: 5, contextSizeBytes: 50_000 },
      },
      {
        id: '2',
        timestamp: '2026-01-01T00:01:00Z',
        model: 'glm-5.2',
        modelFamily: 'glm',
        taskType: 'MULTISTEP',
        optimizer: 'BASELINE',
        metrics: {
          tokens: 10000,
          latencySeconds: 110,
          toolingCost: 0,
          quality: 0.95,
          failed: false,
        },
        contextSnapshot: { fileCount: 5, contextSizeBytes: 50_000 },
      },
    ];
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tmpFile, JSON.stringify(v1Records, null, 2), 'utf-8');

    const store = new RouterEventStore(tmpFile);
    const migrated = store.migrateFile();
    expect(migrated).toBe(2);

    // Idempotente: segunda llamada no migra nada.
    const migrated2 = store.migrateFile();
    expect(migrated2).toBe(0);

    // Verificar que el archivo persistente tiene schemaVersion 2.
    const persisted = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    expect(persisted[0].schemaVersion).toBe(ROUTER_EVENT_SCHEMA_VERSION);
  });

  it('markAllAsSynthetic marca todos los eventos como sinteticos', async () => {
    const store = new RouterEventStore(tmpFile);
    await store.add(makeDecision());
    await store.add(makeExecution('RTK', 9000));
    const n = store.markAllAsSynthetic('benchmark');
    expect(n).toBe(2);
    const events = store.list();
    expect(events.every((e) => e.synthetic === true && e.source === 'benchmark')).toBe(true);
  });
});

describe('createDecisionEvent / createExecutionEvent', () => {
  it('crea evento decision con campos obligatorios', () => {
    const e = makeDecision();
    expect(e.schemaVersion).toBe(ROUTER_EVENT_SCHEMA_VERSION);
    expect(e.type).toBe('decision');
    expect(e.query).toBe('refactoriza auth');
    expect(e.decision?.optimizer).toBe('RTK');
    expect(e.source).toBe('mcp');
  });

  it('crea evento execution con input/output tokens separados', () => {
    const e = makeExecution('DCP', 10000);
    expect(e.type).toBe('execution');
    expect(e.execution?.inputTokens).toBe(8000);
    expect(e.execution?.outputTokens).toBe(2000);
    expect(e.execution?.totalTokens).toBe(10000);
  });
});
