# Pruebas aleatorias sobre un proyecto externo (tokens reales)

- Proyecto: `C:\ProyectosV2\telemetria\opencode-benchmark-lab` (Python / FastAPI)
- Modelo/tokenizador: **GLM-5.2** (real, `usage.prompt_tokens`)
- Presupuesto: ~1 min | duracion real: 61s | seed=777
- 16 tareas aleatorias; por tarea: PRIMERO baseline, LUEGO optimizador del router
- Baseline OpenCode: Read con `N: ` + Bash capado a 2000 lineas / 51200 bytes
- Router en frio (V0, sin historial); proxies DCP/CONTEXT_MODE/SERENA/REPOMIX/SEMBLE
- Generado: 2026-10-16T09:20:01.417Z

**Techo observado: 86.2%** | **Recomendado: 75.7%** | **Producto con el router: 74.3%** | **Acierto util router: 66.7%** (8/12)

**Veredicto: SI SIRVE.** 10 gana / 6 empata / 0 pierde.


## Por categoria

| Categoria | n | Potencial | Router | Veredicto |
|---|---:|---:|---:|---|
| docs | 3 | 24.7% | 56.0% | gana |
| search_symbol | 4 | 74.9% | 74.9% | gana |
| read_file | 4 | 0.0% | 0.0% | empata |
| bigfile | 2 | 99.8% | 83.5% | gana |
| deps | 1 | 98.8% | 98.8% | gana |
| structure | 2 | 67.1% | 13.2% | gana |
