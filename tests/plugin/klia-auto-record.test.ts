import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

async function loadPlugin(projectRoot: string) {
  const pluginPath = path.join(projectRoot, '.opencode', 'plugin', 'klia-auto-record.js');
  const plugin = require(pluginPath);
  return plugin({ config: { model: 'klia/GLM-5.2' }, directory: projectRoot });
}

describe('klia-auto-record plugin', () => {
  it('registra una ejecucion de bash como TERMINAL', async () => {
    const projectRoot = process.cwd();
    // Limpiar stores antes de la prueba
    fs.writeFileSync(path.join(projectRoot, 'data', 'events.json'), '[]', 'utf-8');
    fs.writeFileSync(path.join(projectRoot, 'data', 'history.json'), '[]', 'utf-8');

    const hooks = await loadPlugin(projectRoot);
    const id = 'test-bash-1';

    await hooks['tool.execute.before']({ id, toolName: 'bash', args: { command: 'npm test' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await hooks['tool.execute.after'](
      { id, toolName: 'bash', args: { command: 'npm test' } },
      { result: '2 tests passed' },
    );

    const events = JSON.parse(fs.readFileSync(path.join(projectRoot, 'data', 'events.json'), 'utf-8'));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('execution');
    expect(events[0].taskType).toBe('TERMINAL');
    expect(['BASELINE', 'RTK', 'DCP']).toContain(events[0].execution.optimizer);
    expect(events[0].execution.failed).toBe(false);
    expect(events[0].execution.totalTokens).toBeGreaterThan(0);
  });

  it('ignora las tool calls propias de klia-token-optimizer', async () => {
    const projectRoot = process.cwd();
    fs.writeFileSync(path.join(projectRoot, 'data', 'events.json'), '[]', 'utf-8');
    fs.writeFileSync(path.join(projectRoot, 'data', 'history.json'), '[]', 'utf-8');

    const hooks = await loadPlugin(projectRoot);
    const id = 'test-klia-1';

    await hooks['tool.execute.before']({
      id,
      toolName: 'klia-token-optimizer_route_task',
      args: { query: 'foo' },
    });
    await hooks['tool.execute.after'](
      { id, toolName: 'klia-token-optimizer_route_task', args: { query: 'foo' } },
      { result: { optimizer: 'BASELINE' } },
    );

    const events = JSON.parse(fs.readFileSync(path.join(projectRoot, 'data', 'events.json'), 'utf-8'));
    expect(events).toHaveLength(0);
  });

  it('registra fallos con calidad 0', async () => {
    const projectRoot = process.cwd();
    fs.writeFileSync(path.join(projectRoot, 'data', 'events.json'), '[]', 'utf-8');
    fs.writeFileSync(path.join(projectRoot, 'data', 'history.json'), '[]', 'utf-8');

    const hooks = await loadPlugin(projectRoot);
    const id = 'test-fail-1';

    await hooks['tool.execute.before']({ id, toolName: 'read', args: { filePath: 'missing.ts' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await hooks['tool.execute.after'](
      { id, toolName: 'read', args: { filePath: 'missing.ts' } },
      { error: { message: 'file not found' } },
    );

    const events = JSON.parse(fs.readFileSync(path.join(projectRoot, 'data', 'events.json'), 'utf-8'));
    expect(events).toHaveLength(1);
    expect(events[0].execution.failed).toBe(true);
    expect(events[0].execution.quality).toBe(0);
  });
});
