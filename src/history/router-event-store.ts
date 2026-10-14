import * as fs from 'fs';
import * as path from 'path';
import type { Optimizer, RouterEvent, TaskType } from '../types';
import { ROUTER_EVENT_SCHEMA_VERSION } from '../types';
import { withFileLock } from '../utils/file-lock';
import { isMigratedToV2, migrateV1ToV2 } from './migrate';
import { readJsonSync } from '../utils/json';

/**
 * Store unificado para RouterEvent (esquema v2).
 *
 * Reemplaza a JsonHistoryStore + McpMetricsStore. Persiste eventos en un único
 * archivo JSON, migrando automáticamente registros v1 si los detecta.
 */
export class RouterEventStore {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.ensureFile();
  }

  private ensureFile(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify([], null, 2), 'utf-8');
    }
  }

  private read(): RouterEvent[] {
    const parsed = readJsonSync(this.filePath) as unknown[];

    // Migracion perezosa: si hay registros v1, se migran en memoria.
    // No se persiste aqui para no sorprender al usuario; usar migrateFile().
    if (parsed.length === 0) return [];
    if (isMigratedToV2(parsed)) {
      return parsed as RouterEvent[];
    }
    // Asumimos ExecutionRecord v1
    return migrateV1ToV2(parsed as Parameters<typeof migrateV1ToV2>[0]);
  }

  private write(events: RouterEvent[]): void {
    fs.writeFileSync(this.filePath, JSON.stringify(events, null, 2), 'utf-8');
  }

  async add(event: RouterEvent): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const events = this.read();
      events.push(event);
      this.write(events);
    });
  }

  list(): RouterEvent[] {
    return this.read();
  }

  /**
   * Persiste la migración v1->v2 en el archivo. Devuelve el número de
   * eventos migrados. Si ya estaba migrado, devuelve 0.
   */
  migrateFile(): number {
    const parsed = readJsonSync(this.filePath) as unknown[];
    if (parsed.length === 0) return 0;
    if (isMigratedToV2(parsed)) return 0;
    const migrated = migrateV1ToV2(parsed as Parameters<typeof migrateV1ToV2>[0]);
    this.write(migrated);
    return migrated.length;
  }

  /**
   * Filtra eventos por tipo, modelo, tarea, optimizador, fuente y no-sintéticos.
   */
  query(filter: {
    type?: 'decision' | 'execution';
    model?: string;
    taskType?: TaskType;
    optimizer?: Optimizer;
    source?: RouterEvent['source'];
    excludeSynthetic?: boolean;
    sessionId?: string;
  }): RouterEvent[] {
    const events = this.read();
    return events.filter((e) => {
      if (filter.type && e.type !== filter.type) return false;
      if (filter.model && e.model !== filter.model) return false;
      if (filter.taskType && e.taskType !== filter.taskType) return false;
      if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
      if (filter.source && e.source !== filter.source) return false;
      if (filter.excludeSynthetic && e.synthetic) return false;
      if (filter.optimizer) {
        if (filter.type === 'decision') {
          if (e.decision?.optimizer !== filter.optimizer) return false;
        } else if (filter.type === 'execution') {
          if (e.execution?.optimizer !== filter.optimizer) return false;
        } else {
          const opt = e.decision?.optimizer ?? e.execution?.optimizer;
          if (opt !== filter.optimizer) return false;
        }
      }
      return true;
    });
  }

  /**
   * Marca todos los eventos existentes como sintéticos (para benchmark).
   * Útil al sembrar datos de calibración.
   */
  markAllAsSynthetic(source: RouterEvent['source'] = 'benchmark'): number {
    const events = this.read();
    for (const e of events) {
      e.synthetic = true;
      if (!e.source || e.source === 'mcp') e.source = source;
    }
    this.write(events);
    return events.length;
  }
}

/**
 * Crea un RouterEvent de tipo 'decision'.
 */
export function createDecisionEvent(params: {
  sessionId?: string;
  projectId?: string;
  query: string;
  model: string;
  modelFamily: string;
  taskType: TaskType;
  signals: RouterEvent['signals'];
  decision: RouterEvent['decision'];
  source: RouterEvent['source'];
  synthetic?: boolean;
}): RouterEvent {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    schemaVersion: ROUTER_EVENT_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    type: 'decision',
    sessionId: params.sessionId,
    projectId: params.projectId,
    query: params.query,
    model: params.model,
    modelFamily: params.modelFamily,
    taskType: params.taskType,
    signals: params.signals,
    decision: params.decision,
    source: params.source,
    synthetic: params.synthetic,
  };
}

/**
 * Crea un RouterEvent de tipo 'execution'.
 */
export function createExecutionEvent(params: {
  sessionId?: string;
  projectId?: string;
  query: string;
  model: string;
  modelFamily: string;
  taskType: TaskType;
  signals: RouterEvent['signals'];
  execution: RouterEvent['execution'];
  source: RouterEvent['source'];
  synthetic?: boolean;
}): RouterEvent {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    schemaVersion: ROUTER_EVENT_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    type: 'execution',
    sessionId: params.sessionId,
    projectId: params.projectId,
    query: params.query,
    model: params.model,
    modelFamily: params.modelFamily,
    taskType: params.taskType,
    signals: params.signals,
    execution: params.execution,
    source: params.source,
    synthetic: params.synthetic,
  };
}
