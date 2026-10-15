// OpenCode plugin para registrar automaticamente las ejecuciones de tools
// en el router adaptativo de klia-token-optimizer.
//
// Ubicacion: .opencode/plugin/klia-auto-record.js
// Requiere: reiniciar OpenCode tras colocar el plugin.

const fs = require('fs');
const path = require('path');

function resolveProjectRoot(directory) {
  if (process.env.KLIA_PROJECT_ROOT) {
    return path.resolve(process.env.KLIA_PROJECT_ROOT);
  }
  if (directory) {
    return path.resolve(directory);
  }
  return path.resolve(__dirname, '..', '..');
}

function requireFromProject(projectRoot, ...parts) {
  const fullPath = path.join(projectRoot, ...parts);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`No se encontro el build de klia-token-optimizer en ${fullPath}. Ejecuta 'npm run build'.`);
  }
  return require(fullPath);
}

// Importar el router desde el build compilado del proyecto.
let router, RouterEventStore, createExecutionEvent, McpMetricsStore;
let createAdaptiveRouter, buildContextFromQuery, extractModelFamily, normalizeModel;

function loadProject(projectRoot) {
  const index = requireFromProject(projectRoot, 'dist', 'index.js');
  createAdaptiveRouter = index.createAdaptiveRouter;
  buildContextFromQuery = index.buildContextFromQuery;
  extractModelFamily = index.extractModelFamily;
  normalizeModel = index.normalizeModel;

  const eventModule = requireFromProject(projectRoot, 'dist', 'history', 'router-event-store.js');
  RouterEventStore = eventModule.RouterEventStore;
  createExecutionEvent = eventModule.createExecutionEvent;

  const metricsModule = requireFromProject(projectRoot, 'dist', 'history', 'mcp-metrics-store.js');
  McpMetricsStore = metricsModule.McpMetricsStore;

  router = createAdaptiveRouter({
    historyPath: path.join(projectRoot, 'data', 'history.json'),
    eventsPath: path.join(projectRoot, 'data', 'events.json'),
  });
}

const sessions = new Map();

const SUPPORTED_TOOLS = {
  bash: { hasTerminalCommands: true, toolCallsExpected: 'low' },
  shell_execute: { hasTerminalCommands: true, toolCallsExpected: 'low' },
  read: { toolCallsExpected: 'low' },
  edit: { toolCallsExpected: 'low' },
  write: { toolCallsExpected: 'low' },
  grep: { isRepositorySearch: true, toolCallsExpected: 'medium' },
  glob: { isRepositorySearch: true, toolCallsExpected: 'medium' },
  semble_search: { isRepositorySearch: true, toolCallsExpected: 'medium' },
  semble_find_related: { isRepositorySearch: true, toolCallsExpected: 'medium' },
  repomix_pack_codebase: { toolCallsExpected: 'medium' },
  repomix_pack_remote_repository: { toolCallsExpected: 'medium' },
  ctx_search: { isRepositorySearch: true, toolCallsExpected: 'medium' },
  ctx_fetch_and_index: { toolCallsExpected: 'medium' },
  ctx_index: { toolCallsExpected: 'medium' },
  webfetch: { toolCallsExpected: 'low' },
  task: { isMultistep: true, toolCallsExpected: 'high' },
};

const IGNORED_PREFIXES = ['klia-token-optimizer'];

function isIgnoredTool(toolName) {
  return IGNORED_PREFIXES.some((p) => toolName.startsWith(p));
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function buildQuery(args, toolName) {
  if (args.command) return String(args.command).slice(0, 500);
  if (args.query) return String(args.query).slice(0, 500);
  if (args.pattern) return `buscar ${String(args.pattern).slice(0, 200)}`;
  if (args.url) return `fetch ${String(args.url).slice(0, 200)}`;
  if (args.filePath) return `leer ${String(args.filePath).slice(0, 200)}`;
  return `ejecutar ${toolName}`;
}

function countFiles(args, toolName) {
  if (args.filePaths && Array.isArray(args.filePaths)) return args.filePaths.length;
  if (args.filePath) return 1;
  if (args.path) return 1;
  if (toolName === 'glob' || toolName === 'grep') return 1;
  return 0;
}

function estimateContextSizeBytes(args) {
  const input = JSON.stringify(args);
  return Buffer.byteLength(input, 'utf8');
}

module.exports = async ({ config, directory }) => {
  const projectRoot = resolveProjectRoot(directory);
  loadProject(projectRoot);
  const HISTORY_PATH = path.join(projectRoot, 'data', 'history.json');
  const EVENTS_PATH = path.join(projectRoot, 'data', 'events.json');
  const METRICS_PATH = path.join(projectRoot, 'data', 'mcp-metrics.json');

  return {
    'tool.execute.before': async (input) => {
      const toolName = input.toolName;
      if (!toolName || isIgnoredTool(toolName)) return;
      const hint = SUPPORTED_TOOLS[toolName];
      if (!hint) return;

      const model = normalizeModel(config.model || 'unknown');
      const query = buildQuery(input.args || {}, toolName);
      const fileCount = countFiles(input.args || {}, toolName);
      const contextSizeBytes = estimateContextSizeBytes(input.args || {});

      const ctx = buildContextFromQuery(model, query, {
        fileCount,
        contextSizeBytes,
        ...hint,
      });

      try {
        const decision = await router.route(ctx);
        sessions.set(input.id, {
          sessionId: decision.sessionId,
          startTime: Date.now(),
          model: ctx.model,
          modelFamily: extractModelFamily(ctx.model) ?? '',
          query,
          taskType: decision.taskType,
          optimizer: decision.optimizer,
          signals: ctx.signals,
        });
      } catch (err) {
        // No bloquear la ejecucion original si el router falla.
        // Dejar traza silenciosa para no saturar la salida de OpenCode.
        if (process.env.KLIA_DEBUG) {
          console.error('[klia-auto-record] route error:', err.message);
        }
      }
    },

    'tool.execute.after': async (input, output) => {
      const toolName = input.toolName;
      if (isIgnoredTool(toolName)) return;

      const session = sessions.get(input.id);
      sessions.delete(input.id);

      if (!session) return;

      const latencySeconds = (Date.now() - session.startTime) / 1000;
      const failed = output && output.error ? true : false;
      const outputText =
        typeof output.result === 'string'
          ? output.result
          : JSON.stringify(output.result || {});
      const inputText = JSON.stringify(input.args || {});
      const totalTokens = estimateTokens(inputText) + estimateTokens(outputText);
      const inputTokens = estimateTokens(inputText);
      const outputTokens = estimateTokens(outputText);

      const quality = failed ? 0 : 1;

      try {
        // 1. Registro legacy v1 (para que el router adaptativo aprenda)
        await router.recordExecution({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          timestamp: new Date().toISOString(),
          model: session.model,
          modelFamily: session.modelFamily,
          taskType: session.taskType,
          optimizer: session.optimizer,
          metrics: {
            tokens: totalTokens,
            latencySeconds,
            toolingCost: 0,
            quality,
            failed,
          },
          contextSnapshot: {
            fileCount: session.signals.fileCount,
            contextSizeBytes: session.signals.contextSizeBytes,
            query: session.query,
          },
        });

        // 2. Evento unificado v2
        const eventStore = new RouterEventStore(EVENTS_PATH);
        await eventStore.add(
          createExecutionEvent({
            sessionId: session.sessionId,
            query: session.query,
            model: session.model,
            modelFamily: session.modelFamily,
            taskType: session.taskType,
            signals: {
              fileCount: session.signals.fileCount,
              contextSizeBytes: session.signals.contextSizeBytes,
              toolCallsExpected: session.signals.toolCallsExpected,
            },
            execution: {
              optimizer: session.optimizer,
              inputTokens,
              outputTokens,
              totalTokens,
              latencySeconds,
              costUsd: 0,
              toolingCost: 0,
              quality,
              failed,
            },
            source: 'mcp',
            synthetic: false,
          }),
        );

        // 3. Metricas legacy
        const metricsStore = new McpMetricsStore(METRICS_PATH);
        metricsStore.record({
          timestamp: new Date().toISOString(),
          model: session.model,
          modelFamily: session.modelFamily,
          taskType: session.taskType,
          optimizer: session.optimizer,
          version: 'EXECUTION',
          confidence: 1,
          tokens: totalTokens,
          latencySeconds,
          quality,
          failed,
        });
      } catch (err) {
        if (process.env.KLIA_DEBUG) {
          console.error('[klia-auto-record] record error:', err.message);
        }
      }
    },
  };
};
