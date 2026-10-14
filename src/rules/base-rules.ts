import type { Optimizer, TaskType } from '../types';

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
 * según las reglas generales V0.
 */
export function candidatesForTask(taskType: TaskType): Optimizer[] {
  return BASE_RULES[taskType] ?? ['BASELINE'];
}

/**
 * Devuelve el optimizador por defecto (primera opción) de las reglas base.
 */
export function defaultOptimizerForTask(taskType: TaskType): Optimizer {
  return candidatesForTask(taskType)[0] ?? 'BASELINE';
}
