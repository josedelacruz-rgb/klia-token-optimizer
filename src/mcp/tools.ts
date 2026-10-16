import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const RouteTaskSchema = z.object({
  model: z.string().describe('Modelo o familia de LLM, por ejemplo glm-5.2'),
  query: z.string().describe('Descripción de la tarea'),
  fileCount: z.number().int().min(0).default(0).describe('Número de archivos implicados'),
  contextSizeBytes: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Tamaño total del contexto en bytes'),
  toolCallsExpected: z.enum(['low', 'medium', 'high']).optional(),
  hasTerminalCommands: z.boolean().optional(),
  isRefactor: z.boolean().optional(),
  isRepositorySearch: z.boolean().optional(),
  isMultistep: z.boolean().optional(),
  explore: z.boolean().default(false).describe('Si es true, permite exploración controlada'),
  sessionId: z
    .string()
    .optional()
    .describe('Identificador de sesión para emparejar decision+execution'),
  projectId: z.string().optional().describe('Identificador del proyecto/repo'),
});

export const RecordExecutionSchema = z.object({
  model: z.string(),
  query: z.string(),
  optimizer: z.enum(['BASELINE', 'DCP', 'RTK', 'CONTEXT_MODE', 'REPOMIX', 'SEMBLE', 'SERENA']),
  tokens: z
    .number()
    .int()
    .min(0)
    .describe('Tokens totales consumidos (usar inputTokens+outputTokens si se conoce el desglose)'),
  inputTokens: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Tokens de entrada (prompt). Si se omite, se asume 0.'),
  outputTokens: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Tokens de salida (completion). Si se omite, se asume 0.'),
  latencySeconds: z.number().min(0),
  toolingCost: z.number().min(0).default(0),
  costUsd: z.number().min(0).optional().describe('Coste real en USD de la ejecución'),
  quality: z.number().min(0).max(1).default(1),
  failed: z.boolean().default(false),
  retries: z.number().int().min(0).optional().describe('Número de reintentos'),
  errorMessage: z.string().optional().describe('Mensaje de error si failed=true'),
  fileCount: z.number().int().min(0).default(0),
  contextSizeBytes: z.number().int().min(0).default(0),
  contextSizeBytesAfter: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Tamaño del contexto DESPUÉS de aplicar el optimizador (bytes)'),
  tokensPruned: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Tokens eliminados por el optimizador (poda, compresión, etc.)'),
  actualToolCalls: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Número real de tool calls ejecutados'),
  routerLatencyMs: z
    .number()
    .min(0)
    .optional()
    .describe('Latencia del propio router al decidir (ms)'),
  startedAt: z.string().optional().describe('Timestamp ISO de inicio de la ejecución'),
  completedAt: z.string().optional().describe('Timestamp ISO de finalización de la ejecución'),
  sessionId: z
    .string()
    .optional()
    .describe('Debe coincidir con el sessionId de route_task para emparejar'),
  projectId: z.string().optional(),
  source: z.enum(['mcp', 'cli', 'benchmark', 'manual']).default('mcp'),
  synthetic: z
    .boolean()
    .default(false)
    .describe('Marcar true si los datos son sintéticos (benchmark, simulación)'),
});

export const GetStatsSchema = z.object({
  model: z.string().optional().describe('Filtrar por modelo exacto'),
  taskType: z
    .enum(['SMALL_CODE', 'TERMINAL', 'LARGE_CONTEXT', 'REPOSITORY_SEARCH', 'MULTISTEP', 'REFACTOR', 'DEBUG'])
    .optional()
    .describe('Filtrar por tipo de tarea'),
  excludeSynthetic: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Si true (default), excluye datos sintéticos del reporte. Pasar false para incluir benchmark/simulación.',
    ),
  format: z
    .enum(['v2', 'legacy'])
    .optional()
    .default('v2')
    .describe('v2 = reporte enriquecido, legacy = costMatrix antiguo'),
});

export const tools: Tool[] = [
  {
    name: 'route_task',
    description:
      'Selecciona el optimizador de contexto más adecuado para una tarea dado un modelo y señales de contexto. Devuelve el optimizador, la confianza, la versión del router y las alternativas consideradas. Devuelve un sessionId para emparejar con record_execution.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Modelo o familia de LLM' },
        query: { type: 'string', description: 'Descripción de la tarea' },
        fileCount: { type: 'integer', default: 0, description: 'Número de archivos implicados' },
        contextSizeBytes: {
          type: 'integer',
          default: 0,
          description: 'Tamaño total del contexto en bytes',
        },
        toolCallsExpected: { type: 'string', enum: ['low', 'medium', 'high'] },
        hasTerminalCommands: { type: 'boolean' },
        isRefactor: { type: 'boolean' },
        isRepositorySearch: { type: 'boolean' },
        isMultistep: { type: 'boolean' },
        explore: {
          type: 'boolean',
          default: false,
          description: 'Permitir exploración controlada',
        },
        sessionId: { type: 'string', description: 'Identificador de sesión' },
        projectId: { type: 'string', description: 'Identificador del proyecto' },
      },
      required: ['model', 'query'],
    },
  },
  {
    name: 'record_execution',
    description:
      'Registra el resultado real de una ejecución para que el router aprenda. Debe llamarse DESPUÉS de ejecutar la tarea con el optimizador elegido. Acepta inputTokens/outputTokens separados, costUsd y retries para reportes precisos.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        query: { type: 'string' },
        optimizer: {
          type: 'string',
          enum: ['BASELINE', 'DCP', 'RTK', 'CONTEXT_MODE', 'REPOMIX', 'SEMBLE', 'SERENA'],
        },
        tokens: { type: 'integer', description: 'Tokens totales consumidos' },
        inputTokens: { type: 'integer', description: 'Tokens de entrada (prompt)' },
        outputTokens: { type: 'integer', description: 'Tokens de salida (completion)' },
        latencySeconds: { type: 'number', description: 'Latencia real en segundos' },
        toolingCost: { type: 'number', default: 0, description: 'Coste estimado del tooling' },
        costUsd: { type: 'number', description: 'Coste real en USD' },
        quality: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 1,
          description: 'Calidad del resultado 0..1',
        },
        failed: { type: 'boolean', default: false, description: 'true si la ejecución falló' },
        retries: { type: 'integer', description: 'Número de reintentos' },
        errorMessage: { type: 'string', description: 'Mensaje de error si failed=true' },
        fileCount: { type: 'integer', default: 0 },
        contextSizeBytes: { type: 'integer', default: 0 },
        sessionId: { type: 'string', description: 'Debe coincidir con el sessionId de route_task' },
        projectId: { type: 'string' },
        source: { type: 'string', enum: ['mcp', 'cli', 'benchmark', 'manual'], default: 'mcp' },
        synthetic: { type: 'boolean', default: false, description: 'true si datos sintéticos' },
      },
      required: ['model', 'query', 'optimizer', 'tokens', 'latencySeconds'],
    },
  },
  {
    name: 'get_router_stats',
    description:
      'Devuelve estadísticas enriquecidas del router: resumen global, desglose por modelo, desglose por (modelo, tarea) con celdas ricas (tokens absolutos, latencia, calidad, % ahorro, veredicto) y ahorro global ponderado. Por defecto usa format=v2 (enriquecido). Usa format=legacy para el costMatrix antiguo.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Filtrar por modelo exacto' },
        taskType: {
          type: 'string',
          enum: [
            'SMALL_CODE',
            'TERMINAL',
            'LARGE_CONTEXT',
            'REPOSITORY_SEARCH',
            'MULTISTEP',
            'REFACTOR',
            'DEBUG',
          ],
          description: 'Filtrar por tipo de tarea',
        },
        excludeSynthetic: {
          type: 'boolean',
          default: true,
          description: 'Excluir datos sintéticos (default: true)',
        },
        format: { type: 'string', enum: ['v2', 'legacy'], default: 'v2' },
      },
    },
  },
  {
    name: 'migrate_history',
    description:
      'Migra el histórico v1 (ExecutionRecord) al esquema v2 (RouterEvent). Marca como synthetic=true los registros que parezcan del benchmark o CLI. Idempotente: si ya está migrado, no hace nada.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];
