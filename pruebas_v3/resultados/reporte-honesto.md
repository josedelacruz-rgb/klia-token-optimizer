# Benchmark honesto: ahorro real de tokens

**Modelo:** `glm-5.2` | **Repeticiones:** 3 | **Fecha:** 2026-10-15T16:34:35.223Z

**Metodologia:** sin siembra de historial sintetico (el router decide en frio); baseline natural por tarea (comando completo / lectura completa / grep); los timeouts se reportan y se excluyen del ahorro.

## Resumen global

- Tareas medibles: **6/6**
- Tokens baseline (suma): **35.883**
- Tokens con optimizador (suma): **3319**
- **Ahorro global (solo tareas medibles): 90.8%**

## Detalle por tarea

| ID | Tarea | Tipo | Optimizador | Baseline | Optimizado | Ahorro | Nota |
|:---|:---|:---|:---|---:|---:|---:|:---|
| T1 | Inspeccion terminal (tsc --listFiles) | TERMINAL | RTK | 11096 | 485 | 95.6% | - |
| T2 | Explicar el sistema de scoring (lectura completa) | LARGE_CONTEXT | SEMBLE | 16267 | 553 | 96.6% | - |
| T3 | Estructura del historial y persistencia (lectura completa) | LARGE_CONTEXT | SEMBLE | 4532 | 577 | 87.3% | - |
| T4 | Buscar normalizacion de modelos (grep) | REPOSITORY_SEARCH | SEMBLE | 1362 | 612 | 55.1% | - |
| T5 | Edicion puntual de codigo pequeno | SMALL_CODE | SEMBLE | 2170 | 636 | 70.7% | - |
| T6 | Refactor con verificacion tsc (comando) | REFACTOR | RTK | 456 | 456 | 0% | - |

> Los valores "N/D" no entran en el ahorro global (timeout o herramienta no disponible).
