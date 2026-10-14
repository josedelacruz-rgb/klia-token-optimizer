import { describe, expect, it } from 'vitest';
import { candidatesForTask, defaultOptimizerForTask } from '../../src/rules/base-rules';

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
