# Benchmark Results — BASELINE vs OPTIMIZED

> Generado por pruebas/benchmark/run-benchmark.ts.
> Tokens medidos con gpt-tokenizer (cl100k_base). NO es el tokenizer exacto de glm-5.2.
> Coste estimado con tabla pricing (input/output separados). NO es coste facturado por el proveedor.
> Calidad = desconocida (no medida en este script).
> Repeticiones por condicion: 3.

## Tabla por tarea (agregada de N repeticiones)

| Tarea | Optimizador | Condicion | Rep | Tokens tool out (media) | Bytes tool out (media) | Latencia ms (media) | Coste USD (media) | Tests passed | Completada |
|---|---|---|---|---|---|---|---|---|---|
| SMALL_CODE | BASELINE | BASELINE | 3 | 993 | 4629 | 8 | 0.000497 | N/A | si |
| TERMINAL | BASELINE | BASELINE | 3 | 0 | 0 | 16 | 0.000000 | N/A | no |
| TERMINAL | RTK | OPTIMIZED | 3 | 154 | 500 | 6222 | 0.000077 | N/A | si |
| LARGE_CONTEXT | BASELINE | BASELINE | 3 | 12625 | 52401 | 57 | 0.006313 | N/A | si |
| LARGE_CONTEXT | SEMBLE | OPTIMIZED | 3 | 54 | 163 | 3442 | 0.000027 | N/A | no |
| REPOSITORY_SEARCH | BASELINE | BASELINE | 3 | 15950 | 65918 | 29 | 0.007975 | N/A | si |
| REPOSITORY_SEARCH | CONTEXT_MODE | OPTIMIZED | 3 | 23 | 566 | 0 | 0.000012 | N/A | no |
| MULTISTEP | BASELINE | BASELINE | 3 | 5629 | 23105 | 10 | 0.002815 | N/A | si |
| MULTISTEP | DCP | OPTIMIZED | 3 | 0 | 0 | 0 | 0.000000 | N/A | no |
| REFACTOR | BASELINE | BASELINE | 3 | 4077 | 16561 | 7 | 0.002039 | N/A | si |
| REFACTOR | RTK | OPTIMIZED | 3 | 4077 | 16561 | 6 | 0.002039 | N/A | si |

## Comparativa emparejada (BASELINE vs OPTIMIZED, mismo tarea)

| Tarea | Optimizador | Tokens BASE | Tokens OPT | Ahorro tokens | Ahorro % | Latencia BASE (ms) | Latencia OPT (ms) | Δ Latencia % | Coste BASE USD | Coste OPT USD | Ahorro coste % | Calidad |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| TERMINAL | RTK | 0 | 154 | -154 | N/A% | 16 | 6222 | 39612.8% | 0.000000 | 0.000077 | N/A% | desconocida |
| LARGE_CONTEXT | SEMBLE | 12625 | 54 | 12571 | 99.6% | 57 | 3442 | 5974.7% | 0.006313 | 0.000027 | 99.6% | desconocida |
| REPOSITORY_SEARCH | CONTEXT_MODE | 15950 | 23 | 15927 | 99.9% | 29 | 0 | -100.0% | 0.007975 | 0.000012 | 99.8% | desconocida |
| MULTISTEP | DCP | 5629 | 0 | 5629 | 100.0% | 10 | 0 | -100.0% | 0.002815 | 0.000000 | 100.0% | desconocida |
| REFACTOR | RTK | 4077 | 4077 | 0 | 0.0% | 7 | 6 | -9.5% | 0.002039 | 0.002039 | 0.0% | desconocida |

## Agregado (solo comparaciones validas emparejadas)

- **Tareas validas en el agregado**: 4
- **Tareas excluidas**: 2 (SMALL_CODE (BASELINE: sin optimizador alternativo); MULTISTEP (DCP): no medible sin sesion interactiva)
- **Total tokens BASELINE**: 32652
- **Total tokens OPTIMIZADO**: 4308
- **Ahorro total (tokens tool output, estimado)**: 28344 (86.8%)

> **NOTA**: Este agregado mide tokens de salida de herramientas, NO tokens facturados al LLM.
> Para medir ahorro real de tokens facturados, se requiere sesion OpenCode con el modelo.
