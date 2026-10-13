import { describe, expect, it } from 'vitest';
import { classifyTask, extractSignalsFromQuery } from '../../src/classifier/task-classifier';

describe('classifyTask', () => {
  it('clasifica SMALL_CODE para pocos archivos y contexto pequeño', () => {
    const signals = {
      query: 'Corrige un typo',
      fileCount: 1,
      contextSizeBytes: 10_000,
      toolCallsExpected: 'low' as const,
    };
    expect(classifyTask(signals)).toBe('SMALL_CODE');
  });

  it('clasifica TERMINAL si hay comandos', () => {
    const signals = {
      query: 'Ejecuta npm test',
      fileCount: 5,
      contextSizeBytes: 100_000,
      hasTerminalCommands: true,
    };
    expect(classifyTask(signals)).toBe('TERMINAL');
  });

  it('clasifica LARGE_CONTEXT si el contexto supera el umbral', () => {
    const signals = {
      query: 'Revisa documentación extensa',
      fileCount: 2,
      contextSizeBytes: 2 * 1024 * 1024,
    };
    expect(classifyTask(signals)).toBe('LARGE_CONTEXT');
  });

  it('clasifica REPOSITORY_SEARCH con muchos archivos', () => {
    const signals = {
      query: 'Encuentra todas las llamadas a login',
      fileCount: 20,
      contextSizeBytes: 100_000,
    };
    expect(classifyTask(signals)).toBe('REPOSITORY_SEARCH');
  });

  it('prioriza REFACTOR sobre otras señales', () => {
    const signals = {
      query: 'Refactoriza auth',
      fileCount: 20,
      contextSizeBytes: 2 * 1024 * 1024,
      isRefactor: true,
    };
    expect(classifyTask(signals)).toBe('REFACTOR');
  });

  it('prioriza MULTISTEP sobre heurísticas de tamaño', () => {
    const signals = {
      query: 'Planifica migración en 5 pasos',
      fileCount: 1,
      contextSizeBytes: 5_000,
      isMultistep: true,
    };
    expect(classifyTask(signals)).toBe('MULTISTEP');
  });
});

describe('extractSignalsFromQuery', () => {
  it('detecta comandos de terminal', () => {
    const signals = extractSignalsFromQuery('run npm test');
    expect(signals.hasTerminalCommands).toBe(true);
  });

  it('detecta intención de refactor', () => {
    const signals = extractSignalsFromQuery('refactor extract function');
    expect(signals.isRefactor).toBe(true);
  });

  it('detecta búsqueda en repositorio', () => {
    const signals = extractSignalsFromQuery('find all references to foo');
    expect(signals.isRepositorySearch).toBe(true);
  });

  it('respeta señales base explícitas', () => {
    const signals = extractSignalsFromQuery('run npm test', {
      hasTerminalCommands: false,
      fileCount: 3,
    });
    expect(signals.hasTerminalCommands).toBe(false);
    expect(signals.fileCount).toBe(3);
  });
});
