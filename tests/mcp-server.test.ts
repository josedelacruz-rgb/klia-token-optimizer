import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildContextFromQuery,
  buildRecord,
  createAdaptiveRouter,
} from '../src/index';

const tmpDir = path.join(__dirname, '.tmp-mcp');
const tmpFile = path.join(tmpDir, 'history.json');

async function createTestServer(historyPath: string) {
  const router = createAdaptiveRouter({ historyPath, enableExploration: false });

  const server = new Server({ name: 'test-router', version: '1.0.0' }, { capabilities: { tools: {} } });

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
      return { content: [{ type: 'text', text: JSON.stringify({ recorded: true, id: record.id }) }] };
    }

    throw new Error('Tool desconocida');
  });

  return server;
}

describe('mcp-server', () => {
  it('route_task devuelve una decisión', async () => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });

    const server = await createTestServer(tmpFile);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const result = await client.callTool({
      name: 'route_task',
      arguments: {
        model: 'glm-5.2',
        query: 'refactoriza auth',
        fileCount: 12,
        contextSizeBytes: 250000,
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    const first = content[0];
    const text = first && typeof first === 'object' && 'text' in first ? (first as { text: string }).text : '';
    const parsed = JSON.parse(text);
    expect(parsed.optimizer).toBe('RTK');
    expect(parsed.taskType).toBe('REFACTOR');

    await client.close();
  });

  it('record_execution guarda y route_task aprende', async () => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });

    const server = await createTestServer(tmpFile);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const ctx = buildContextFromQuery('deepseek-v4', 'planifica migración en 5 pasos', {
      fileCount: 8,
      contextSizeBytes: 200_000,
      isMultistep: true,
    });

    for (let i = 0; i < 5; i++) {
      await client.callTool({
        name: 'record_execution',
        arguments: {
          model: ctx.model,
          query: ctx.signals.query,
          optimizer: 'BASELINE',
          tokens: 10000,
          latencySeconds: 60,
          toolingCost: 0,
          quality: 0.98,
          failed: false,
          fileCount: ctx.signals.fileCount,
          contextSizeBytes: ctx.signals.contextSizeBytes,
        },
      });
      await client.callTool({
        name: 'record_execution',
        arguments: {
          model: ctx.model,
          query: ctx.signals.query,
          optimizer: 'DCP',
          tokens: 13000,
          latencySeconds: 120,
          toolingCost: 0.5,
          quality: 0.98,
          failed: false,
          fileCount: ctx.signals.fileCount,
          contextSizeBytes: ctx.signals.contextSizeBytes,
        },
      });
    }

    const result = await client.callTool({
      name: 'route_task',
      arguments: {
        model: ctx.model,
        query: ctx.signals.query,
        fileCount: ctx.signals.fileCount,
        contextSizeBytes: ctx.signals.contextSizeBytes,
      },
    });

    const resultContent = result.content as Array<{ type: string; text: string }>;
    const resultFirst = resultContent[0];
    const resultText = resultFirst && typeof resultFirst === 'object' && 'text' in resultFirst ? resultFirst.text : '';
    const parsed = JSON.parse(resultText);
    expect(parsed.optimizer).toBe('BASELINE');
    expect(parsed.taskType).toBe('MULTISTEP');

    await client.close();
  });
});
