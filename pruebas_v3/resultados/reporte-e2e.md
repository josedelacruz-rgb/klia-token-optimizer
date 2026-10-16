# Benchmark end-to-end: ahorro real (tokens, coste, pasos)

**Fecha:** 2026-10-15T14:57:53.332Z | **Repeticiones por tarea:** 1

**Metodologia:** `opencode run --format json` en dos condiciones. BASELINE = optimizadores desactivados (semble/repomix/serena off). OPTIMIZED = activados. Metricas reportadas por opencode/modelo (no estimadas). Tareas de solo lectura.

## Tokens por tarea (media de 1 ejecuciones)

| Tarea | Cond. | Entrada | Salida | Total (media) | Desv | Min | Max | Llamadas | Tools | Completada |
|:---|:---|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| E3 | BASELINE | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0% |
| E3 | OPTIMIZED | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0% |

## Coste (USD, media por ejecucion)

| Tarea | Coste BASELINE | Coste OPTIMIZED |
|:---|---:|---:|
| E3 | $0.000000 | $0.000000 |

## Ahorro global (tareas completadas en ambas condiciones: 0/1)

- Tokens BASELINE (suma de medias): **0**
- Tokens OPTIMIZED (suma de medias): **0**
- **Ahorro de tokens: 0%**
- Coste BASELINE: $0.000000 | OPTIMIZED: $0.000000
- **Ahorro de coste: 0%**

## Trazabilidad

- Trazas completas (eventos JSON por ejecucion): `pruebas_v3/resultados/traces/`
- Datos crudos: `pruebas_v3/resultados/resultados-e2e.json`
- Tokenizacion: tokens reportados por el proveedor a traves de opencode (`step_finish.tokens`), no estimados.
