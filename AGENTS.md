# AGENTS.md — Router Adaptativo de Optimizadores de Contexto

## Propósito

Este proyecto implementa un router que decide qué optimizador de contexto debe usar OpenCode para cada tarea. No presupone que un optimizador sea universalmente mejor; aprende de la evidencia histórica del modelo y del entorno de ejecución.

## Cómo trabajar en este proyecto

- Lenguaje: TypeScript/Node.js.
- Tests: Vitest. Ejecutar con `npm test`.
- Estructura de carpetas:
  - `src/classifier` — clasificación de tareas.
  - `src/rules` — reglas base por tipo de tarea.
  - `src/scorer` — función de coste esperado y reporte de estadísticas (`stats-report.ts`).
  - `src/selector` — selección de optimizador y exploración/explotación.
  - `src/history` — almacenamiento de eventos. Incluye:
    - `history-store.ts` — store legacy v1 (`ExecutionRecord`), se mantiene para que el router adaptativo siga aprendiendo.
    - `mcp-metrics-store.ts` — store legacy v1 de decisiones MCP.
    - `router-event-store.ts` — store unificado v2 (`RouterEvent`) que sustituye a los dos anteriores para reporting.
    - `migrate.ts` — migrador v1 → v2 con detección automática de datos sintéticos.
  - `src/scripts/migrate-history.ts` — script para migrar `history.json` a `events.json`.
  - `src/index.ts` — API pública.
  - `src/cli.ts` — interfaz de línea de comandos (legacy).
  - `src/router-cli.ts` — CLI unificado (v2: solo registra decisiones, no métricas sintéticas).
  - `src/mcp-server.ts` — servidor MCP con `route_task`, `record_execution`, `get_router_stats` (format v2/legacy) y `migrate_history`.
  - `tests/` — tests unitarios e integración.
- Punto de entrada recomendado para entender el sistema: `src/index.ts`.
- Para entender el reporting: `src/scorer/stats-report.ts`.

## Decisiones arquitectónicas importantes

1. **No hay tabla gigante `modelo × tarea × optimizador`.**
   El modelo es una variable de ajuste, no una regla específica.
2. **Reglas generales por tipo de tarea.**
   Por ejemplo: `MULTISTEP → evaluar DCP`.
3. **Fallback seguro a `BASELINE`.**
   Cuando no hay evidencia suficiente, el router nunca apuesta a ciegas.
4. **Coste esperado, no solo tokens.**
   Incluye tokens, latencia, coste de tooling, fallos y calidad.
5. **Aprendizaje progresivo.**
   Los modelos nuevos se adaptan automáticamente recogiendo resultados reales.
6. **Exploración controlada (V3).**
   Ocasionalmente se prueba una alternativa para acumular evidencia, nunca sin control.
7. **Descubrimiento dinámico de modelos.**
   Los modelos se descubren desde la API de KLIA (`/v1/models`) usando `KLIA_API_KEY`. No hay modelos hardcodeados.
8. **Herencia por familia.**
   Cuando un modelo no tiene historial propio, el router usa los datos de su familia con confianza reducida.
9. **Esquema unificado de eventos (v2).**
   `RouterEvent` (un único store, `router-event-store.ts`) sustituye a `ExecutionRecord` + `McpUsageMetric` para reporting. Los stores legacy se mantienen para que el router adaptativo siga aprendiendo sin cambios. Migración v1→v2 con `migrate.ts` y detección automática de datos sintéticos.
10. **Separación de datos sintéticos y reales.**
    `RouterEvent.synthetic` y `RouterEvent.source` permiten distinguir datos de benchmark/CLI de métricas reales. `get_router_stats` con `excludeSynthetic=true` filtra los sintéticos.
11. **Reporting enriquecido (v2).**
    `get_router_stats` (format=v2) devuelve 4 bloques: `summary`, `byModel`, `byModelTask` (con celdas ricas: tokens absolutos, input/output, latencia, calidad, % ahorro, veredicto, ganador) y `globalSavings` (ahorro ponderado + veredicto literal). format=legacy mantiene el `{relativeCost, sampleCount}` anterior.

## Cómo extender

- Para añadir un nuevo optimizador:
  1. Añadirlo a `Optimizer` en `src/types.ts`.
  2. Incluirlo en `BASE_RULES` en `src/rules/base-rules.ts` para las tareas relevantes.
  3. Asegurar que el scoring y el histórico lo soporten (generalmente automático).
- Para añadir un nuevo tipo de tarea:
  1. Añadirlo a `TaskType` en `src/types.ts`.
  2. Actualizar `classifyTask` en `src/classifier/task-classifier.ts`.
  3. Definir candidatos en `src/rules/base-rules.ts`.
  4. Añadir tests.
- Para cambiar la función de coste:
  1. Modificar `computeRecordCost` en `src/scorer/expected-cost-scorer.ts` (v1) o `computeEventCost` en `src/scorer/stats-report.ts` (v2).
  2. Actualizar `DEFAULT_ROUTER_OPTIONS` en `src/types.ts` si se añaden pesos.
  3. Actualizar tests y documentación.
- Para añadir un campo al esquema v2:
  1. Añadirlo a `RouterEvent` (o a `RouterEventExecution` / `RouterEventDecision`) en `src/types.ts`.
  2. Si es en `record_execution`, añadir el parámetro en `RecordExecutionSchema` de `src/mcp-server.ts`.
  3. Si es relevante para reporting, añadirlo a `OptimizerCell` o `ModelRow` en `src/scorer/stats-report.ts`.
  4. Actualizar el migrador `src/history/migrate.ts` si el campo debe existir en datos v1 migrados.

## Convenciones de código

- Nombres descriptivos en inglés para símbolos, comentarios en español.
- Tests junto al código bajo `tests/` reflejando la estructura de `src/`.
- No usar emojis en archivos de código ni documentación.
- Mantener los módulos pequeños y con una única responsabilidad.

## Contacto / contexto

Este router nace de la necesidad de evitar benchmarks exhaustivos por cada modelo nuevo. La arquitectura defiende la idea de que las reglas universales son peligrosas y que la evidencia histórica debe guiar la selección de optimizadores.
