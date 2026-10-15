# Guía de desarrollo

> Documentación técnica para desarrolladores que contribuyen o extienden el router adaptativo de optimizadores de contexto `klia-token-optimizer`.

---

## Tabla de contenidos

- [Entorno de desarrollo](#entorno-de-desarrollo)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Build y ejecución](#build-y-ejecución)
- [Testing](#testing)
- [Arquitectura interna](#arquitectura-interna)
- [Flujo de decisión](#flujo-de-decisión)
- [Módulos clave](#módulos-clave)
- [Formatos de datos](#formatos-de-datos)
- [Referencia de configuración](#referencia-de-configuración)
- [Depuración](#depuración)
- [Añadir un optimizador](#añadir-un-optimizador)
- [Añadir un tipo de tarea](#añadir-un-tipo-de-tarea)
- [Cambiar la función de coste](#cambiar-la-función-de-coste)
- [Integrados del servidor MCP](#integrados-del-servidor-mcp)
- [Convenciones de código](#convenciones-de-código)
- [Errores comunes](#errores-comunes)

---

## Entorno de desarrollo

### Requisitos previos

- Node.js >= 22.5 (requerido por Context Mode)
- npm
- TypeScript 7 (instalado como dependencia de desarrollo)
- Vitest 5 (instalado como dependencia de desarrollo)
- uv (para Semble y Serena; auto-instalado por el instalador unificado si falta)

### Configuración inicial

```bash
git clone <repo-url>
cd klia-token-optimizer
npm install
```

### Instalador unificado (recomendado para entorno completo)

El instalador unificado `install_klia_token_optimizer.ps1` instala el router mas los 5 optimizadores de contexto (Semble, Context Mode, RTK, Repomix, Serena), el plugin de auto-registro y el system prompt:

```powershell
.\install_klia_token_optimizer.ps1
```

Es idempotente y genera backups `.bak-<fase>-<timestamp>`. Ver [instaladores/install.md](./instaladores/install.md) para detalles completos. Tras ejecutarlo, el proyecto queda compilado en `dist/`, el histórico calibrado y el servidor MCP registrado en `opencode.jsonc`.

### Herramientas necesarias

| Herramienta | Propósito |
| ----------- | --------- |
| `tsc` | Type checking y build (`npm run build`). |
| `tsx` | Ejecutar TypeScript directamente sin compilar (`npm run router`, `npm run route`, `npm run mcp-server`). |
| `vitest` | Runner de tests (`npm test`). |

---

## Estructura del proyecto

```text
klia-token-optimizer/
  src/
    classifier/
      task-classifier.ts   # classifyTask, classifyContextSize, extractSignalsFromQuery
    rules/
      base-rules.ts         # BASE_RULES, candidatesForTask, defaultOptimizerForTask
    scorer/
      expected-cost-scorer.ts  # computeRecordCost, computeRelativeCost, buildCostMatrix, keyFor
      stats-report.ts           # buildStatsReport (summary, byModel, byModelTask, globalSavings), OptimizerCell, ModelRow
    selector/
      optimizer-selector.ts    # selectOptimizer, evaluateOptimizer
      exploration.ts           # selectOptimizerWithExploration (V3)
    history/
      history-store.ts         # HistoryStore interface, JsonHistoryStore, createExecutionRecord (v1)
      router-event-store.ts     # RouterEventStore (v2 unified events), createDecisionEvent, createExecutionEvent
      mcp-metrics-store.ts      # McpMetricsStore (legacy usage telemetry)
      migrate.ts                # migrateV1ToV2, isMigratedToV2 (v1 -> v2 with synthetic detection)
    pricing/
      model-pricing.ts          # computeCostUsd, getPricing, ModelPricing
    utils/
      model-family.ts          # extractModelFamily, normalizeModel, isChatModel
    scripts/
      calibrate.ts             # runCalibration + CLI entry
      migrate-history.ts       # CLI to migrate history.json -> events.json
      stats-display.ts         # runStatsCli: `router stats` professional report (8 ANSI sections)
    klia-discovery.ts          # detectKliaApiKey, discoverModels, discoverModelsFromApi, SNAPSHOT_MODELS
    index.ts                   # Public API: createAdaptiveRouter, buildContextFromQuery, buildRecord + re-exports
    cli.ts                     # `route` CLI (JSON output)
    router-cli.ts              # `router` CLI (decide / record / stats)
    mcp-server.ts              # MCP server (route_task, record_execution, get_router_stats, migrate_history)
    types.ts                   # Shared types + DEFAULT_ROUTER_OPTIONS + RouterEvent (v2)
  tests/                       # Mirror of src/, plus integration tests
  instaladores/                # Installer documentation (install.md, opencode.json)
  install_klia_token_optimizer.ps1  # Unified installer (router + 5 optimizers + auto-record plugin)
  tsconfig.json                # Base config (includes tests)
  tsconfig.build.json          # Build config (src only, declarations)
  package.json
  AGENTS.md
  OPENCODE_USAGE.md
  SYSTEM_PROMPT.md
  router.md
  README.md / README_es.md
  dev.md / dev_es.md
```

### Puntos de entrada recomendados

| Objetivo | Empezar por |
| -------- | ----------- |
| Entender la API pública | `src/index.ts` |
| Entender la clasificación de tareas | `src/classifier/task-classifier.ts` |
| Entender la selección de optimizador | `src/selector/optimizer-selector.ts` + `src/selector/exploration.ts` |
| Entender el scoring de coste | `src/scorer/expected-cost-scorer.ts` |
| Entender el reporte enriquecido v2 | `src/scorer/stats-report.ts` |
| Entender el store de eventos v2 | `src/history/router-event-store.ts` + `src/history/migrate.ts` |
| Entender el pricing en USD | `src/pricing/model-pricing.ts` |
| Entender el descubrimiento de modelos | `src/klia-discovery.ts` |
| Entender el servidor MCP | `src/mcp-server.ts` |
| Entender las CLIs | `src/router-cli.ts` (unificada), `src/cli.ts` (JSON) |

---

## Build y ejecución

### Build

```bash
npm run build
```

Produce `dist/` con `.js` + `.d.ts` solo desde `src/`. Los tests se excluyen mediante `tsconfig.build.json`.

### Watch durante el desarrollo

No hay script de watch dedicado. Usa `tsc --noEmit --watch` en otra terminal para type checking mientras editas, y `npm run test:watch` para tests.

### Ejecutar las CLIs sin compilar

Las CLIs usan `tsx`, así que puedes iterar sin reconstruir:

```bash
npm run router -- --model glm-5.2 --query "refactoriza auth" --files 12 --size 250000
npm run route  -- --model glm-5.2 --query "refactoriza auth" --files 12 --size 200000
npm run router -- stats
```

### Ejecutar el servidor MCP

```bash
npm run mcp-server
```

Escucha en stdio. Los logs van a stderr y al archivo JSON de logs (por defecto `.router-history/mcp-server.log.json`).

### Calibrar desde benchmarks

```bash
npm run calibrate -- --history .router-history/benchmark.json --repetitions 3
```

Este script sobrescribe el archivo de histórico destino. Incluye matrices de benchmark integradas para `glm-5.2`, `deepseek-v4`, `gpt-4o` y `claude-sonnet-4`.

> En Windows CMD usa `^` para continuar líneas. En PowerShell usa `` ` `` o una sola línea.

---

## Testing

### Ejecutar todos los tests

```bash
npm test
```

Vitest corre en modo `--run` (sin watch). Para modo watch:

```bash
npm run test:watch
```

### Estructura de tests

Los tests espejan `src/`:

- `tests/classifier/` - tests de clasificación.
- `tests/rules/` - tests de reglas base.
- `tests/scorer/` - tests de coste esperado.
- `tests/selector/` - tests del selector + exploración.
- `tests/history/` - tests del history store.
- `tests/index.test.ts` - integración de la API pública.
- `tests/benchmark-integration.test.ts` - end-to-end con datos de benchmark.
- `tests/mcp-server.test.ts`, `tests/mcp-server-stats.test.ts`, `tests/mcp-metrics.test.ts` - tests del servidor MCP.

### Cómo escribir tests

- Los globales de Vitest NO están habilitados; importa `describe`, `it`, `expect` desde `vitest`.
- Usa directorios temporales bajo `tests/.tmp-*` para tests basados en archivos. Limpia en `beforeEach`/`afterEach`.
- Para tests de exploración deterministas, inyecta una función `random` personalizada (ver la firma de `selectOptimizerWithExploration`).

---

## Arquitectura interna

### Componentes y responsabilidades

```text
                  OpenCode / CLI / MCP client
                            |
                            v
                  createAdaptiveRouter()
                            |
            +---------------+---------------+
            |               |               |
            v               v               v
   classifyTask()    extractModelFamily()   (classifyContextSize:
            |               |               internal to classifyTask
            +---------------+---------------+   for LARGE_CONTEXT)
                            |
                            v
                   RuleEngine (BASE_RULES)
                   -> candidates for task
                            |
                            v
                   HistoryStore.query()       RouterEventStore.add() (v2)
                   -> records for (model, task)   -> decision/execution events
                            |
                            v
                   ExpectedCostScorer
                   -> buildCostMatrix, computeRelativeCost
                            |
                            v
                   selectOptimizer()
                   -> V0/V1/V2 decision
                            |
                            v
                   selectOptimizerWithExploration() (V3)
                   -> exploration vs exploitation
                            |
                            v
                   RouterDecision
                            |
                            v
                   (pricing: computeCostUsd when costUsd not provided)
                   (stats: buildStatsReport for get_router_stats v2)
```

### Versionado de las decisiones

El campo `version` en `RouterDecision` indica qué estrategia produjo la decisión:

| Versión | Cuándo |
| ------- | ------ |
| `V0` | No hay histórico para `(modelo, tarea)`. Usa la regla base. |
| `V1` | Hay histórico pero la confianza < `minConfidence` o las muestras < `minSamples`. |
| `V2` | Evidencia suficiente; elige el optimizador con menor coste relativo. |
| `V3` | La capa de exploración/explotación intervino (fallback forzado o prueba controlada). |

### Confianza

`confidenceFromSamples(sampleCount, minSamples)`:

- 0 muestras -> 0
- `>= minSamples * 2` -> 1
- en caso contrario -> `sampleCount / minSamples` (limitado a 1)

Es intencionadamente simple. Sustitúyela por un intervalo de confianza o un posterior bayesiano si necesitas garantías más fuertes.

---

## Flujo de decisión

1. **Construcción del contexto** (`buildContextFromQuery`): envuelve `(model, signals)`. Las señales se extraen del texto de la query mediante heurísticas de regex salvo que se proporcionen señales explícitas.
2. **Routing** (`router.route(ctx)`):
   - Clasificar la tarea (`classifyTask`). `classifyContextSize` se usa internamente por `classifyTask` para detectar `LARGE_CONTEXT`; ya no se usa para forzar un optimizador.
   - Si la exploración está habilitada, llamar a `selectOptimizerWithExploration`. Si no, llamar a `selectOptimizer` directamente.
3. **Selección** (`selectOptimizer`):
   - Consultar el histórico para `(model, taskType)`.
   - Si está vacío -> V0, devolver el default de la regla base.
   - En caso contrario, construir la matriz de costes y elegir el candidato con menor coste relativo cuya confianza >= `minConfidence`.
   - Si ninguno cumple el umbral -> V1, devolver baseline.
4. **Exploración** (`selectOptimizerWithExploration`):
   - Si `baseDecision.confidence >= minConfidence`, explotar (devolver la decisión base).
   - Con probabilidad `1 - explorationRate`, hacer fallback al default de la regla base (V3).
   - Con probabilidad `explorationRate`, elegir un candidato no explorado al azar (que no sea `BASELINE` ni probado antes).
5. **Registro** (`router.recordExecution(record)`): añade al histórico JSON. La siguiente llamada a routing para el mismo `(modelo, tarea)` verá la nueva evidencia.
6. **Emisión de eventos v2**: el servidor MCP y `router-cli.ts` emiten además un `RouterEvent` (`decision` para `route_task`, `execution` para `record_execution`) en `events.json` vía `RouterEventStore`. El `history.json` v1 se mantiene en sincronía para que el router adaptativo siga aprendiendo.

---

## Módulos clave

### `src/classifier/task-classifier.ts`

- `classifyTask(signals, opts?)` - devuelve un `TaskType`.
- `classifyContextSize(signals, opts?)` - devuelve `'LARGE_CONTEXT'` o `null`.
- `extractSignalsFromQuery(query, base?)` - extracción heurística de `hasTerminalCommands`, `isMultistep`, `isRefactor`, `isRepositorySearch` a partir del texto de la query.

Prioridad de clasificación:

1. Señales explícitas (`isRefactor`, `isMultistep`, `hasTerminalCommands`, `isRepositorySearch`).
2. Tamaño de contexto (large / extremo).
3. Número de archivos (`manyFilesThreshold`).
4. Comprobación de small code (`fileCount <= 3`, contexto pequeño, tool calls bajos).
5. Fallback `UNKNOWN`.

Umbrales por defecto:

- `largeContextThresholdBytes`: 1 MB
- `manyFilesThreshold`: 8

### `src/rules/base-rules.ts`

`BASE_RULES` mapea cada `TaskType` a una lista priorizada de optimizadores candidatos. El primer elemento es el default V0. `candidatesForAnalysis(analysis)` combina los candidatos de la tarea principal con los de las señales secundarias (`largeContext`, `manyFiles`, `requiresMultistep`), de modo que las tareas mixtas (por ejemplo REFACTOR + contexto grande) también pueden considerar `SEMBLE`, `REPOMIX` o `CONTEXT_MODE`. Se puede sobrescribir editando este mapa; el scorer y el history store cogen las entradas nuevas automáticamente.

### `src/scorer/expected-cost-scorer.ts`

- `computeRecordCost(record, options)` - absolute cost of one execution.
- `computeRelativeCost(records, optimizer, options)` - relative cost vs the baseline for the same group. `Infinity` if no records; `absoluteCost / avgBaselineCost` otherwise. If no baseline records exist, the optimizer's own average is used as the denominator (so `relativeCost = 1`).
- `buildCostMatrix(records, options?)` - groups records by `model::taskType` and returns `Map<key, Map<Optimizer, CostScore>>`.
- `keyFor(model, taskType)` - returns the grouping key.

### `src/scorer/stats-report.ts`

Builds the enriched v2 report consumed by `get_router_stats` (format=v2) and `router stats`:

- `OptimizerCell` - rich cell per optimizer: `samples`, `avgTokens`, `avgInputTokens`, `avgOutputTokens`, `avgLatency`, `avgQuality`, `failureRate`, `avgAbsoluteCost`, `relativeCost`, `savingsTokens`, `savingsPercent`, `savingsUsd`, `verdict` (`AHORRO` | `PERDIDA` | `NEUTRO`), `winner`.
- `ModelTaskRow` - one row per `(model, task)`: `totalSamples`, `baseline`, `optimizers[]`, `bestOptimizer`.
- `ModelRow` - one row per model: `executions`, `avgTokens`, `avgLatency`, `avgQuality`, `failureRate`, `bestOptimizer`, `savingsVsBaselinePercent`, `savingsVsBaselineTokens`.
- `RouterStatsReport` - top-level: `summary` (`totalDecisions`, `totalExecutions`, `syntheticCount`, `realCount`, `realModels`, ...), `byModel`, `byModelTask`, `globalSavings` (weighted savings + literal verdict).
- `buildStatsReport(events, options?)` - the entry point. `computeEventCost` lives here (v2 equivalent of `computeRecordCost`).

### `src/selector/optimizer-selector.ts`

- `selectOptimizer(model, taskType, deps, options?, forcedDefault?)` - the core V0/V1/V2 selector with family inheritance.
- If the model has no history, it queries `queryByFamily(family, taskType)` and uses those records with reduced confidence (`familyConfidenceWeight`, default 0.5).
- Only considers optimizers that are in `BASE_RULES[taskType]` or are `BASELINE`.
- Returns alternatives sorted by relative cost.
- `evaluateOptimizer(records, optimizer, options?)` - utility for tests.

### `src/selector/exploration.ts`

- `selectOptimizerWithExploration(...)` - V3 wrapper around `selectOptimizer`.
- Returns `ExplorationResult` with `decision`, `explored` (true if exploration was triggered), and `exploitedOptimizer` (what pure exploitation would have chosen).
- Inject a `random` function for deterministic tests.

### `src/klia-discovery.ts`

Dynamic model discovery from the KLIA API.

- `detectKliaApiKey()` - detects the API key in this order:
  1. `KLIA_API_KEY` env var (must start with `key-`)
  2. `OPENAI_API_KEY` env var if it starts with `key-`
  3. `provider.klia.options.apiKey` in `opencode.jsonc` (parsed with JSONC comment stripping)
- `discoverModelsFromApi(apiKey?)` - calls `GET https://api.klia.tech/v1/models` and returns chat models (embeddings, image, moderation filtered out by `isChatModel`).
- `discoverModels(apiKey?)` - wraps `discoverModelsFromApi` with a fallback to `SNAPSHOT_MODELS` if the API fails. Returns `{ models, source: 'api' | 'snapshot', error? }`.
- `SNAPSHOT_MODELS` - static list of 26 KLIA chat models for offline fallback.

### `src/history/history-store.ts` (v1)

- `HistoryStore` interface: `add`, `list`, `query`, `queryByFamily`.
- `JsonHistoryStore` - file-based, with a Promise chain lock to serialize concurrent writes.
- `queryByFamily(family, taskType, optimizer?)` - returns records matching `modelFamily === family` and `taskType`. Used by the selector for family inheritance.
- `createExecutionRecord(...)` - builds an `ExecutionRecord` with an `id` of `${Date.now()}-${random}`.

This is the store the adaptive router reads to make decisions. Kept for compatibility even after v2.

### `src/history/router-event-store.ts` (v2)

- `RouterEventStore` - file-based store for `RouterEvent`. Promise chain lock, like `JsonHistoryStore`.
- `createDecisionEvent(...)` - builds a `type: 'decision'` event from a `RouterDecision`.
- `createExecutionEvent(...)` - builds a `type: 'execution'` event from the `record_execution` payload.
- `migrateFile()` - migrates the underlying file from v1 to v2 in place (used by the `migrate_history` MCP tool).
- On read, if v1 records are detected, they are migrated in memory (lazy migration) via `migrateV1ToV2`.

### `src/history/migrate.ts`

- `migrateExecutionRecord(record, source?, synthetic?)` - single v1 `ExecutionRecord` -> v2 `execution` event.
- `migrateMcpMetric(metric, source?)` - v1 `McpUsageMetric` -> v2 event (`decision` if it has no execution metrics, `execution` otherwise).
- `migrateV1ToV2(records, { source, forceSynthetic? })` - turns a v1 `ExecutionRecord[]` into a v2 `RouterEvent[]`. Marks records as `synthetic=true` when they look like benchmark or CLI placeholder data (heuristics on the query text and metrics).
- `looksSynthetic(record)` - heuristic detector for benchmark/CLI placeholder data.
- `isMigratedToV2(events)` - type guard: returns true if the array is already in v2 schema (`schemaVersion === 2`).

### `src/history/mcp-metrics-store.ts` (legacy)

- `McpMetricsStore` - sync read/write of MCP usage metrics.
- `summary()` - returns aggregates: `totalDecisions`, `totalExecutions`, `byTaskType`, `byOptimizer`, `byModelFamily`, `avgQuality`, `failureRate`.

### `src/pricing/model-pricing.ts`

- `ModelPricing` - `{ inputPerMillion, outputPerMillion }` (USD per 1M tokens).
- `FAMILY_PRICING` - per-family defaults (glm, deepseek, kimi, qwen, mistral, ...).
- `MODEL_PRICING` - per-model overrides (e.g. `glm-5.2`, `deepseek-v4-pro`).
- `FALLBACK_PRICING` - generic fallback when neither model nor family is known.
- `getPricing(model, family?)` - resolves pricing with the priority: exact model -> family -> fallback. A leading `klia/` prefix (added by `normalizeModel`) is stripped before matching exact-model keys, so per-model overrides still apply.
- `computeCostUsd(inputTokens, outputTokens, model, family?)` - USD cost of one execution. Used by `record_execution` when `costUsd` is not provided, and by `buildStatsReport` for `savingsUsd`.

### `src/utils/model-family.ts`

- `extractModelFamily(model)` - lowercases and checks against known families: `glm`, `deepseek`, `kimi`, `qwen`, `mistral`, `nemotron`, `minimax`, `gemma`, `devstral`, `cosmos`, `ami`, `llama`. Falls back to the first alphabetic prefix.
- `normalizeModel(model)` - lowercases and trims the id, and prepends `klia/` for known families without a prefix (e.g. `glm-5.2` -> `klia/glm-5.2`) so history keys stay consistent.
- `isChatModel(id)` - filters out embeddings, image, and moderation models from the KLIA API response.

### `src/scripts/calibrate.ts`

- `runCalibration(...)` - seeds `history.json` with `BASELINE` records for every model discovered from the KLIA API (or the static snapshot). No synthetic cost matrices.
- CLI entry: `npm run calibrate -- --history <path> --repetitions N [--models a,b] [--tasks x,y]`.

### `src/scripts/migrate-history.ts`

- Standalone CLI that migrates `.router-history/history.json` (v1) to `.router-history/events.json` (v2) and also folds in `.router-history/mcp-metrics.json` via `migrateMcpMetric` when present. Prints a summary of synthetic vs. real records. Idempotent.

### `src/scripts/stats-display.ts`

- `runStatsCli(argv)` - the `router stats` command. Prints 8 ANSI sections: header, executive summary (KPI cards), system health, model ranking, model x task heatmap, per-(model,task) detail, global savings + verdict, confidence calibration + recommendations. Flags: `--model`, `--task`, `--real-only`, `--no-color`. The health section reports real models (`summary.realModels`) and the time range from `dateRange`; the optimizer count derives from `ALL_OPTIMIZERS`.

### `src/index.ts` (public API)

Exports:

- `createAdaptiveRouter(config)` - returns `{ route, recordExecution, inferTaskType }`. `AdaptiveRouterOptions` accepts `historyPath`, `routerOptions`, `enableExploration`, `taskClassifierOptions`, `modelFamilyExtractor`, and `random` (injectable RNG for deterministic exploration; defaults to `Math.random`).
- `buildContextFromQuery(model, query, base?)` - builds a `RouterContext` with heuristic signals.
- `buildRecord(ctx, optimizer, metrics, modelFamilyExtractor?)` - builds an `ExecutionRecord` ready to record.
- Re-exports: `classifyTask`, `extractSignalsFromQuery`, `createExecutionRecord`, `JsonHistoryStore`, `selectOptimizerWithExploration`, `extractModelFamily`, `normalizeModel`, `DEFAULT_ROUTER_OPTIONS`, `McpMetricsStore`, `discoverModels`, `discoverModelsFromApi`, `detectKliaApiKey`, `SNAPSHOT_MODELS`, `isChatModel`.
- Re-exported types: `RouterContext`, `RouterDecision`, `RouterOptions`, `TaskSignals`, `DiscoveredModel`, `DiscoveryResult`.

---

## Data Formats

### `ExecutionRecord` (v1)

```jsonc
{
  "id": "1791207861095-5jro5tu",
  "timestamp": "2026-10-05T12:34:56.789Z",
  "model": "glm-5.2",
  "modelFamily": "glm",
  "taskType": "REFACTOR",
  "optimizer": "RTK",
  "metrics": {
    "tokens": 9500,
    "latencySeconds": 88,
    "toolingCost": 0.5,
    "quality": 0.98,
    "failed": false
  },
  "contextSnapshot": {
    "fileCount": 12,
    "contextSizeBytes": 250000,
    "toolCallsExpected": "medium"
  }
}
```

### `RouterEvent` (v2)

A `decision` event:

```jsonc
{
  "id": "evt-...",
  "schemaVersion": 2,
  "timestamp": "2026-10-05T12:34:56.789Z",
  "type": "decision",
  "sessionId": "sess-...",
  "projectId": "C:/Proyectos/...",
  "query": "refactoriza auth",
  "model": "glm-5.2",
  "modelFamily": "glm",
  "taskType": "REFACTOR",
  "signals": { "fileCount": 12, "contextSizeBytes": 250000, "toolCallsExpected": "medium" },
  "decision": {
    "optimizer": "RTK",
    "version": "V2",
    "confidence": 1,
    "reason": "Para glm-5.2/REFACTOR, RTK tiene el menor coste relativo (0.58) con 3 muestras.",
    "alternatives": [
      { "optimizer": "RTK", "relativeCost": 0.58, "sampleCount": 3 },
      { "optimizer": "DCP", "relativeCost": 0.59, "sampleCount": 3 }
    ]
  },
  "source": "mcp",
  "synthetic": false
}
```

An `execution` event (only the `execution` block differs):

```jsonc
{
  "...": "...common fields as above...",
  "type": "execution",
  "execution": {
    "optimizer": "RTK",
    "inputTokens": 8000,
    "outputTokens": 1500,
    "totalTokens": 9500,
    "latencySeconds": 88,
    "costUsd": 0.00625,
    "toolingCost": 0.5,
    "quality": 0.95,
    "failed": false,
    "retries": 0,
    "contextSizeBytesAfter": 120000,
    "tokensPruned": 130000,
    "actualToolCalls": 4,
    "routerLatencyMs": 12,
    "startedAt": "2026-10-05T12:34:50Z",
    "completedAt": "2026-10-05T12:36:18Z"
  },
  "source": "mcp",
  "synthetic": false
}
```

### `RouterDecision`

```jsonc
{
  "optimizer": "RTK",
  "version": "V2",
  "reason": "Para glm-5.2/REFACTOR, RTK tiene el menor coste relativo (0.58) con 3 muestras.",
  "confidence": 1,
  "taskType": "REFACTOR",
  "alternatives": [
    { "optimizer": "RTK", "relativeCost": 0.58, "sampleCount": 3 },
    { "optimizer": "DCP", "relativeCost": 0.59, "sampleCount": 3 },
    { "optimizer": "CONTEXT_MODE", "relativeCost": 0.71, "sampleCount": 3 },
    { "optimizer": "BASELINE", "relativeCost": 1.0, "sampleCount": 3 }
  ]
}
```

### History file (v1, `history.json`)

A JSON array of `ExecutionRecord`. Written atomically per `add()` via a Promise chain lock. The file is created on demand; the parent directory is created with `recursive: true`. This is the file the adaptive router reads to make decisions.

### Events file (v2, `events.json`)

A JSON array of `RouterEvent`. Written by `RouterEventStore` with the same Promise chain lock pattern. This is the source for `get_router_stats` (format=v2) and `router stats`. Migrated lazily from v1 on read.

### MCP metrics file (legacy, `mcp-metrics.json`)

A JSON array of `McpUsageMetric`. Written synchronously on every `record()` call. Used by `get_router_stats` (format=legacy) for the `mcpUsageSummary` field.

---

## Configuration Reference

### `RouterOptions` (in code)

```typescript
{
  minConfidence: 0.65,       // Minimum confidence to use a learned V2 rule
  explorationRate: 0.1,      // V3 exploration probability
  minSamples: 3,             // Minimum samples to trust a rule
  latencyWeight: 1.0,        // Weight of latency in the cost
  toolingCostWeight: 1.0,    // Weight of tooling cost in the cost
  failurePenalty: 5.0,       // Added when failed === true
  qualityPenalty: 3.0,       // Multiplied by (1 - quality)
  familyConfidenceWeight: 0.5, // Confidence reduction for family-inherited data
}
```

### Environment variables (MCP server)

See [README.md - Environment Variables](./README.md#environment-variables). All are parsed with `parseFloat`; invalid values are ignored (fall back to defaults). The full list:

| Variable | Description | Default |
| -------- | ----------- | ------- |
| `ROUTER_HISTORY_PATH` | v1 history file (adaptive router learning) | `./.router-history/history.json` |
| `ROUTER_EVENTS_PATH` | v2 unified events file (reporting) | `./.router-history/events.json` |
| `ROUTER_METRICS_PATH` | Legacy MCP metrics file | `./.router-history/mcp-metrics.json` |
| `ROUTER_LOG_PATH` | MCP server JSON log | `./.router-history/mcp-server.log.json` |
| `ROUTER_MIN_CONFIDENCE` | Minimum confidence for a learned rule | `0.65` |
| `ROUTER_EXPLORATION_RATE` | V3 exploration rate | `0.1` |
| `ROUTER_MIN_SAMPLES` | Minimum samples to trust a rule | `3` |
| `ROUTER_LATENCY_WEIGHT` | Latency weight | `1.0` |
| `ROUTER_TOOLING_COST_WEIGHT` | Tooling cost weight | `1.0` |
| `ROUTER_FAILURE_PENALTY` | Failure penalty | `5.0` |
| `ROUTER_QUALITY_PENALTY` | Lost-quality penalty | `3.0` |

### `tsconfig.json` vs `tsconfig.build.json`

- `tsconfig.json` includes `src/**/*` and `tests/**/*`. Used by Vitest and IDE type checking.
- `tsconfig.build.json` extends the base, sets `rootDir: ./src`, excludes tests, and emits declarations. Used by `npm run build`.

---

## Debugging

### Inspect the v1 history

```bash
node -e "console.table(require('./.router-history/history.json').map(r => ({model: r.model, task: r.taskType, opt: r.optimizer, tokens: r.metrics.tokens, quality: r.metrics.quality})))"
```

### Inspect the v2 events

```bash
node -e "const e=require('./.router-history/events.json'); console.log('events:', e.length); console.table(e.slice(-10).map(x => ({type:x.type, model:x.model, task:x.taskType, opt:(x.decision||x.execution||{}).optimizer, synthetic:x.synthetic})))"
```

### Inspect MCP metrics

```bash
node -e "const m = require('./.router-history/mcp-metrics.json'); console.log('decisions:', m.length); console.table(m.slice(-10))"
```

### Inspect the cost matrix

Use the `get_router_stats` MCP tool (format=legacy), or:

```typescript
import { JsonHistoryStore, buildCostMatrix, DEFAULT_ROUTER_OPTIONS } from 'klia-token-optimizer';

const store = new JsonHistoryStore({ filePath: './.router-history/history.json' });
const records = await store.list();
const matrix = buildCostMatrix(records, DEFAULT_ROUTER_OPTIONS);
for (const [key, scores] of matrix) {
  console.log(key);
  for (const [opt, score] of scores) {
    console.log('  ', opt, score);
  }
}
```

### Inspect the enriched v2 report

```bash
npm run router -- stats --model glm-5.2 --real-only
```

Or call `get_router_stats` with `format=v2` from the MCP server.

### MCP server logs

The MCP server writes NDJSON logs to `ROUTER_LOG_PATH` (default `.router-history/mcp-server.log.json`): one JSON object per line, appended atomically. Each entry has `timestamp`, `level`, `message`, and `meta`. Levels: `debug`, `info`, `error`. Request arguments are not logged.

### Common issues

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| Decision is always `V0` | History is empty for `(model, task)` | Record executions or run `npm run calibrate`. |
| Decision is always `V1` | `minSamples` or `minConfidence` not met | Lower thresholds or record more samples. |
| `SEMBLE` is never selected | Not in `BASE_RULES` for the task, or insufficient evidence / samples | Check `BASE_RULES` and record more executions. |
| MCP tools not visible | Server not started or `opencode.jsonc` not loaded | Run `npm run mcp-server` and check `opencode.jsonc`. |
| `get_router_stats` v2 report is empty | `events.json` is empty or all events are synthetic | Call `migrate_history` or record real executions; pass `excludeSynthetic=false` to see synthetic data. |
| History file grows unbounded | No eviction policy | Prune old records or move to SQLite (see roadmap in `router.md`). |

---

## Adding an Optimizer

1. Add the optimizer to `Optimizer` in `src/types.ts`.
2. Add it to `BASE_RULES` in `src/rules/base-rules.ts` for the relevant task types. Order matters: the first entry is the V0 default.
3. Update the MCP server's `RecordExecutionSchema` enum in `src/mcp-server.ts` to allow the new optimizer in `record_execution`.
4. Update the `get_router_stats` tool description in `src/mcp-server.ts` if needed.
5. Add tests:
   - Selector picks it when it has the lowest relative cost.
   - Explorer can pick it when unexplored.
   - `record_execution` accepts it.
6. Update `README.md`, `README_es.md`, `dev.md`, and `dev_es.md`.

The scorer and history store need no changes; they work generically with any `Optimizer` value. The v2 event store also picks up new optimizers automatically.

---

## Adding a Task Type

1. Add the task type to `TaskType` in `src/types.ts`.
2. Update `classifyTask` in `src/classifier/task-classifier.ts`. Add the heuristic signals if applicable.
3. Add an entry to `BASE_RULES` in `src/rules/base-rules.ts`.
4. Update the `get_router_stats` tool's `taskType` enum in `src/mcp-server.ts` (`GetStatsSchema`).
5. Update `RouteTaskSchema` if you add new task-specific signals.
6. Add tests for classification, selection, and exploration.
7. Update the docs.

---

## Changing the Cost Function

The v1 cost function lives in `computeRecordCost` in `src/scorer/expected-cost-scorer.ts`:

```typescript
let cost = metrics.tokens;
cost += metrics.latencySeconds * options.latencyWeight;
cost += metrics.toolingCost * options.toolingCostWeight;
if (metrics.failed) cost += options.failurePenalty;
cost += options.qualityPenalty * (1 - metrics.quality);
```

The v2 equivalent is `computeEventCost` in `src/scorer/stats-report.ts` (operates on `RouterEvent` execution events). Keep both in sync if you change one.

To change it:

1. Edit `computeRecordCost` (and `computeEventCost` if you want the v2 report to match).
2. If you add a new weight, add it to `RouterOptions` and `DEFAULT_ROUTER_OPTIONS` in `src/types.ts`.
3. Add a corresponding `ROUTER_*` env var in `loadRouterOptionsFromEnv` in `src/mcp-server.ts`.
4. Add tests in `tests/scorer/`.
5. Update the docs.

The relative cost is `avgOptimizerCost / avgBaselineCost` per `(model, task)`. If there is no baseline, the optimizer's own average is used as the denominator, so `relativeCost = 1`. Keep this invariant unless you intentionally want a different normalization.

---

## MCP Server Internals

The MCP server (`src/mcp-server.ts`, server version `2.0.0`) exposes **four** tools via the Model Context Protocol over stdio:

| Tool | Schema | Effect |
| ---- | ------ | ------ |
| `route_task` | `RouteTaskSchema` | Calls `router.route(ctx)`, records a `decision` `RouterEvent`, and records a legacy MCP metric. Returns the decision plus a `sessionId` to pair with `record_execution`. Accepts `sessionId` and `projectId` for pairing. |
| `record_execution` | `RecordExecutionSchema` | Builds a v1 record via `buildRecord` and calls `router.recordExecution`. Also builds an `execution` `RouterEvent` with split `inputTokens`/`outputTokens`, `costUsd` (estimated via `computeCostUsd` if not provided), `retries`, `errorMessage`, `contextSizeBytesAfter`, `tokensPruned`, `actualToolCalls`, `routerLatencyMs`, `startedAt`, `completedAt`, `source`, `synthetic`. |
| `get_router_stats` | optional `model`/`taskType`/`excludeSynthetic`/`format` filters | `format=v2` (default): the enriched report (`summary`, `byModel`, `byModelTask`, `globalSavings`). `format=legacy`: total records, unique models, the relative cost matrix, and the MCP usage summary. |
| `migrate_history` | none | Migrates `events.json` from v1 to v2 in place via `RouterEventStore.migrateFile()`. Returns `{ migrated, migratedCount, eventsPath }`. Idempotent. |

Key behaviors:

- **Path resolution**: relative paths are resolved against the project root (found by walking up to the `klia-token-optimizer` package.json). Absolute paths are used as-is.
- **Exploration**: disabled by default in the MCP server (`enableExploration: false`). Pass `explore: true` in `route_task` to enable V3 for that single call.
- **Session pairing**: `route_task` returns a `sessionId`. Pass the same `sessionId` to `record_execution` to pair the decision with its execution in the v2 events store.
- **Pricing**: when `costUsd` is not provided to `record_execution`, it is estimated via `computeCostUsd(inputTokens, outputTokens, model, family)`.
- **Logging**: NDJSON (one JSON object per line, appended) to `ROUTER_LOG_PATH`. Each tool call logs the tool name and the result or error; request arguments are not logged.
- **Error handling**: parse errors and unknown tool names throw; the logger records the error before re-throwing.

### Installing the MCP server in OpenCode

The unified installer (`install_klia_token_optimizer.ps1`) handles this automatically. For manual setup:

Edit `opencode.jsonc`:

```jsonc
{
  "mcpServers": {
    "klia-token-optimizer": {
      "type": "local",
      "command": ["node", "C:/ProyectosV2/telemetria/klia-token-optimizer/dist/mcp-server.js"],
      "enabled": true,
      "env": {
        "ROUTER_HISTORY_PATH": "C:/ProyectosV2/telemetria/klia-token-optimizer/.router-history/history.json",
        "ROUTER_EVENTS_PATH": "C:/ProyectosV2/telemetria/klia-token-optimizer/.router-history/events.json",
        "ROUTER_METRICS_PATH": "C:/ProyectosV2/telemetria/klia-token-optimizer/.router-history/mcp-metrics.json"
      }
    }
  }
}
```

Run `npm run build` first so `dist/mcp-server.js` exists.

The unified installer also:
:
- Ensures `.opencode/plugin/klia-auto-record.js` plugin (auto-records real metrics after each tool execution).
- Injects the system prompt into `opencode.jsonc`.
- Adjusts `base-rules.ts` if any optimizer failed to install.
- Calibrates the history with baseline records.

---

## Code Conventions

- **Language**: TypeScript with `strict: true`.
- **Module system**: CommonJS (`"type": "commonjs"` in `package.json`).
- **Naming**: descriptive English for symbols, Spanish for comments.
- **No emojis** in code or documentation.
- **Single responsibility**: keep modules small.
- **Tests mirror src**: `tests/scorer/` for `src/scorer/`, etc.
- **Imports**: relative imports within `src/`; type imports use `import type` where possible.
- **No global Vitest globals**: import `describe`, `it`, `expect` from `vitest`.
- **v1 and v2 stay in sync**: when you change the v1 cost function, update the v2 equivalent (`computeEventCost`) so the enriched report matches the adaptive router's decisions.

---

## Common Pitfalls

### Forgetting to record real metrics

The router only learns when `recordExecution` is called. If you only ever call `route_task`, decisions stay at V0/V1 forever. The CLIs and MCP server are designed to make recording easy; use them. The `klia-auto-record` plugin closes the loop automatically.

### Editing `tsconfig.json` instead of `tsconfig.build.json`

`tsconfig.json` includes tests and is used by Vitest and the IDE. `tsconfig.build.json` is what produces `dist/`. Editing the wrong file will either ship tests in the build or break type checking in the editor.

### Concurrent writes to the history file

`JsonHistoryStore` and `RouterEventStore` serialize writes with a Promise chain lock, but only within a single process. If you run multiple MCP server instances pointing at the same file, you will get data loss. Run a single server per history file.

### Relative cost without a baseline

If no `BASELINE` records exist for a `(model, task)`, `computeRelativeCost` uses the optimizer's own average as the denominator, so `relativeCost = 1`. This means the matrix will show `1.0` for every optimizer, and the selector will fall back to the V0 rule. Record at least one baseline execution per `(model, task)` to get meaningful relative costs.

### Forgetting to update the MCP enum

When you add an optimizer, you must update `RecordExecutionSchema`'s `optimizer` enum in `src/mcp-server.ts`. Otherwise `record_execution` will reject records for the new optimizer with a Zod validation error.

### Mixing v1 and v2 costs

`computeRecordCost` (v1) and `computeEventCost` (v2) must stay aligned. If you change the v1 cost function and forget the v2 one, the enriched report (`get_router_stats` format=v2 and `router stats`) will diverge from the decisions the adaptive router actually makes.

### `forceConsistentCasingInFileNames`

This is enabled in `tsconfig.json`. On case-insensitive filesystems (Windows, macOS default), inconsistent casing will compile but fail on Linux CI. Be consistent.

---

## Cambios recientes

### 2026-10 - correcciones de robustez y reporting

- **BASE_RULES restauradas** con las listas de candidatos completas (`TERMINAL` incluye `DCP`; `LARGE_CONTEXT` y `REPOSITORY_SEARCH` incluyen `CONTEXT_MODE`/`REPOMIX`). Esto permite que el router elija `REPOMIX`/`SEMBLE` en lugar de caer siempre en `BASELINE`; el ahorro global del benchmark v3 pasó del 27,9% al 68,3%.
- **Exploración determinista**: `AdaptiveRouterOptions.random` se inyecta en `route()` (por defecto `Math.random`), de modo que los tests ya no dependen del azar.
- **Pricing**: `getPricing` elimina el prefijo `klia/` añadido por `normalizeModel`, por lo que se aplican los precios por modelo exacto.
- **Informe de estadísticas**: se añade `summary.realModels`; la sección de salud de `router stats` muestra los modelos reales y el rango temporal real en lugar de valores de relleno.
- **Migración**: `migrate-history` incorpora también `mcp-metrics.json` mediante `migrateMcpMetric`.
- **Logger MCP**: pasa a NDJSON con append (atómico, sin read-modify-write) y ya no registra los argumentos de la petición.
- **Tipos**: `ALL_OPTIMIZERS` se exporta desde `src/types.ts` como lista canónica de optimizadores.
- **Repositorio**: se añaden `LICENSE` (ISC), CI con GitHub Actions (`.github/workflows/ci.yml`) y se versiona el plugin de auto-registro `.opencode/plugin`.

### 2026-10 - pasada de mantenibilidad (14 secciones)

- **types**: los tipos v1 se mueven a `src/types.legacy.ts` y se reexportan desde `src/types.ts`.
- **classifier**: se elimina el valor muerto `LARGE_CONTEXT_EXTREME` y `extremeContextThresholdBytes`.
- **rules**: `BASE_RULES` y sus listas se congelan en runtime.
- **selector/index**: se elimina el fallback V0 duplicado en `route()`; se simplifica `selectFromRecords`.
- **scorer**: se quitan condicionales `Infinity` redundantes.
- **history**: helper compartido `ensureJsonFile` en `src/utils/json.ts` (usado por los tres stores).
- **pricing**: `family` se normaliza (trim + minusculas) antes de la busqueda.
- **utils**: unica fuente de verdad `KNOWN_FAMILIES` en `model-family.ts`.
- **klia-discovery**: timeout de 10s en la llamada a la API de KLIA; rutas de config deduplicadas.
- **mcp-server**: logger extraido a `src/mcp/logger.ts`.
- **cli**: `router-cli` valida `--optimizer` contra `ALL_OPTIMIZERS`; `cli.ts` marcado como legacy.
- **scripts**: formateadores puros extraidos a `src/scripts/format.ts`.
- **index**: `buildRecord` acepta `taskClassifierOptions`.
- **package.json**: se añaden `types`, `files`, `repository`, `homepage`, `bugs` y `author`.

### 2026-10 - endurecimiento y tooling

- **mcp-server**: los schemas y la definicion de tools se mueven a `src/mcp/tools.ts`.
- **stats-display**: los helpers ANSI se mueven a `src/scripts/ansi.ts` (estado `colorEnabled` centralizado).
- **cli**: `cli.ts` ahora delega en `router-cli.ts`; `router-cli` valida `--optimizer`.
- **file-lock**: el `staleMs` por defecto sube a 30s para no robar el lock de un escritor lento.
- **migrate**: `looksSynthetic` refactorizado con un helper nombrado para la formula del CLI.
- **Tooling**: Prettier añadido (`npm run format` / `npm run format:check`) y aplicado en CI. ESLint queda pendiente: `typescript-eslint` entra en conflicto con el peer de TypeScript 7.
