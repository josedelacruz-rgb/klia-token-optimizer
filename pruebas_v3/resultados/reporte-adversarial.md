# Benchmark adversarial: ahorro real de tokens

**Modelo:** `glm-5.2` | **Fecha:** 2026-10-15T17:06:47.145Z

**Metodologia:** baseline competente-minimo (grep dirigido / grep de firmas / comando minimo); gate de cobertura (la salida del optimizador debe contener los hechos requeridos); el coste de recuperacion (releer el fichero o re-ejecutar el comando) se suma al optimizador. El ahorro puede ser negativo si el optimizador es peor que el baseline competente.

## Resumen

- Tareas evaluadas: **6/6**
- Resultado por tarea: **3 gana / 2 empata / 1 pierde**
- **Ahorro mediana por tarea: 3%** (metrica robusta; recomendada)
- Ahorro medio por tarea: -105.3% (dominado por tareas de baseline minusculo)
- Ahorro ponderado por tokens: 65.7%
- Cobertura media de hechos: 83%

## Detalle

| ID | Tarea | Tipo | Medido | Router | Baseline | Opt | Recup | Efectivo | Cob. | Ahorro | Nota |
|:---|:---|:---|:---|:---|---:|---:|---:|---:|---:|---:|:---|
| A1 | Localizar normalizacion de modelos | REPOSITORY_SEARCH | SEMBLE | SEMBLE | 1651 | 609 | 944 | 1553 | 0% | 5.9% | recuperacion: faltan 3/3 hechos |
| A2 | Estructura y firmas del modulo de historial | LARGE_CONTEXT | REPOMIX | SEMBLE | 302 | 2599 | 0 | 2599 | 100% | -760.6% | - |
| A3 | Contenido de los cambios del ultimo commit | TERMINAL | RTK | RTK | 38397 | 6580 | 0 | 6580 | 100% | 82.9% | - |
| A4 | Errores de tipos y sus ficheros | TERMINAL | RTK | RTK | 456 | 456 | 0 | 456 | 100% | 0% | - |
| A5 | Edicion puntual (confidenceMultiplier) | SMALL_CODE | SEMBLE | SEMBLE | 1120 | 671 | 0 | 671 | 100% | 40.1% | - |
| A6 | Refactor del modulo de historial | REFACTOR | BASELINE | RTK | 3834 | 3834 | 0 | 3834 | 100% | 0% | - |

> "Recup" = tokens de recuperacion que el agente paga por hechos ausentes.
> "N/D" = no cuenta para el ahorro (timeout o herramienta no disponible).
