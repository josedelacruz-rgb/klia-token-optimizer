# Benchmark max-real (tokens reales)

- Modelo/tokenizador: **GLM-5.2** (real, `usage.prompt_tokens`)
- Overhead de plantilla descontado: 12 tokens
- Baseline OpenCode: tool Read con prefijo `N: `, salida de Bash truncada a 2000 lineas / 51200 bytes
- Gate **simetrico**: si baseline u optimizador no contienen los hechos, ese brazo paga la recuperacion (lectura del artefacto completo)
- Generado: 2026-10-16T07:29:14.302Z

**Veredicto: 3 gana / 3 empata / 0 pierde.** Ahorro ponderado **10.8%**, medio 39.9%.

**Ahorro maximo: 98.4%** (S5 SERENA), techo 98.4%.


| ID | Tarea | Optim | baseTok | baseEff | optTok | optEff | ahorro | techo | cobertura | veredicto |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---|
| S1 | Ver el ultimo commit (mensaje, archivos y diff) | RTK | 14471 | 14471 | 6975 | 6975 | 51.8% | 97.6% | OK | gana |
| S2 | Ver los ultimos 5 commits con diff | RTK | 14473 | 103318 | 14473 | 103318 | 0.0% | 99.9% | OPT falta: docs: actualizar README/README_en/dev con estadisticas 68,3% y cambios recientes, fix: restaurar BASE_RULES, pricing klia/, metricas, logger + CI/LICENSE, feat: prefijo klia/ en modelos, ajuste de reglas base y reportes de benchmark, merge: resolve .gitignore conflict keeping all entries | empata |
| S3 | Entender la estructura del codigo de src | REPOMIX | 13965 | 72406 | 12283 | 70724 | 2.3% | 99.6% | OPT falta: RouteTaskSchema, RecordExecutionSchema, GetStatsSchema, RouterEventSignals, RouterEventDecision, RouterEventExecution | empata |
| S4 | Donde se descubren los modelos desde la API KLIA | SEMBLE | 5854 | 5854 | 775 | 775 | 86.8% | 99.7% | OK | gana |
| S5 | Localizar computeRecordCost y sus usos (navegacion de simbolos) | SERENA | 7924 | 7924 | 125 | 125 | 98.4% | 98.4% | OK | gana |
| S6 | Leer package.json (control: sin optimizacion posible) | BASELINE | 895 | 895 | 895 | 895 | 0.0% | 99.4% | OK | empata |
