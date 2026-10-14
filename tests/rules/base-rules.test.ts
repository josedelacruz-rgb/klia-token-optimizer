import { describe, expect, it } from 'vitest';
import { candidatesForAnalysis, candidatesForTask, defaultOptimizerForTask } from '../../src/rules/base-rules';
import type { TaskAnalysis } from '../../src/types';

describe('base-rules', () => {
  it('SMALL_CODE → BASELINE', () => {
    expect(candidatesForTask('SMALL_CODE')).toEqual(['BASELINE']);
    expect(defaultOptimizerForTask('SMALL_CODE')).toBe('BASELINE');
  });

  it('TERMINAL → RTK, DCP, BASELINE', () => {
    expect(candidatesForTask('TERMINAL')).toEqual(['RTK', 'DCP', 'BASELINE']);
    expect(defaultOptimizerForTask('TERMINAL')).toBe('RTK');
  });

  it('LARGE_CONTEXT → SEMBLE, CONTEXT_MODE, REPOMIX, BASELINE', () => {
    expect(candidatesForTask('LARGE_CONTEXT')).toEqual(['SEMBLE', 'CONTEXT_MODE', 'REPOMIX', 'BASELINE']);
  });

  it('REPOSITORY_SEARCH → BASELINE, CONTEXT_MODE, REPOMIX', () => {
    expect(candidatesForTask('REPOSITORY_SEARCH')).toEqual(['BASELINE', 'CONTEXT_MODE', 'REPOMIX']);
    expect(defaultOptimizerForTask('REPOSITORY_SEARCH')).toBe('BASELINE');
  });

  it('MULTISTEP → DCP, BASELINE', () => {
    expect(candidatesForTask('MULTISTEP')).toEqual(['DCP', 'BASELINE']);
  });

  it('REFACTOR → RTK, BASELINE', () => {
    expect(candidatesForTask('REFACTOR')).toEqual(['RTK', 'BASELINE']);
  });

  it('UNKNOWN cae a BASELINE', () => {
    expect(candidatesForTask('UNKNOWN')).toEqual(['BASELINE']);
    expect(defaultOptimizerForTask('UNKNOWN')).toBe('BASELINE');
  });
});

describe('candidatesForAnalysis', () => {
  it('tarea pura (sin senales secundarias) usa solo candidatos del taskType', () => {
    const analysis: TaskAnalysis = {
      taskType: 'REFACTOR',
      largeContext: false,
      manyFiles: false,
      expectedToolCalls: 'low',
      requiresRepositorySearch: false,
      requiresRefactoring: true,
      requiresMultistep: false,
      hasTerminalCommands: false,
    };
    expect(candidatesForAnalysis(analysis)).toEqual(['RTK', 'BASELINE']);
  });

  it('REFACTOR + largeContext combina con LARGE_CONTEXT', () => {
    const analysis: TaskAnalysis = {
      taskType: 'REFACTOR',
      largeContext: true,
      manyFiles: false,
      expectedToolCalls: 'high',
      requiresRepositorySearch: false,
      requiresRefactoring: true,
      requiresMultistep: false,
      hasTerminalCommands: false,
    };
    // REFACTOR: [RTK, BASELINE] + LARGE_CONTEXT: [SEMBLE, CONTEXT_MODE, REPOMIX, BASELINE]
    expect(candidatesForAnalysis(analysis)).toEqual([
      'RTK', 'BASELINE', 'SEMBLE', 'CONTEXT_MODE', 'REPOMIX',
    ]);
  });

  it('TERMINAL + requiresRepositorySearch combina con REPOSITORY_SEARCH', () => {
    const analysis: TaskAnalysis = {
      taskType: 'TERMINAL',
      largeContext: false,
      manyFiles: true,
      expectedToolCalls: 'medium',
      requiresRepositorySearch: true,
      requiresRefactoring: false,
      requiresMultistep: false,
      hasTerminalCommands: true,
    };
    // TERMINAL: [RTK, DCP, BASELINE] + REPOSITORY_SEARCH: [BASELINE, CONTEXT_MODE, REPOMIX]
    expect(candidatesForAnalysis(analysis)).toEqual([
      'RTK', 'DCP', 'BASELINE', 'CONTEXT_MODE', 'REPOMIX',
    ]);
  });

  it('MULTISTEP + manyFiles + largeContext combina con REPOSITORY_SEARCH y LARGE_CONTEXT', () => {
    const analysis: TaskAnalysis = {
      taskType: 'MULTISTEP',
      largeContext: true,
      manyFiles: true,
      expectedToolCalls: 'high',
      requiresRepositorySearch: false,
      requiresRefactoring: false,
      requiresMultistep: true,
      hasTerminalCommands: false,
    };
    // MULTISTEP: [DCP, BASELINE] + REPOSITORY_SEARCH + LARGE_CONTEXT
    expect(candidatesForAnalysis(analysis)).toEqual([
      'DCP', 'BASELINE', 'SEMBLE', 'CONTEXT_MODE', 'REPOMIX',
    ]);
  });

  it('LARGE_CONTEXT pura no duplica candidatos', () => {
    const analysis: TaskAnalysis = {
      taskType: 'LARGE_CONTEXT',
      largeContext: true,
      manyFiles: false,
      expectedToolCalls: 'medium',
      requiresRepositorySearch: false,
      requiresRefactoring: false,
      requiresMultistep: false,
      hasTerminalCommands: false,
    };
    // largeContext=true pero taskType ya es LARGE_CONTEXT: no anade extras
    expect(candidatesForAnalysis(analysis)).toEqual([
      'SEMBLE', 'CONTEXT_MODE', 'REPOMIX', 'BASELINE',
    ]);
  });

  it('SMALL_CODE + requiresMultistep combina con MULTISTEP', () => {
    const analysis: TaskAnalysis = {
      taskType: 'SMALL_CODE',
      largeContext: false,
      manyFiles: false,
      expectedToolCalls: 'low',
      requiresRepositorySearch: false,
      requiresRefactoring: false,
      requiresMultistep: true,
      hasTerminalCommands: false,
    };
    // SMALL_CODE: [BASELINE] + MULTISTEP: [DCP, BASELINE]
    expect(candidatesForAnalysis(analysis)).toEqual(['BASELINE', 'DCP']);
  });
});
