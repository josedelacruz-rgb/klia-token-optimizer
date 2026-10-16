# Pruebas aleatorias sobre un proyecto externo (tokens reales)

- Proyecto: `C:\ProyectosV2\telemetria\opencode-benchmark-lab` (Python / FastAPI)
- Modelo/tokenizador: **GLM-5.2** (real, `usage.prompt_tokens`)
- Presupuesto: ~25 min | duracion real: 1440s | seed=142912516
- 684 tareas aleatorias; por tarea: PRIMERO baseline, LUEGO optimizador del router
- Baseline OpenCode: Read con `N: ` + Bash capado a 2000 lineas / 51200 bytes
- Router en frio (V0, sin historial); proxies DCP/CONTEXT_MODE/SERENA/REPOMIX/SEMBLE
- Generado: 2026-10-16T09:52:33.292Z

**Techo observado: 85.5%** | **Recomendado: 83.1%** | **Producto con el router: 75.9%** | **Acierto util router: 60.0%** (341/568)

**Veredicto: SI SIRVE.** 422 gana / 214 empata / 48 pierde.


## Por categoria

| Categoria | n | Potencial | Router | Veredicto |
|---|---:|---:|---:|---|
| search_symbol | 156 | 84.3% | 84.3% | gana |
| docs | 88 | 35.5% | 18.7% | gana |
| structure | 143 | 49.1% | 9.5% | empata |
| deps | 100 | 98.8% | 98.8% | gana |
| bigfile | 81 | 99.6% | 77.0% | gana |
| read_file | 116 | 0.0% | 0.0% | empata |
