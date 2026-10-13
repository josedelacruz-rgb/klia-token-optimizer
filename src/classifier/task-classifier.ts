import type { TaskSignals, TaskType } from '../types';

export interface TaskClassifierOptions {
  /** Umbral en bytes para considerar contexto grande. Por defecto 1 MB. */
  largeContextThresholdBytes?: number;
  /** Umbral en bytes para considerar contexto grande extremo (SEMBLE). Por defecto 5 MB. */
  extremeContextThresholdBytes?: number;
  /** Umbral de archivos para considerar refactor o búsqueda en repo. */
  manyFilesThreshold?: number;
}

const DEFAULTS: Required<TaskClassifierOptions> = {
  largeContextThresholdBytes: 1024 * 1024,
  extremeContextThresholdBytes: 5 * 1024 * 1024,
  manyFilesThreshold: 8,
};

/**
 * Clasifica una tarea en una de las categorías del router.
 *
 * Orden de prioridad:
 * 1. Señales explícitas (isRefactor, isRepositorySearch, isMultistep, hasTerminalCommands).
 * 2. Heurísticas por tamaño de contexto y número de archivos.
 * 3. Fallback a UNKNOWN.
 */
/**
 * Clasifica el contexto como large o large extremo.
 * Devuelve 'LARGE_CONTEXT' o 'LARGE_CONTEXT_EXTREME' para que el selector
 * priorice SEMBLE cuando el contexto supera el umbral extremo.
 */
export function classifyContextSize(
  signals: TaskSignals,
  opts: TaskClassifierOptions = {},
): 'LARGE_CONTEXT' | 'LARGE_CONTEXT_EXTREME' | null {
  const options = { ...DEFAULTS, ...opts };
  if (signals.contextSizeBytes >= options.extremeContextThresholdBytes) {
    return 'LARGE_CONTEXT_EXTREME';
  }
  if (signals.contextSizeBytes >= options.largeContextThresholdBytes) {
    return 'LARGE_CONTEXT';
  }
  return null;
}

export function classifyTask(
  signals: TaskSignals,
  opts: TaskClassifierOptions = {},
): TaskType {
  const options = { ...DEFAULTS, ...opts };

  if (signals.isRefactor) {
    return 'REFACTOR';
  }

  if (signals.isMultistep) {
    return 'MULTISTEP';
  }

  if (signals.hasTerminalCommands) {
    return 'TERMINAL';
  }

  if (signals.isRepositorySearch) {
    return 'REPOSITORY_SEARCH';
  }

  const sizeCategory = classifyContextSize(signals, opts);
  if (sizeCategory) {
    return 'LARGE_CONTEXT';
  }

  if (signals.fileCount >= options.manyFilesThreshold) {
    // Sin más señales, un contexto con muchos archivos se trata como búsqueda/repo.
    return 'REPOSITORY_SEARCH';
  }

  if (
    signals.fileCount <= 3 &&
    signals.contextSizeBytes < options.largeContextThresholdBytes &&
    (!signals.toolCallsExpected || signals.toolCallsExpected === 'low')
  ) {
    return 'SMALL_CODE';
  }

  return 'UNKNOWN';
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
      /\b(plan|planifica|planificar|migraci[oó]n|fases|etapas)\b/.test(lower));

  const isRefactor =
    base.isRefactor ??
    (lower.includes('refactor') ||
      lower.includes('restructure') ||
      lower.includes('refactoriza') ||
      lower.includes('restructura') ||
      lower.includes('reorganiza'));

  const isRepositorySearch =
    base.isRepositorySearch ??
    (/\b(search|find|where is|locate|all files|across the repo|grep|who calls|references)\b/.test(
      lower,
    ) ||
      /\b(busca|buscar|encuentra|localiza|referencias|llamadas|usos|d[oó]nde)\b/.test(lower));

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
