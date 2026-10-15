# Reporte Comparativo: opencode BASELINE vs opencode OPTIMIZER

**Fecha:** 2026-10-14T17:15:12.684Z
**Protocolo:** 2 fases, 3 tareas por fase, 6 ejecuciones totales

## Resumen Global

| Metrica | BASELINE | OPTIMIZER | Diferencia |
|:---|---:|---:|---:|
| Tokens de salida | 1987 | 743 | 1244 |
| Bytes de salida | 7489 | 2786 | 4703 |
| Duracion total (s) | 308.2 | 352.9 | -44.8 |
| Ahorro % | 0% | - | **62.6%** |

## Resultados por Tarea

| ID | Tarea | Tokens B | Tokens O | Ahorro | Ahorro % | Tiempo B (s) | Tiempo O (s) |
|:---|:---|---:|---:|---:|---:|---:|---:|
| T1-TERMINAL_LARGE | Git log con diffs completos | 499 | 272 | 227 | 45.5% | 76.8 | 120.0 |
| T2-REPO_SEARCH | Buscar donde se maneja el historial | 0 | 471 | -471 | 0% | 120.0 | 112.9 |
| T3-LARGE_CONTEXT | Explicar modulo de scoring completo | 1488 | 0 | 1488 | 100.0% | 111.3 | 120.0 |

## Configuracion

| Componente | BASELINE | OPTIMIZER |
|:---|:---|:---|
| semble | desactivado | activado |
| repomix | desactivado | activado |
| serena | desactivado | activado |
| klia-auto-record | desactivado | activado |
| KLIA_FORCE_BASELINE | 1 | no |

## Conclusion

OPTIMIZER ahorro **1244 tokens (62.6%)** frente a BASELINE.
