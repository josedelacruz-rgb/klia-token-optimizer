export type Optimizer = 'BASELINE' | 'DCP' | 'RTK' | 'CONTEXT_MODE' | 'REPOMIX' | 'SEMBLE';

export type TaskType =
  | 'SMALL_CODE'
  | 'TERMINAL'
  | 'LARGE_CONTEXT'
  | 'REPOSITORY_SEARCH'
  | 'MULTISTEP'
  | 'REFACTOR'
  | 'UNKNOWN';

export interface TaskSignals {
  /** Descripción o query original de la tarea. */
  query: string;
  /** Número de archivos implicados en el contexto. */
  fileCount: number;
  /** Tamaño total del contexto en bytes. */
  contextSizeBytes: number;
  /** Número esperado de tool calls. */
  toolCallsExpected?: 'low' | 'medium' | 'high';
  /** Indica si se esperan comandos de terminal. */
  hasTerminalCommands?: boolean;
  /** Indica si la tarea implica refactor o cambios en múltiples archivos. */
  isRefactor?: boolean;
  /** Indica si la tarea requiere búsqueda o exploración amplia del repo. */
  isRepositorySearch?: boolean;
  /** Indica si la tarea implica muchos pasos o decisiones secuenciales. */
  isMultistep?: boolean;
}

/**
 * Análisis completo de una tarea: intención principal (taskType)
 * más las características del contexto que la acompañan.
 *
 * A diferencia de TaskType (mutuamente excluyente), TaskAnalysis
 * conserva las señales secundarias para que el selector pueda
 * combinar optimizadores en tareas mixtas (ej: REFACTOR +
 * largeContext).
 */
export interface TaskAnalysis {
  /** Intención principal de la tarea (clasificación actual). */
  taskType: TaskType;
  /** true si el contexto supera el umbral o hay señal de logs/datos masivos. */
  largeContext: boolean;
  /** true si fileCount >= manyFilesThreshold. */
  manyFiles: boolean;
  /** Número esperado de tool calls. */
  expectedToolCalls: 'low' | 'medium' | 'high';
  /** true si la tarea requiere búsqueda amplia en el repositorio. */
  requiresRepositorySearch: boolean;
  /** true si la tarea implica refactorización. */
  requiresRefactoring: boolean;
  /** true si la tarea implica múltiples pasos secuenciales. */
  requiresMultistep: boolean;
  /** true si se esperan comandos de terminal. */
  hasTerminalCommands: boolean;
}

export interface RouterContext {
  /** Modelo o familia de modelo que ejecutará la tarea. */
  model: string;
  /** Señales de la tarea. */
  signals: TaskSignals;
}

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

export interface RouterDecision {
  /** Optimizador recomendado. */
  optimizer: Optimizer;
  /** Versión del router que emitió la decisión. */
  version: 'V0' | 'V1' | 'V2' | 'V3';
  /** Justificación legible de la decisión. */
  reason: string;
  /** Nivel de confianza: 0..1. */
  confidence: number;
  /** Tipo de tarea clasificado. */
  taskType: TaskType;
  /** Alternativas consideradas con score relativo (si aplica). */
  alternatives?: Array<{ optimizer: Optimizer; relativeCost: number; sampleCount: number }>;
}

export interface RouterOptions {
  /** Umbral minimo de confianza para usar una regla aprendida (V2/V3). */
  minConfidence?: number;
  /** Probabilidad de explorar una alternativa cuando la confianza es baja (V3). */
  explorationRate?: number;
  /** Numero minimo de observaciones para considerar una regla confiable (V2). */
  minSamples?: number;
  /** Peso de la latencia en el score. */
  latencyWeight?: number;
  /** Peso del coste de tooling en el score. */
  toolingCostWeight?: number;
  /** Penalizacion aplicada por fallo. */
  failurePenalty?: number;
  /** Penalizacion por unidad de calidad perdida (1 - quality). */
  qualityPenalty?: number;
  /**
   * Factor de reduccion de confianza cuando se usan datos heredados de la familia.
   * Por defecto 0.5: la confianza heredada se reduce a la mitad.
   */
  familyConfidenceWeight?: number;
}

export const DEFAULT_ROUTER_OPTIONS: Required<RouterOptions> = {
  minConfidence: 0.65,
  explorationRate: 0.1,
  minSamples: 3,
  latencyWeight: 1.0,
  toolingCostWeight: 1.0,
  failurePenalty: 5.0,
  qualityPenalty: 3.0,
  familyConfidenceWeight: 0.5,
};

// ============================================================================
// Esquema v2 (unificado)
//
// RouterEvent sustituye a ExecutionRecord + McpUsageMetric. Un único evento
// puede ser 'decision' (el router eligió optimizador) o 'execution' (resultado
// real medido). Se emparejan mediante sessionId.
//
// Los esquemas v1 (ExecutionRecord, McpUsageMetric) se conservan por
// compatibilidad y se migran a v2 con migrateV1ToV2.
// ============================================================================

/** Versión del esquema de RouterEvent. */
export const ROUTER_EVENT_SCHEMA_VERSION = 2 as const;

/** Origen del evento. Permite separar datos reales de sintéticos. */
export type RouterEventSource = 'mcp' | 'cli' | 'benchmark' | 'manual';

/** Señales usadas para clasificar la tarea. Se guardan para reproducibilidad. */
export interface RouterEventSignals {
  fileCount: number;
  contextSizeBytes: number;
  toolCallsExpected?: 'low' | 'medium' | 'high';
  hasTerminalCommands?: boolean;
  isRefactor?: boolean;
  isRepositorySearch?: boolean;
  isMultistep?: boolean;
}

/** Decisión del router (cuando type === 'decision'). */
export interface RouterEventDecision {
  optimizer: Optimizer;
  version: 'V0' | 'V1' | 'V2' | 'V3';
  confidence: number;
  reason: string;
  /** Alternativas consideradas con score relativo (si aplica). */
  alternatives?: Array<{ optimizer: Optimizer; relativeCost: number; sampleCount: number }>;
}

/** Resultado medido de una ejecución (cuando type === 'execution'). */
export interface RouterEventExecution {
  /** Optimizador realmente usado (puede diferir del decidido). */
  optimizer: Optimizer;
  /** Tokens de entrada (prompt). Si solo se conoce el total, dejar outputTokens=0. */
  inputTokens: number;
  /** Tokens de salida (completion). */
  outputTokens: number;
  /** Tokens totales = input + output. Derivado, pero se guarda por compat. */
  totalTokens: number;
  /** Latencia real en segundos. */
  latencySeconds: number;
  /** Coste real en USD. Opcional: si no se conoce, se estima con pricing. */
  costUsd?: number;
  /** Coste estimado del tooling (unidades arbitrarias). */
  toolingCost: number;
  /** Calidad del resultado: 0..1. */
  quality: number;
  /** true si la ejecución falló o fue rechazada. */
  failed: boolean;
  /** Número de reintentos. */
  retries?: number;
  /** Mensaje de error si failed=true. */
  errorMessage?: string;
  /** Tamaño del contexto DESPUÉS de aplicar el optimizador (bytes). */
  contextSizeBytesAfter?: number;
  /** Tokens eliminados por el optimizador (poda, compresión, etc.). */
  tokensPruned?: number;
  /** Número real de tool calls ejecutados (para validar toolCallsExpected). */
  actualToolCalls?: number;
  /** Latencia del propio router al decidir (ms). */
  routerLatencyMs?: number;
  /** Timestamp ISO de inicio de la ejecución. */
  startedAt?: string;
  /** Timestamp ISO de finalización de la ejecución. */
  completedAt?: string;
}

/**
 * Evento unificado del router.
 *
 * Un evento 'decision' se emite cuando el router elige un optimizador.
 * Un evento 'execution' se emite cuando se registra el resultado real.
 * Ambos comparten sessionId si provienen de la misma tarea.
 */
export interface RouterEvent {
  /** Identificador único del evento. */
  id: string;
  /** Versión del esquema. Actualmente 2. */
  schemaVersion: typeof ROUTER_EVENT_SCHEMA_VERSION;
  /** Marca temporal ISO 8601. */
  timestamp: string;
  /** 'decision' (el router eligió) o 'execution' (resultado medido). */
  type: 'decision' | 'execution';

  /** Identificador de sesión: empareja decision+execution de la misma tarea. */
  sessionId?: string;
  /** Identificador del proyecto/repo (cwd o nombre). Opcional. */
  projectId?: string;

  /** Query original de la tarea. Se guarda para auditoría. */
  query: string;
  /** Hash de la query (alternativa si preocupa la privacidad). */
  queryHash?: string;
  /** Modelo utilizado. */
  model: string;
  /** Familia inferida del modelo, por ejemplo "glm", "deepseek", "gpt", "claude". */
  modelFamily: string;
  /** Tipo de tarea clasificado. */
  taskType: TaskType;
  /** Señales usadas para clasificar. */
  signals: RouterEventSignals;
  /** Análisis derivado: intención + características del contexto. */
  analysis?: TaskAnalysis;

  /** Decisión del router (solo si type === 'decision'). */
  decision?: RouterEventDecision;
  /** Resultado medido (solo si type === 'execution'). */
  execution?: RouterEventExecution;

  /** Origen del evento. */
  source: RouterEventSource;
  /** true si los datos son sintéticos (benchmark, simulación, CLI placeholder). */
  synthetic?: boolean;
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
