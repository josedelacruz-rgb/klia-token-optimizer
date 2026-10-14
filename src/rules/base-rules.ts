import type { Optimizer, TaskAnalysis, TaskType } from '../types';

export const BASE_RULES: Record<TaskType, Optimizer[]> = {
  SMALL_CODE: ['BASELINE'],
  TERMINAL: ['RTK', 'DCP', 'BASELINE'],
  LARGE_CONTEXT: ['SEMBLE', 'CONTEXT_MODE', 'REPOMIX', 'BASELINE'],
  REPOSITORY_SEARCH: ['BASELINE', 'CONTEXT_MODE', 'REPOMIX'],
  MULTISTEP: ['DCP', 'BASELINE'],
  REFACTOR: ['RTK', 'BASELINE'],
  UNKNOWN: ['BASELINE'],
};

/**
 * Devuelve la lista de optimizadores candidatos para un tipo de tarea
 * segun las reglas generales V0.
 */
export function candidatesForTask(taskType: TaskType): Optimizer[] {
  return BASE_RULES[taskType] ?? ['BASELINE'];
}

/**
 * Devuelve el optimizador por defecto (primera opcion) de las reglas base.
 */
export function defaultOptimizerForTask(taskType: TaskType): Optimizer {
  return candidatesForTask(taskType)[0] ?? 'BASELINE';
}

/**
 * Devuelve candidatos combinados para una tarea mixta.
 *
 * Incluye los candidatos del taskType principal mas los de las
 * caracteristicas secundarias que aportan valor (largeContext,
 * manyFiles, requiresRepositorySearch, requiresMultistep).
 *
 * Ejemplo: REFACTOR + largeContext combina RTK/BASELINE con
 * SEMBLE/CONTEXT_MODE/REPOMIX, permitiendo al selector elegir
 * el optimizador mas adecuado al contexto real.
 */
export function candidatesForAnalysis(analysis: TaskAnalysis): Optimizer[] {
  const primary = candidatesForTask(analysis.taskType);
  const extras: Optimizer[] = [];

  if (analysis.largeContext && analysis.taskType !== 'LARGE_CONTEXT') {
    extras.push(...BASE_RULES.LARGE_CONTEXT);
  }

  if (analysis.manyFiles && analysis.taskType !== 'REPOSITORY_SEARCH') {
    extras.push(...BASE_RULES.REPOSITORY_SEARCH);
  }

  if (analysis.requiresMultistep && analysis.taskType !== 'MULTISTEP') {
    extras.push(...BASE_RULES.MULTISTEP);
  }

  // Deduplicar preservando orden: primarios primero, luego extras unicos.
  const seen = new Set<Optimizer>();
  const combined: Optimizer[] = [];
  for (const opt of [...primary, ...extras]) {
    if (!seen.has(opt)) {
      seen.add(opt);
      combined.push(opt);
    }
  }
  return combined;
}
