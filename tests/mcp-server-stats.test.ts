import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { buildContextFromQuery, buildRecord, createAdaptiveRouter } from '../src/index';

const tmpDir = path.join(__dirname, '.tmp-mcp-stats');
const tmpFile = path.join(tmpDir, 'history.json');
const tmpMetrics = path.join(tmpDir, 'metrics.json');

async function createTestServer(historyPath: string, metricsPath: string) {
  const router = createAdaptiveRouter({ historyPath, enableExploration: false });
  const { McpMetricsStore } = await import('../src/history/mcp-metrics-store');
  const metricsStore = new McpMetricsStore(metricsPath);

  const server = new Server(
    { name: 'test-router', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'route_task',
        description: 'Selecciona optimizador',
        inputSchema: {
          type: 'object',
          properties: {
            model: { type: 'string' },
            query: { type: 'string' },
            fileCount: { type: 'integer' },
            contextSizeBytes: { type: 'integer' },
          },
          required: ['model', 'query'],
        },
      },
      {
        name: 'record_execution',
        description: 'Registra ejecución',
        inputSchema: {
          type: 'object',
          properties: {
            model: { type: 'string' },
            query: { type: 'string' },
            optimizer: { type: 'string' },
            tokens: { type: 'integer' },
            latencySeconds: { type: 'number' },
          },
          required: ['model', 'query', 'optimizer', 'tokens', 'latencySeconds'],
        },
      },
      {
        name: 'get_router_stats',
        description: 'Estadísticas',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!args) throw new Error('Faltan argumentos');

    if (name === 'route_task') {
      const ctx = buildContextFromQuery(args.model as string, args.query as string, {
        fileCount: (args.fileCount as number) ?? 0,
        contextSizeBytes: (args.contextSizeBytes as number) ?? 0,
      });
      const decision = await router.route(ctx);
      metricsStore.record({
        timestamp: new Date().toISOString(),
        model: ctx.model,
        modelFamily: ctx.model,
        taskType: decision.taskType,
        optimizer: decision.optimizer,
        version: decision.version,
        confidence: decision.confidence,
      });
      return { content: [{ type: 'text', text: JSON.stringify(decision) }] };
    }

    if (name === 'record_execution') {
      const ctx = buildContextFromQuery(args.model as string, args.query as string, {
        fileCount: (args.fileCount as number) ?? 0,
        contextSizeBytes: (args.contextSizeBytes as number) ?? 0,
      });
      const record = buildRecord(ctx, args.optimizer as import('../src/types').Optimizer, {
        tokens: args.tokens as number,
        latencySeconds: args.latencySeconds as number,
        toolingCost: (args.toolingCost as number) ?? 0,
        quality: (args.quality as number) ?? 1,
        failed: (args.failed as boolean) ?? false,
      });
      await router.recordExecution(record);
      metricsStore.record({
        timestamp: new Date().toISOString(),
        model: ctx.model,
        modelFamily: ctx.model,
        taskType: record.taskType,
        optimizer: args.optimizer as string,
        version: 'EXECUTION',
        confidence: 1,
        tokens: args.tokens as number,
        latencySeconds: args.latencySeconds as number,
        quality: (args.quality as number) ?? 1,
        failed: (args.failed as boolean) ?? false,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ recorded: true, id: record.id }) }],
      };
    }

    if (name === 'get_router_stats') {
      const summary = metricsStore.summary();
      return { content: [{ type: 'text', text: JSON.stringify({ summary }) }] };
    }

    throw new Error('Tool desconocida');
  });

  return server;
}

describe('mcp-server stats', () => {
  it('get_router_stats devuelve resumen de uso', async () => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });

    const server = await createTestServer(tmpFile, tmpMetrics);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    await client.callTool({
      name: 'route_task',
      arguments: {
        model: 'glm-5.2',
        query: 'refactoriza auth',
        fileCount: 12,
        contextSizeBytes: 250000,
      },
    });

    await client.callTool({
      name: 'record_execution',
      arguments: {
        model: 'glm-5.2',
        query: 'refactoriza auth',
        optimizer: 'RTK',
        tokens: 9000,
        latencySeconds: 80,
        quality: 0.98,
        failed: false,
      },
    });

    const result = await client.callTool({ name: 'get_router_stats', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const text = content[0]?.text ?? '';
    const parsed = JSON.parse(text);

    expect(parsed.summary.totalDecisions).toBeGreaterThanOrEqual(1);
    expect(parsed.summary.totalExecutions).toBe(1);
    expect(parsed.summary.byModelFamily['glm-5.2']).toBe(2);

    await client.close();
  });
});
