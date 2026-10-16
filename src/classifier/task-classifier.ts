import type { TaskAnalysis, TaskSignals, TaskType } from '../types';

export interface TaskClassifierOptions {
  /** Umbral en bytes para considerar contexto grande. Por defecto 1 MB. */
  largeContextThresholdBytes?: number;
  /** Umbral de archivos para considerar refactor o búsqueda en repo. */
  manyFilesThreshold?: number;
}

const DEFAULTS: Required<TaskClassifierOptions> = {
  largeContextThresholdBytes: 1024 * 1024,
  manyFilesThreshold: 8,
};

function detectLargeContextSignal(query: string): boolean {
  const lower = query.toLowerCase();
  return (
    /\b(log|logs|logfile|stack trace|stacktrace|traceback|dump|core dump)\b/.test(lower) ||
    /\b(mil|miles|thousands?)\s+(de\s+)?(lineas?|filas?|registros?|entradas?)\b/.test(lower) ||
    /\b(archivo|fichero)\s+(grande|enorme|masivo|de\s+(\d+)\s+(gb|mb|kb|lineas?|filas?))\b/.test(
      lower,
    ) ||
    /\b(\d{4,})\s+(lineas?|filas?|registros?|entradas?|logs?)\b/.test(lower)
  );
}

/**
 * Detecta tareas de lectura/comprension de codigo: explicar como funciona,
 * dar la estructura o las firmas, resumir modulos, etc. Se tratan como
 * LARGE_CONTEXT para que el router considere recuperacion semantica (SEMBLE)
 * o empaquetado (REPOMIX) en lugar de caer en BASELINE.
 */
function detectCodeReadingSignal(query: string): boolean {
  const lower = query.toLowerCase();
  return /\b(explica|explicar|explicame|entiende|entender|comprende|comprender|estructura|firmas?|signatures?|arquitectura|como funciona|resumen|resume|resumir|modulos?|modules?)\b/.test(
    lower,
  );
}

/**
 * Detecta tareas de diagnostico/correccion de errores de tipos o compilacion.
 * Se tratan como DEBUG: Serena localiza simbolos y referencias para hallar el
 * origen del error y corregirlo, y Context Mode recupera el contexto relevante.
 */
function detectTypeErrorSignal(query: string): boolean {
  const lower = query.toLowerCase();
  return (
    /\b(errores?|fallos?)\s+de\s+tip(o|os|ado|ada|ados|adas)?\b/.test(lower) ||
    /\btype\s?-?\s?errors?\b/.test(lower) ||
    /\btypecheck(ing)?\b/.test(lower) ||
    /\b(errores?|fallos?)\s+de\s+compilaci[oó]n\b/.test(lower) ||
    /\bno\s+compila\b/.test(lower) ||
    /\btsc\b/.test(lower)
  );
}

/**
 * Clasifica una tarea en una de las categorías del router.
 *
 * Orden de prioridad:
 * 1. Señales explícitas (isRefactor, isRepositorySearch, isMultistep, hasTerminalCommands).
 * 2. Heurísticas por tamaño de contexto y número de archivos.
 * 3. Fallback a UNKNOWN.
 */
/**
 * Clasifica el contexto por tamano. Devuelve 'LARGE_CONTEXT' si supera el
 * umbral configurado, o null si es pequeno.
 */
export function classifyContextSize(
  signals: TaskSignals,
  opts: TaskClassifierOptions = {},
): 'LARGE_CONTEXT' | null {
  const options = { ...DEFAULTS, ...opts };
  if (signals.contextSizeBytes >= options.largeContextThresholdBytes) {
    return 'LARGE_CONTEXT';
  }
  return null;
}

export function classifyTask(signals: TaskSignals, opts: TaskClassifierOptions = {}): TaskType {
  const options = { ...DEFAULTS, ...opts };
  const hasLargeContextSignal = detectLargeContextSignal(signals.query);

  if (signals.isRefactor) {
    return 'REFACTOR';
  }

  // Errores de tipo/compilacion: diagnostico y correccion de codigo (DEBUG)
  // antes de otras senales, para no caer en TERMINAL o REPOSITORY_SEARCH.
  if (detectTypeErrorSignal(signals.query)) {
    return 'DEBUG';
  }

  if (signals.hasTerminalCommands) {
    return 'TERMINAL';
  }

  // Si la query indica explicitamente analisis de datos grandes o logs,
  // preferir LARGE_CONTEXT sobre búsqueda genérica.
  if (hasLargeContextSignal) {
    return 'LARGE_CONTEXT';
  }

  if (signals.isRepositorySearch) {
    return 'REPOSITORY_SEARCH';
  }

  if (signals.isMultistep) {
    return 'MULTISTEP';
  }

  // Tareas de lectura/comprension de codigo -> LARGE_CONTEXT (SEMBLE/REPOMIX).
  if (detectCodeReadingSignal(signals.query)) {
    return 'LARGE_CONTEXT';
  }

  const sizeCategory = classifyContextSize(signals, opts);
  if (sizeCategory) {
    return 'LARGE_CONTEXT';
  }

  if (signals.fileCount >= options.manyFilesThreshold) {
    // Sin más señales, un contexto con muchos archivos se trata como búsqueda/repo.
    return 'REPOSITORY_SEARCH';
  }

  // Si el contexto es explícitamente pequeño (pocos archivos y menos de 200 KB),
  // y no hay señales claras de otro tipo, se clasifica como SMALL_CODE.
  if (
    signals.fileCount > 0 &&
    signals.fileCount <= 3 &&
    signals.contextSizeBytes > 0 &&
    signals.contextSizeBytes < 200 * 1024 &&
    (!signals.toolCallsExpected || signals.toolCallsExpected === 'low')
  ) {
    return 'SMALL_CODE';
  }

  return 'UNKNOWN';
}

/**
 * Analiza una tarea y devuelve tanto la intención principal (taskType)
 * como las características del contexto (largeContext, manyFiles, etc.).
 *
 * A diferencia de classifyTask, que colapsa toda la información en un
 * único TaskType mutuamente excluyente, analyzeTask conserva las
 * señales secundarias para que el selector pueda combinar optimizadores
 * en tareas mixtas (ej: REFACTOR + largeContext).
 *
 * No reemplaza a classifyTask: la envuelve. taskType se calcula con la
 * lógica actual y las banderas secundarias se derivan de las señales
 * originales, sin alterar la clasificación.
 */
export function analyzeTask(signals: TaskSignals, opts: TaskClassifierOptions = {}): TaskAnalysis {
  const options = { ...DEFAULTS, ...opts };
  const taskType = classifyTask(signals, opts);
  const hasLargeContextSignal = detectLargeContextSignal(signals.query);
  const sizeCategory = classifyContextSize(signals, opts);

  return {
    taskType,
    largeContext: hasLargeContextSignal || sizeCategory !== null,
    manyFiles: signals.fileCount >= options.manyFilesThreshold,
    expectedToolCalls: signals.toolCallsExpected ?? 'low',
    requiresRepositorySearch: signals.isRepositorySearch === true,
    requiresRefactoring: signals.isRefactor === true,
    requiresMultistep: signals.isMultistep === true,
    hasTerminalCommands: signals.hasTerminalCommands === true,
  };
}

/**
 * Extrae señales heurísticas a partir de una query de texto.
 * No es perfecto, pero permite enrutar sin intervención manual.
 */
export function extractSignalsFromQuery(
  query: string,
  base: Partial<TaskSignals> = {},
): TaskSignals {
  const lower = query.toLowerCase();

  const hasTerminalCommands =
    base.hasTerminalCommands ??
    (/\b(run|execute|command|shell|bash|powershell|npm|pnpm|yarn|docker|kubectl|git|pytest|cargo|vitest|test)\b/.test(
      lower,
    ) ||
      /\b(ejecuta|ejecutar|corre|correr|lanza|lanzar|comando|terminal|consola|prueba|tests?|build|compila|instala)\b/.test(
        lower,
      ));

  const isMultistep =
    base.isMultistep ??
    (/\b(step|steps|multi-step|multistep|pipeline|workflow|sequence|iterative|paso|pasos)\b/.test(
      lower,
    ) ||
      /\b(plan|planifica|planificar|fases|etapas)\b/.test(lower) ||
      /\b(migraci[oó]n)\s+(?:en\s+\d+|en\s+(?:varios|varias)\s+pasos?|de\s+\d+\s+pasos?)\b/.test(
        lower,
      ));

  const isRefactor =
    base.isRefactor ??
    (lower.includes('refactor') ||
      lower.includes('restructure') ||
      lower.includes('refactoriza') ||
      lower.includes('restructura') ||
      lower.includes('reorganiza'));

  const isRepositorySearch =
    base.isRepositorySearch ??
    (/\b(search|find|where is|locate|all files|across the repo|in the repo|grep|who calls|references)\b/.test(
      lower,
    ) ||
      /\b(busca|buscar|encuentra|encontrar|localiza|donde|d[oó]nde est[aá]|referencias|llamadas|usos|en el (repo|repositorio|proyecto|codigo|c[oó]digo|historico|hist[oó]rico))\b/.test(
        lower,
      ));

  return {
    query,
    fileCount: base.fileCount ?? 0,
    contextSizeBytes: base.contextSizeBytes ?? 0,
    toolCallsExpected: base.toolCallsExpected ?? 'low',
    hasTerminalCommands,
    isRefactor,
    isMultistep,
    isRepositorySearch,
  };
}
