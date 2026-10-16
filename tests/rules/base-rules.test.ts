import { describe, expect, it } from 'vitest';
import {
  candidatesForAnalysis,
  candidatesForTask,
  defaultOptimizerForTask,
} from '../../src/rules/base-rules';
import type { TaskAnalysis } from '../../src/types';

describe('base-rules', () => {
  it('SMALL_CODE → SEMBLE', () => {
    expect(candidatesForTask('SMALL_CODE')).toEqual(['SEMBLE']);
    expect(defaultOptimizerForTask('SMALL_CODE')).toBe('SEMBLE');
  });

  it('TERMINAL → RTK, DCP, BASELINE', () => {
    expect(candidatesForTask('TERMINAL')).toEqual(['RTK', 'DCP', 'BASELINE']);
    expect(defaultOptimizerForTask('TERMINAL')).toBe('RTK');
  });

  it('LARGE_CONTEXT → SEMBLE, SERENA, CONTEXT_MODE, REPOMIX, BASELINE', () => {
    expect(candidatesForTask('LARGE_CONTEXT')).toEqual([
      'SEMBLE',
      'SERENA',
      'CONTEXT_MODE',
      'REPOMIX',
      'BASELINE',
    ]);
  });

  it('REPOSITORY_SEARCH → SEMBLE, CONTEXT_MODE, REPOMIX, BASELINE', () => {
    expect(candidatesForTask('REPOSITORY_SEARCH')).toEqual([
      'SEMBLE',
      'CONTEXT_MODE',
      'REPOMIX',
      'BASELINE',
    ]);
    expect(defaultOptimizerForTask('REPOSITORY_SEARCH')).toBe('SEMBLE');
  });

  it('MULTISTEP → DCP, BASELINE', () => {
    expect(candidatesForTask('MULTISTEP')).toEqual(['DCP', 'BASELINE']);
  });

  it('REFACTOR → SERENA, RTK, BASELINE, REPOMIX', () => {
    expect(candidatesForTask('REFACTOR')).toEqual(['SERENA', 'RTK', 'BASELINE', 'REPOMIX']);
    expect(defaultOptimizerForTask('REFACTOR')).toBe('SERENA');
  });

  it('DEBUG → SERENA, CONTEXT_MODE, RTK, BASELINE', () => {
    expect(candidatesForTask('DEBUG')).toEqual(['SERENA', 'CONTEXT_MODE', 'RTK', 'BASELINE']);
    expect(defaultOptimizerForTask('DEBUG')).toBe('SERENA');
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
    expect(candidatesForAnalysis(analysis)).toEqual(['SERENA', 'RTK', 'BASELINE', 'REPOMIX']);
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
    // REFACTOR: [SERENA, RTK, BASELINE, REPOMIX] + LARGE_CONTEXT: [SEMBLE, SERENA, CONTEXT_MODE, REPOMIX, BASELINE]
    expect(candidatesForAnalysis(analysis)).toEqual([
      'SERENA',
      'RTK',
      'BASELINE',
      'REPOMIX',
      'SEMBLE',
      'CONTEXT_MODE',
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
    // TERMINAL: [RTK, DCP, BASELINE] + REPOSITORY_SEARCH: [SEMBLE, CONTEXT_MODE, REPOMIX, BASELINE]
    expect(candidatesForAnalysis(analysis)).toEqual([
      'RTK',
      'DCP',
      'BASELINE',
      'SEMBLE',
      'CONTEXT_MODE',
      'REPOMIX',
    ]);
  });

  it('TERMINAL + largeContext promueve DCP por delante de RTK', () => {
    const analysis: TaskAnalysis = {
      taskType: 'TERMINAL',
      largeContext: true,
      manyFiles: false,
      expectedToolCalls: 'medium',
      requiresRepositorySearch: false,
      requiresRefactoring: false,
      requiresMultistep: false,
      hasTerminalCommands: true,
    };
    // Salida de terminal enorme/repetitiva: DCP (poda) antes que RTK (comando).
    expect(candidatesForAnalysis(analysis)[0]).toBe('DCP');
    expect(candidatesForAnalysis(analysis)).toContain('RTK');
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
      'DCP',
      'BASELINE',
      'SEMBLE',
      'SERENA',
      'CONTEXT_MODE',
      'REPOMIX',
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
      'SEMBLE',
      'SERENA',
      'CONTEXT_MODE',
      'REPOMIX',
      'BASELINE',
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
    // SMALL_CODE: [SEMBLE] + MULTISTEP: [DCP, BASELINE]
    expect(candidatesForAnalysis(analysis)).toEqual(['SEMBLE', 'DCP', 'BASELINE']);
  });
});
