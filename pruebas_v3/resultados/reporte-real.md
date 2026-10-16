# Benchmark real de ahorro de tokens

**Modelo:** `glm-5.2` | **Repeticiones:** 2 | **Fecha:** 2026-10-15T16:35:18.661Z

**Metodologia:** baseline minimo suficiente (comando natural / lectura completa / grep); puerta de calidad (la salida del optimizador debe contener la informacion requerida); timeouts excluidos. El ahorro solo cuenta en tareas que pasan la puerta.

## Resumen

- Tareas con ahorro valido: **5/5**
- Tokens baseline (suma de tareas validas): **49.534**
- Tokens optimizados (suma): **15.621**
- **Ahorro medio por tarea: 34.3%** (metrica robusta, recomendada)
- Ahorro ponderado por tokens: 68.5% (depende de la mezcla; una tarea con baseline grande puede dominarlo)

## Detalle

| ID | Tarea | Tipo | Optimizador | Router (frio) | Baseline | Optimizado | Gate | Ahorro |
|:---|:---|:---|:---|:---|---:|---:|:---:|---:|
| S1 | Buscar donde se normalizan los modelos | REPOSITORY_SEARCH | SEMBLE | SEMBLE | 1237 | 610 | OK | 50.7% |
| S2 | Estructura y firmas del modulo de historial | LARGE_CONTEXT | REPOMIX | SEMBLE | 3865 | 2396 | OK | 38% |
| S3 | Resumir los cambios del ultimo commit | TERMINAL | RTK | RTK | 38397 | 6580 | OK | 82.9% |
| S4 | Edicion de codigo pequeno | SMALL_CODE | BASELINE | SEMBLE | 2170 | 2170 | OK | 0% |
| S5 | Refactor del modulo de historial | REFACTOR | BASELINE | RTK | 3865 | 3865 | OK | 0% |

> "N/D" = no cuenta para el ahorro (timeout, optimizador no disponible o gate de calidad no superado).
