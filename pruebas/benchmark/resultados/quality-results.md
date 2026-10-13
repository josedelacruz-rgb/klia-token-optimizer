# Quality Results — Calidad y correccion

> **LIMITACION CRITICA**: La calidad NO SE MIDE en este script.

## Por que no se mide

1. El plugin `plugins/klia-auto-record.ts:294` hardcodea `--quality 0.95`.
   Este valor NO procede de una evaluacion real del resultado.
2. El schema MCP (`src/mcp-server.ts`) tiene `quality: default(1)`,
   discrepancia con el plugin.
3. Medir calidad real requiere:
   - Tests automatizados del cambio (vitest, integration tests).
   - O revision ciega del diff por un evaluador.
   - O evaluador LLM-as-judge (auxiliar, no verdad objetiva).

## Como se distinguio en los registros

| Campo | Valor usado | Significado |
|---|---|---|
| `calidad.valor` | `null` | No se midio. |
| `calidad.tipo` | `desconocida` | No procede de medicion. |
| `calidad.origen` | texto descriptivo | Documenta la causa. |

## Lo que SI se valido (correccion minima)

- **Tests del proyecto**: para SMALL_CODE y REFACTOR, se ejecuto `vitest run`
  y se registro `tests.passed/failed/total` en cada BenchmarkRecord.
- **Completada**: `true` si la ejecucion del optimizador no tuvo errores.
- **Errores**: lista de strings con la causa del fallo (si lo hubo).

## Recomendacion

Antes de presentar un porcentaje de ahorro al jefe:
- Reemplazar `quality: 0.95` por una medicion real (tests, diff, evaluador).
- Marcar el tipo de calidad: `medida`, `estimada` o `desconocida`.
- No usar el valor 0.95 como si fuera verdad objetiva.
