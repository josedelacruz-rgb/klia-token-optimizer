# Simulador de sesiones de desarrollo (tokens reales)

- Modelo/tokenizador: **GLM-5.2** (real, `usage.prompt_tokens`)
- 10 sesiones x 12 tareas = 119 tareas | seed=20261016
- Baseline OpenCode: Read con `N: ` + Bash capado a 2000 lineas / 51200 bytes
- Router en frio (V0, sin historial); proxies DCP/CONTEXT_MODE/SERENA
- Generado: 2026-10-16T08:26:32.261Z

**Techo observado: 74.8%** | **Potencial del optimizador: 72.9%** | **Producto con el router: 74.1%** | **Acierto router: 85.1%** (63/74)

**Veredicto: SI SIRVE.** 68 gana / 47 empata / 4 pierde.


## Por categoria

| Categoria | n | Potencial | Router | Veredicto |
|---|---:|---:|---:|---|
| git_small | 9 | 0.0% | 0.0% | empata |
| search_symbol | 19 | 88.8% | 88.8% | gana |
| verify | 20 | 72.7% | 72.7% | gana |
| read_file | 36 | 0.0% | 0.0% | empata |
| deps | 5 | 99.3% | 99.3% | gana |
| git_diff | 16 | 79.1% | 79.1% | gana |
| docs | 5 | 16.4% | 6.8% | empata |
| bigfile | 1 | 98.4% | 93.2% | gana |
| structure | 5 | 4.1% | 15.6% | gana |
| refactor | 3 | 97.9% | 97.9% | gana |

## Por sesion

| Sesion | n | Potencial | Router |
|---:|---:|---:|---:|
| 1 | 12 | 89.8% | 89.8% |
| 2 | 12 | 84.8% | 84.8% |
| 3 | 12 | 91.2% | 91.1% |
| 4 | 12 | 53.4% | 42.5% |
| 5 | 12 | 81.6% | 80.7% |
| 6 | 12 | 79.5% | 79.5% |
| 7 | 11 | 90.6% | 90.6% |
| 8 | 12 | 29.5% | 38.4% |
| 9 | 12 | 68.1% | 68.7% |
| 10 | 12 | 26.6% | 35.4% |
