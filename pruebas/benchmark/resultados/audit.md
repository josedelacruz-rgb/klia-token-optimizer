# Audit — Arquitectura auditada, defectos y riesgos

> Generado por la Fase 0 del plan (inspeccion del codigo existente).
> No se ha modificado la implementacion; este documento describe el estado actual.

## 1. Arquitectura

### 1.1 Componentes principales

| Componente | Archivo | Responsabilidad |
|---|---|---|
| MCP server | `src/mcp-server.ts` | Expone `route_task`, `record_execution`, `get_router_stats`, `migrate_history` via stdio |
| CLI unificado | `src/router-cli.ts` | Modo decision + modo `--record-execution` + `stats` |
| Plugin auto-record | `plugins/klia-auto-record.ts` | Hooks `tool.execute.after` y `session.idle` para OpenCode |
| Clasificador | `src/classifier/task-classifier.ts` | `classifyTask` (6 tipos) y `classifyContextSize` (umbral 1MB / 5MB) |
| Reglas base | `src/rules/base-rules.ts` | `BASE_RULES` por TaskType |
| Selector | `src/selector/optimizer-selector.ts`, `exploration.ts` | V0/V1/V2/V3 con exploracion |
| Scorer | `src/scorer/expected-cost-scorer.ts`, `stats-report.ts` | `computeRecordCost` (v1), `computeEventCost` (v2), `buildStatsReport` |
| Historicos | `src/history/history-store.ts` (v1), `router-event-store.ts` (v2), `mcp-metrics-store.ts` (legacy) | Persistencia en JSON |
| Migracion | `src/history/migrate.ts` | v1 -> v2 con deteccion de sinteticos |
| Pricing | `src/pricing/model-pricing.ts` | Tabla por modelo/familia + `computeCostUsd` |
| Calibracion | `src/scripts/calibrate.ts` | Inyecta registros BASELINE (defecto: sinteticos sin marca) |
| Stats display | `src/scripts/stats-display.ts` | Informe profesional 8 secciones |

### 1.2 Tests existentes

- 14 archivos de tests, 82 tests, todos pasan en ~8.5s.
- Cubren: clasificador, reglas, selector, exploration, scorer (v1 y v2), stores, migracion, MCP server, metricas.
- Tests validos y bien estructurados.

## 2. Que se mide actualmente y como

| Metrica | Origen | Notas |
|---|---|---|
| **Tokens (total)** | `ExecutionRecord.metrics.tokens` o `RouterEventExecution.totalTokens` | Un solo numero. No distingue input/output/cache hasta v2. |
| **Input/Output tokens** | `RouterEventExecution.inputTokens` / `outputTokens` | Solo en esquema v2. El plugin auto-record los lee de `info.tokens` del mensaje. |
| **Cache tokens** | No implementado | El schema v2 no tiene campo. |
| **Reasoning tokens** | No implementado | No existe en el schema. |
| **Calidad** | `RouterEventExecution.quality` | **Defecto: el plugin hardcodea 0.95** (`plugins/klia-auto-record.ts:294`). El schema MCP default es 1.0. |
| **Coste USD** | `computeCostUsd` con tabla `model-pricing.ts` | Estimacion. Separa input/output. USD por 1M tokens. |
| **Latencia** | `RouterEventExecution.latencySeconds` | En auto-record: `max(1, round((lastCompleted - firstCreated) / 1000))`. |
| **Bytes de archivos** | No se mide | El plan lo exige. |
| **Bytes de comandos** | No se mide | El plan lo exige. |
| **Reintentos** | `RouterEventExecution.retries` | Existe en schema, el plugin no lo rellena. |
| **Errores** | `RouterEventExecution.errorMessage`, `failed` | Existe. |
| **Tool calls** | `RouterEventExecution.actualToolCalls` | Existe en schema, el plugin no lo rellena. |
| **Coste del router** | `RouterEventExecution.routerLatencyMs` | Existe, plugin no lo usa. |
| **Contexto antes/despues** | `contextSizeBytes`, `contextSizeBytesAfter`, `tokensPruned` | Existen en schema, no se usan. |

## 3. Defectos de instrumentacion detectados

| # | Defecto | Impacto | Severidad |
|---|---|---|---|
| **D1** | Plugin auto-record hardcodea `--quality 0.95` (`plugins/klia-auto-record.ts:294`) | Calidad registrada nunca es medicion real. Sesga `computeEventCost` y la confianza. | **CRITICO** |
| **D2** | `calibrate.ts` inyecta tokens/latencia/calidad **sinteticos** sin marca `synthetic: true` | Contamina historico "real" con datos inventados. El router aprende de ellos. | **ALTO** |
| **D3** | El CLI `--record-execution` no deduplica por `sessionId` | Llamadas duplicadas duplican registros. Solo el plugin deduplica. | **ALTO** |
| **D4** | `RouterEventStore.add()` no escribe de forma atomica (read->push->write sin rename) | Si el proceso muere entre read y write, se pierden datos. | **ALTO** |
| **D5** | `JsonHistoryStore.read()` no tiene try/catch en `JSON.parse` | JSON corrupto explota sin recuperacion. | MEDIO |
| **D6** | El lock de `RouterEventStore` y `JsonHistoryStore` es por-proceso (Promise chain) | No protege contra concurrencia entre procesos distintos. | MEDIO |
| **D7** | `savingsUsd` en `stats-report.ts:276` usa `(input+output)/2` como precio medio | Aproximacion, no calcula input/output por separado para el ahorro. | BAJO |
| **D8** | El calculo de tokens de BASELINE en `pruebas/run-all.ts` usa `bytes/4` | El plan prohibe esto como medicion principal. Solo valido como estimacion auxiliar. | BAJO |
| **D9** | No hay tokenizador real (tiktoken/gpt-tokenizer) para el modelo | Mediciones locales son aproximaciones. | BAJO |
| **D10** | `RouterEventExecution` no tiene campos `cacheTokens` ni `reasoningTokens` | El plan exige medirlos; hay que ampliar el schema. | MEDIO |

## 4. Pruebas existentes: validez

| Prueba | Validez | Comentario |
|---|---|---|
| `tests/scorer/stats-report.test.ts` | VALIDA | Cubre `computeEventCost`, `buildStatsReport`, veredictos, sinteticos. |
| `tests/scorer/expected-cost-scorer.test.ts` | VALIDA | Cubre `computeRecordCost`, `computeRelativeCost`, `buildCostMatrix`. |
| `tests/classifier/task-classifier.test.ts` | VALIDA | Cubre los 6 TaskType. |
| `tests/rules/base-rules.test.ts` | VALIDA | Cubre `BASE_RULES`. |
| `tests/selector/optimizer-selector.test.ts` | VALIDA | Cubre V0/V1/V2. |
| `tests/selector/exploration.test.ts` | VALIDA | Cubre exploracion. |
| `tests/history/router-event-store.test.ts` | VALIDA | Cubre add/list/migrate. |
| `tests/history/migrate-v1-to-v2.test.ts` | VALIDA | Cubre migracion. |
| `tests/mcp-server.test.ts` | VALIDA | Cubre el MCP server. |
| `tests/mcp-server-stats.test.ts` | VALIDA | Cubre `get_router_stats`. |
| `tests/mcp-metrics.test.ts` | VALIDA | Cubre el store legacy. |
| `tests/index.test.ts` | VALIDA | Cubre la API publica. |
| `tests/benchmark-integration.test.ts` | **REVISAR** | Usa `calibrate.ts` que genera sinteticos sin marca (D2). |
| `pruebas/run-all.ts` (anterior) | **PARCIAL** | 8 PASS, 2 HALLAZGO. Tabla con `bytes/4` (D8). No mide calidad real (D1). |

## 5. Riesgos y prioridades

### 5.1 Riesgos criticos

1. **D1 (calidad hardcodeada)**: el router aprende con senal de calidad falsa. Cualquier decision V2 basada en `quality` esta sesgada. **Prioridad: corregir antes de cualquier adopcion**.

2. **D2 (calibrate sin marca)**: el script oficial de calibracion envenena el historico. **Prioridad: corregir**.

3. **Tabla anterior del 88,9%**: el agregado incluye MULTISTEP como si tuviera resultado, cuando en realidad es N/A. El denominador real es 4 o 5 tareas, no 6. **Prioridad: recalcular y documentar**.

### 5.2 Riesgos medios

4. **D4, D5, D6**: integridad del historico. Un crash a mitad de escritura puede perder datos. **Prioridad: hardening (write atomico, try/catch, file lock entre procesos)**.

5. **D10**: sin cache/reasoning tokens, no se puede medir ahorro real cuando el proveedor los factura diferente.

### 5.3 Recomendaciones

- Antes de presentar un % de ahorro al jefe:
  1. Corregir D1 (plugin quality 0.95).
  2. Corregir D2 (calibrate marca sinteticos).
  3. Ejecutar la suite completa con sesiones reales de OpenCode, 10+ repeticiones, multiples modelos.
  4. Validar calidad con tests del proyecto o evaluador ciego.
  5. No presentar el 88,9% como ahorro global sin recalcular el denominador.
