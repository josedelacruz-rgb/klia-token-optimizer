import type { Optimizer, TaskAnalysis, TaskType } from '../types';

export const BASE_RULES: Record<TaskType, Optimizer[]> = {
  SMALL_CODE: ['SEMBLE'],
  TERMINAL: ['RTK', 'DCP', 'BASELINE'],
  LARGE_CONTEXT: ['SEMBLE', 'SERENA', 'CONTEXT_MODE', 'REPOMIX', 'BASELINE'],
  REPOSITORY_SEARCH: ['SEMBLE', 'CONTEXT_MODE', 'REPOMIX', 'BASELINE'],
  MULTISTEP: ['DCP', 'BASELINE'],
  REFACTOR: ['SERENA', 'RTK', 'BASELINE', 'REPOMIX'],
  DEBUG: ['SERENA', 'CONTEXT_MODE', 'RTK', 'BASELINE'],
  UNKNOWN: ['BASELINE'],
};

// Congelar el mapa y sus listas para evitar mutaciones accidentales en runtime.
Object.freeze(BASE_RULES);
for (const taskType of Object.keys(BASE_RULES) as TaskType[]) {
  Object.freeze(BASE_RULES[taskType]);
}

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
 * Ejemplo: REFACTOR + largeContext combina SERENA/RTK/BASELINE con
 * SEMBLE/CONTEXT_MODE/REPOMIX, permitiendo al selector elegir
 * el optimizador mas adecuado al contexto real.
 */
export function candidatesForAnalysis(analysis: TaskAnalysis): Optimizer[] {
  const primary = candidatesForTask(analysis.taskType);
  const extras: Optimizer[] = [];
  const promoted: Optimizer[] = [];

  if (analysis.largeContext && analysis.taskType !== 'LARGE_CONTEXT') {
    extras.push(...BASE_RULES.LARGE_CONTEXT);
  }

  if (analysis.manyFiles && analysis.taskType !== 'REPOSITORY_SEARCH') {
    extras.push(...BASE_RULES.REPOSITORY_SEARCH);
  }

  if (analysis.requiresMultistep && analysis.taskType !== 'MULTISTEP') {
    extras.push(...BASE_RULES.MULTISTEP);
  }

  // Promociones por caracteristica secundaria: cuando una senal domina la
  // tarea, adelanta el optimizador mas adecuado para que el fallback V0
  // (primera opcion de la lista) no apueste por el default ciego del taskType.
  //
  // TERMINAL + contexto grande: la salida de terminal es enorme/repetitiva
  // (listados, arboles, volcados). La poda determinista (DCP) reduce esas
  // salidas, mientras que la compresion por comando (RTK) apenas las toca.
  if (analysis.taskType === 'TERMINAL' && analysis.largeContext) {
    promoted.push('DCP');
  }

  // Deduplicar preservando orden: promocionados, primarios, luego extras unicos.
  const seen = new Set<Optimizer>();
  const combined: Optimizer[] = [];
  for (const opt of [...promoted, ...primary, ...extras]) {
    if (!seen.has(opt)) {
      seen.add(opt);
      combined.push(opt);
    }
  }
  return combined;
}
