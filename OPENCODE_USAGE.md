# Guía de uso en OpenCode

## Método principal: CLI `router`

Antes de una tarea en OpenCode, ejecuta en terminal:

```bash
cd C:\ProyectosV2\telemetria\klia-token-optimizer
npm run router -- --model glm-5.2 --query "refactoriza auth" --files 12 --size 250000
```

Salida:

```text
OPTIMIZER=RTK
TASK_TYPE=REFACTOR
VERSION=V2
CONFIDENCE=1
REASON=Para glm-5.2/REFACTOR, RTK tiene el menor coste relativo (0.58) con 3 muestras.
RECORD_ID=...
```

## Aplicar el optimizador

Según `OPTIMIZER`:

- `BASELINE` → ejecuta normalmente.
- `DCP` → activa Dynamic Context Pruning.
- `RTK` → activa reducción de salidas de CLI.
- `CONTEXT_MODE` → usa Context Mode.
- `REPOMIX` → empaqueta el repo.
- `SEMBLE` → usa Semble para contexto extremo.

## Registrar métricas reales

### Automático (recomendado)

Si instalaste con el instalador unificado (`install_klia_token_optimizer.ps1`), el plugin `klia-auto-record.ts` registra las métricas automáticamente tras cada sesión. No necesitas invocar `record_execution` manualmente.

El plugin:
1. Detecta las llamadas a `route_task` (hook `tool.execute.after`).
2. Cuando la sesión entra en idle, calcula los tokens reales (input + output) y la latencia.
3. Invoca `router-cli.js --record-execution` con las métricas reales.

### Manual (si no usas el instalador unificado)

Tras ejecutar con el optimizador recomendado:

```bash
npm run router -- --record-id <RECORD_ID> --tokens 9500 --latency 88 --quality 0.98
```

Esto actualiza el registro con las métricas reales para que el router aprenda.

## CLI alternativo: `route`

```bash
npm run route -- --model glm-5.2 --query "refactoriza auth" --files 12 --size 200000
```

Devuelve la decisión completa en formato JSON.

## MCP server

El MCP server `klia-token-optimizer` está configurado en `opencode.jsonc`. Si tu modelo soporta tool use, puedes invocarlo con:

```text
use the klia-token-optimizer route_task tool to decide the optimizer for model glm-5.2, query "refactoriza auth", fileCount 12, contextSizeBytes 250000
```

Tools disponibles:

- `route_task`
- `record_execution`
- `get_router_stats`

## Recalibración

```bash
cd C:\ProyectosV2\telemetria\klia-token-optimizer
npm run calibrate -- --history .router-history/history.json --repetitions 3
```

## Variables de entorno

Edita `opencode.jsonc` en la sección `mcp.klia-token-optimizer.env`:

```jsonc
"env": {
  "ROUTER_HISTORY_PATH": "C:/ProyectosV2/telemetria/klia-token-optimizer/.router-history/history.json",
  "ROUTER_METRICS_PATH": "C:/ProyectosV2/telemetria/klia-token-optimizer/.router-history/mcp-metrics.json",
  "ROUTER_MIN_CONFIDENCE": "0.6",
  "ROUTER_EXPLORATION_RATE": "0.1",
  "ROUTER_MIN_SAMPLES": "3",
  "ROUTER_LATENCY_WEIGHT": "1.0",
  "ROUTER_TOOLING_COST_WEIGHT": "1.0",
  "ROUTER_FAILURE_PENALTY": "5.0",
  "ROUTER_QUALITY_PENALTY": "3.0"
}
```

## Instalación

El instalador unificado `install_klia_token_optimizer.ps1` instala el router, los 5 optimizadores, el plugin de auto-registro y el system prompt en un solo paso:

```powershell
.\install_klia_token_optimizer.ps1
```

Ver [instaladores/install.md](./instaladores/install.md) para detalles completos.

## Nota importante

La calidad de las recomendaciones depende de registrar métricas reales tras cada ejecución. Sin registros, el router vuelve a V0 (reglas base) o mantiene estimaciones obsoletas. El plugin `klia-auto-record` (instalado automáticamente por el instalador unificado) elimina esta carga manual.