# Benchmark diverso (tokens reales)

- Modelo/tokenizador: **GLM-5.2** (real, `usage.prompt_tokens`)
- Baseline OpenCode: Read con prefijo `N: ` + Bash truncado a 2000 lineas / 51200 bytes
- Gate simetrico + recuperacion (artefacto completo); techo teorico por escenario
- Proxies: DCP (poda/dedup), CONTEXT_MODE (recuperacion de secciones), SERENA (git grep)
- Generado: 2026-10-16T07:49:03.009Z

**Veredicto: 11 gana / 3 empata / 1 pierde.** Ponderado **42.2%**, medio 57.1%.

**Ahorro maximo: 99.3%** (D05 DCP, TERMINAL), techo 100.0%.


| ID | Tipo | Tarea | Optim | baseEff | optEff | ahorro | techo | cobertura | veredicto |
|---|---|---|---|---:|---:|---:|---:|---|---|
| D01 | SMALL_CODE | Leer package.json (control SMALL_CODE) | BASELINE | 916 | 916 | 0.0% | 99.5% | OK | empata |
| D02 | SMALL_CODE | Localizar la funcion computeRecordCost (fichero pequeno) | SEMBLE | 1060 | 806 | 24.0% | 98.7% | OK | gana |
| D03 | TERMINAL | Ver el ultimo commit (mensaje, archivos y diff) | RTK | 14471 | 6975 | 51.8% | 97.6% | OK | gana |
| D04 | TERMINAL | Ver los ultimos 5 commits con diff (control TERMINAL) | BASELINE | 103318 | 103318 | 0.0% | 99.9% | OPT falta: docs: actualizar README/README_en/dev con estadisticas 68,3% y cambios recientes, fix: restaurar BASE_RULES, pricing klia/, metricas, logger + CI/LICENSE, feat: prefijo klia/ en modelos, ajuste de reglas base y reportes de benchmark, merge: resolve .gitignore conflict keeping all entries | empata |
| D05 | TERMINAL | Inspeccionar las dependencias instaladas (node_modules) | DCP | 76264 | 505 | 99.3% | 100.0% | baseline incompleto | gana |
| D06 | LARGE_CONTEXT | Entender la estructura del codigo de src | REPOMIX | 72406 | 70724 | 2.3% | 99.6% | OPT falta: RouteTaskSchema, RecordExecutionSchema, GetStatsSchema, RouterEventSignals, RouterEventDecision, RouterEventExecution | empata |
| D07 | LARGE_CONTEXT | Como aprende el router adaptativo de la historia y elige optimizador | SEMBLE | 8268 | 839 | 89.9% | 99.9% | OK | gana |
| D08 | LARGE_CONTEXT | Como anado un optimizador nuevo (docs AGENTS.md) | CONTEXT_MODE | 1885 | 797 | 57.7% | 99.6% | OK | gana |
| D09 | LARGE_CONTEXT | Navegar un script PowerShell grande (138 KB) para localizar Save-Config | SERENA | 14643 | 241 | 98.4% | 100.0% | OK | gana |
| D10 | REPOSITORY_SEARCH | Donde se descubren los modelos desde la API KLIA | SEMBLE | 5854 | 798 | 86.4% | 99.8% | OK | gana |
| D11 | REPOSITORY_SEARCH | Recuperar de la documentacion como se ejecutan los tests y benchmarks | CONTEXT_MODE | 3259 | 3661 | -12.3% | 99.9% | OPT falta: npm test, benchmark | pierde |
| D12 | MULTISTEP | Analiza el ultimo commit, lee el router y resume (3 pasos) | DCP | 14472 | 637 | 95.6% | 99.8% | OK | gana |
| D13 | REFACTOR | Refactor: localizar computeRecordCost y todos sus usos | SERENA | 7924 | 125 | 98.4% | 98.4% | OK | gana |
| D14 | DEBUG | Arreglar los errores de tipo de tsc (salida real) | RTK | 1761 | 430 | 75.6% | 95.1% | OK | gana |
| D15 | DEBUG | Diagnosticar el error TS2741 y la definicion del tipo (DEBUG) | CONTEXT_MODE | 4664 | 484 | 89.6% | 99.9% | OK | gana |

## Ahorro por optimizador

| Optimizador | n | medio | ponderado |
|---|---:|---:|---:|
| BASELINE | 2 | 0.0% | 0.0% |
| CONTEXT_MODE | 3 | 45.0% | 49.6% |
| DCP | 2 | 97.5% | 98.7% |
| REPOMIX | 1 | 2.3% | 2.3% |
| RTK | 2 | 63.7% | 54.4% |
| SEMBLE | 3 | 66.7% | 83.9% |
| SERENA | 2 | 98.4% | 98.4% |
