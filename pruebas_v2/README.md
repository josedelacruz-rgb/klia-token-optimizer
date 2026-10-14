# pruebas_v2 - Benchmark rapido de klia-token-optimizer

Este directorio contiene un benchmark de 5-10 minutos que valida el router
adaptativo de klia-token-optimizer.

## Uso

```bash
npx tsx pruebas_v2/run-benchmark.ts
```

## Que hace

1. Carga los escenarios desde `pruebas_v2/escenarios/tareas.json`.
2. Para cada escenario:
   - Llama al router para decidir el optimizador.
   - Simula la ejecucion con el optimizador recomendado.
   - Registra la ejecucion real en `data/history.json` y `data/events.json`.
   - Registra una ejecucion BASELINE sintetica para calcular ahorros.
3. Genera `get_router_stats` y crea el reporte.

## Salida

- `pruebas_v2/resultados/reporte.md` - Tabla comparativa BASELINE vs OPTIMIZADO.
- `pruebas_v2/resultados/resultados.json` - Datos raw del benchmark.

## Notas

- Los datos de baseline son sinteticos para poder calcular ahorros teoricos.
- Los datos de ejecucion optimizada tienen variacion aleatoria para simular
  condiciones reales.
- Antes de ejecutar, asegurate de haber compilado el proyecto:
  `npm run build`.
