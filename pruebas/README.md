# Pruebas KLIA Token Optimizer

Suite de pruebas que demuestra que el router funciona y genera una tabla comparativa BASELINE vs OPTIMIZADO.

## Ejecutar

```bash
npx tsx pruebas/run-all.ts
```

Tiempo total: < 20 minutos (budget interno: 18 min con 2 min de margen).

## Qué prueba (P0-P9)

| # | Prueba | Qué valida |
|---|--------|-----------|
| P0 | Build + CLI arranca | `npm run build` compila; `--help` responde |
| P1 | Clasificación de los 6 TaskType | `route_task` clasifica correctamente cada tipo |
| P2 | Recomendación cumple reglas declaradas | Sin histórico, cae a BASE_RULES (V0) |
| P3 | Medir contexto BASELINE | Bytes reales que OpenCode leería sin optimizador |
| P4 | Medir contexto OPTIMIZADO | Repomix/Semble/RTK/Context-Mode aplicados, bytes reales |
| P5 | Inyectar histórico + get_router_stats | Router aprende y cambia a V2; stats muestra ahorro |
| P6 | Calidad 0.95 hardcodeado | HALLAZGO: no es medición real |
| P7 | Registro no duplica | HALLAZGO: CLI no deduplica por sessionId |
| P8 | excludeSynthetic filtra | `get_router_stats` respeta el flag |
| P9 | Generar tabla comparativa | Markdown con tabla BASELINE vs OPTIMIZADO |

## Resultados

Se generan en `pruebas/resultados/`:

- `comparativa-baseline-vs-optimizado.md` — tabla para el jefe
- `datos-crudos.json` — evidencia cruda de cada prueba
- `hallazgos.md` — hallazgos detectados
- `reporte-ejecucion.json` — resumen de P0-P9 con tiempos

## Qué mide cada columna de la tabla

| Columna | Cómo se mide |
|---------|-------------|
| Tokens ctx BASELINE | Bytes reales de archivos/comandos que OpenCode leería sin optimizador (4 bytes ~ 1 token) |
| Tokens ctx OPTIMIZADO | Bytes reales del resultado de aplicar el optimizador (repomix --compress, semble search, rtk, etc.) |
| Ahorro ctx % | (BASELINE - OPTIMIZADO) / BASELINE * 100 |
| Latencia (s) | Del histórico inyectado (declarado, sintético) |
| Calidad | Del histórico inyectado (declarado, sintético) |
| Coste USD | tokens * 0.000002 (estimación) |
| Veredicto | AHORRA / NO AHORRA / EMPATE / N/A |

## Advertencias (leer antes de interpretar la tabla)

- **Tokens de contexto**: medidos reales sobre el repo `klia-token-optimizer` (21 archivos).
- **Latencia y calidad**: del histórico inyectado declarado en el script (`synthetic: true`). No son mediciones de sesión viva.
- **Calidad 0.95**: el plugin `klia-auto-record` la hardcodea. No procede de medición real. Ver HALLAZGO P6.
- **DCP (MULTISTEP)**: no medible sin sesión interactiva. Reportado como N/A.
- **Ahorrar tokens de output** requiere ejecutar el LLM con y sin optimizador; fuera del alcance de este script de 20 min. La tabla mide **ahorro de contexto de entrada**.

## Escenarios

- `escenarios/tareas.json` — 6 tareas (una por TaskType) con query realista y archivos objetivo
- `escenarios/historico-inyectado.json` — datos sintéticos con BASELINE + optimizador por tarea
