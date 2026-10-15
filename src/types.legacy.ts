import type { Optimizer, TaskType } from './types';

// ============================================================================
// Esquema v1 (legacy)
//
// Tipos de la primera version del historico. Se conservan para que el router
// adaptativo siga aprendiendo y para migrar a v2 (RouterEvent) con
// migrateV1ToV2. Se mantienen en su propio modulo para no ensuciar el
// esquema actual (types.ts), que reexporta estos tipos por compatibilidad.
// ============================================================================

export interface ExecutionRecord {
  /** Identificador único de la ejecución. */
  id: string;
  /** Marca temporal ISO 8601. */
  timestamp: string;
  /** Modelo utilizado. */
  model: string;
  /** Familia inferida del modelo, por ejemplo "glm", "deepseek", "gpt", "claude". */
  modelFamily?: string;
  /** Tipo de tarea. */
  taskType: TaskType;
  /** Optimizador seleccionado. */
  optimizer: Optimizer;
  /** Métricas observadas. */
  metrics: {
    /** Tokens consumidos. */
    tokens: number;
    /** Latencia en segundos. */
    latencySeconds: number;
    /** Coste estimado del tooling (unidades arbitrarias, p. ej. USD×1000). */
    toolingCost: number;
    /** Calidad del resultado: 0..1. */
    quality: number;
    /** true si la ejecución falló o fue rechazada. */
    failed: boolean;
  };
  /** Contexto adicional de la ejecución: archivos, tamaño, etc. */
  contextSnapshot: {
    fileCount: number;
    contextSizeBytes: number;
    toolCallsExpected?: 'low' | 'medium' | 'high';
  };
}

/**
 * Forma estructural de una métrica MCP v1, independiente del store concreto.
 * Permite migrar cualquier objeto con esta forma (incluido McpUsageMetric).
 */
export interface McpUsageMetricLike {
  timestamp: string;
  model: string;
  modelFamily: string;
  taskType: string;
  optimizer: string;
  version: string;
  confidence: number;
  latencySeconds?: number;
  tokens?: number;
  quality?: number;
  failed?: boolean;
}
