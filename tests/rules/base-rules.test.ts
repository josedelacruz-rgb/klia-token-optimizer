import { describe, expect, it } from 'vitest';
import { candidatesForTask, defaultOptimizerForTask } from '../../src/rules/base-rules';

describe('base-rules', () => {
  it('SMALL_CODE → BASELINE', () => {
    expect(candidatesForTask('SMALL_CODE')).toEqual(['BASELINE']);
    expect(defaultOptimizerForTask('SMALL_CODE')).toBe('BASELINE');
  });

  it('TERMINAL → RTK, DCP', () => {
    expect(candidatesForTask('TERMINAL')).toEqual(['RTK', 'DCP']);
    expect(defaultOptimizerForTask('TERMINAL')).toBe('RTK');
  });

  it('LARGE_CONTEXT → SEMBLE, CONTEXT_MODE, REPOMIX', () => {
    expect(candidatesForTask('LARGE_CONTEXT')).toEqual(['SEMBLE', 'CONTEXT_MODE', 'REPOMIX']);
  });

  it('MULTISTEP → DCP', () => {
    expect(candidatesForTask('MULTISTEP')).toEqual(['DCP']);
  });

  it('REFACTOR → RTK', () => {
    expect(candidatesForTask('REFACTOR')).toEqual(['RTK']);
  });

  it('UNKNOWN cae a BASELINE', () => {
    expect(candidatesForTask('UNKNOWN')).toEqual(['BASELINE']);
    expect(defaultOptimizerForTask('UNKNOWN')).toBe('BASELINE');
  });
});
