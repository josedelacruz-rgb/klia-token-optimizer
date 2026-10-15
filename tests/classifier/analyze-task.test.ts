import { describe, expect, it } from 'vitest';
import { analyzeTask, extractSignalsFromQuery } from '../../src/classifier/task-classifier';
import type { TaskAnalysis } from '../../src/types';

describe('analyzeTask', () => {
  it('preserva largeContext aunque classifyTask devuelva REFACTOR (log masivo)', () => {
    const signals = extractSignalsFromQuery(
      'Refactoriza el scoring y analiza el log de 3000 lineas',
      { fileCount: 3, contextSizeBytes: 15_000 },
    );
    const analysis = analyzeTask(signals);
    expect(analysis.taskType).toBe('REFACTOR');
    expect(analysis.largeContext).toBe(true);
    expect(analysis.requiresRefactoring).toBe(true);
    expect(analysis.requiresRepositorySearch).toBe(false);
  });

  it('preserva requiresRepositorySearch aunque classifyTask devuelva TERMINAL', () => {
    const signals = extractSignalsFromQuery('Ejecuta npm test y busca donde falla en el repo', {
      fileCount: 5,
      contextSizeBytes: 100_000,
    });
    const analysis = analyzeTask(signals);
    expect(analysis.taskType).toBe('TERMINAL');
    expect(analysis.hasTerminalCommands).toBe(true);
    expect(analysis.requiresRepositorySearch).toBe(true);
  });

  it('preserva manyFiles aunque classifyTask devuelva REFACTOR', () => {
    const signals = extractSignalsFromQuery('Refactoriza 10 archivos del modulo de auth', {
      fileCount: 10,
      contextSizeBytes: 80_000,
      isRefactor: true,
    });
    const analysis = analyzeTask(signals);
    expect(analysis.taskType).toBe('REFACTOR');
    expect(analysis.manyFiles).toBe(true);
    expect(analysis.requiresRefactoring).toBe(true);
  });

  it('preserva manyFiles aunque classifyTask devuelva MULTISTEP', () => {
    const signals = extractSignalsFromQuery('Planifica la migracion en 5 pasos con 20 archivos', {
      fileCount: 20,
      contextSizeBytes: 50_000,
      isMultistep: true,
    });
    const analysis = analyzeTask(signals);
    expect(analysis.taskType).toBe('MULTISTEP');
    expect(analysis.manyFiles).toBe(true);
    expect(analysis.requiresMultistep).toBe(true);
  });

  it('clasifica SMALL_CODE con todas las banderas secundarias en false', () => {
    const signals = extractSignalsFromQuery(
      'cambia el nombre de la variable foo por bar en src/index.ts',
      { fileCount: 1, contextSizeBytes: 4_000 },
    );
    const analysis = analyzeTask(signals);
    expect(analysis.taskType).toBe('SMALL_CODE');
    expect(analysis.largeContext).toBe(false);
    expect(analysis.manyFiles).toBe(false);
    expect(analysis.requiresRepositorySearch).toBe(false);
    expect(analysis.requiresRefactoring).toBe(false);
    expect(analysis.requiresMultistep).toBe(false);
    expect(analysis.hasTerminalCommands).toBe(false);
    expect(analysis.expectedToolCalls).toBe('low');
  });

  it('detecta largeContext por señal textual de logs masivos', () => {
    const signals = extractSignalsFromQuery(
      'Analizar un log de 5000 lineas para encontrar errores',
      { fileCount: 1, contextSizeBytes: 200_000 },
    );
    const analysis = analyzeTask(signals);
    expect(analysis.taskType).toBe('LARGE_CONTEXT');
    expect(analysis.largeContext).toBe(true);
    // "encontrar" activa isRepositorySearch; la señal textual de log gana
    expect(analysis.requiresRepositorySearch).toBe(true);
  });

  it('detecta largeContext por tamaño de contexto', () => {
    const signals = extractSignalsFromQuery(
      'Dame la estructura completa del proyecto',
      { fileCount: 2, contextSizeBytes: 2 * 1024 * 1024 }, // 2 MB > umbral de 1 MB
    );
    const analysis = analyzeTask(signals);
    expect(analysis.taskType).toBe('LARGE_CONTEXT');
    expect(analysis.largeContext).toBe(true);
    expect(analysis.manyFiles).toBe(false);
  });

  it('detecta manyFiles para búsqueda en repositorio grande', () => {
    const signals = extractSignalsFromQuery('Encuentra todas las llamadas a login', {
      fileCount: 20,
      contextSizeBytes: 100_000,
    });
    const analysis = analyzeTask(signals);
    expect(analysis.taskType).toBe('REPOSITORY_SEARCH');
    expect(analysis.manyFiles).toBe(true);
    expect(analysis.requiresRepositorySearch).toBe(true);
  });

  it('detecta hasTerminalCommands aunque no haya palabras de búsqueda', () => {
    const signals = extractSignalsFromQuery('Ejecuta eslint src/ --fix', {
      fileCount: 0,
      contextSizeBytes: 80_000,
    });
    const analysis = analyzeTask(signals);
    expect(analysis.taskType).toBe('TERMINAL');
    expect(analysis.hasTerminalCommands).toBe(true);
    expect(analysis.largeContext).toBe(false);
    expect(analysis.manyFiles).toBe(false);
  });

  it('usa expectedToolCalls explícito si se pasa', () => {
    const signals = extractSignalsFromQuery('Refactoriza auth', {
      fileCount: 2,
      contextSizeBytes: 30_000,
      toolCallsExpected: 'high',
      isRefactor: true,
    });
    const analysis = analyzeTask(signals);
    expect(analysis.taskType).toBe('REFACTOR');
    expect(analysis.expectedToolCalls).toBe('high');
    expect(analysis.requiresRefactoring).toBe(true);
  });
});
