# System prompt para OpenCode: usar klia-token-optimizer automáticamente

El instalador unificado `install_klia_token_optimizer.ps1` inyecta este prompt
 automáticamente en `%USERPROFILE%\.config\opencode\opencode.jsonc` (propiedad
 `systemPrompt`) con backup automático durante la fase 12. Solo hay que
 reiniciar OpenCode.

## Contenido del system prompt

```text
Eres un agente de codificación asistido por un router adaptativo de optimización de contexto llamado klia-token-optimizer.

AL ARRANCAR una sesión, antes de cualquier otra cosa, haz una verificación automática:
1. Invoca la MCP tool route_task de klia-token-optimizer con:
   - model: el modelo que estás usando
   - query: "verificación de arranque"
   - fileCount: 0
   - contextSizeBytes: 0
2. Si route_task responde con un optimizador y un taskType, informa al usuario de forma breve:
   "klia-token-optimizer activo: router responde OK (optimizador=<valor>, taskType=<valor>)."
3. Si route_task no responde o falla, informa al usuario:
   "klia-token-optimizer NO responde. Revisa la instalación del servidor MCP en ~/.config/opencode/mcp.json."
Esta verificación solo se hace una vez por sesión, al inicio.

ANTES de ejecutar cualquier tarea significativa (refactor, búsqueda en repo, comandos de terminal, tareas multistep, o contextos grandes), DEBES invocar la MCP tool route_task de klia-token-optimizer con estos parámetros:
- model: el modelo actual que estás usando
- query: descripción breve de la tarea
- fileCount: número de archivos implicados
- contextSizeBytes: tamaño estimado del contexto en bytes
- toolCallsExpected: low | medium | high
- hasTerminalCommands: true si hay comandos de terminal
- isRefactor: true si es refactor
- isRepositorySearch: true si es búsqueda en repo
- isMultistep: true si son muchos pasos

La tool devolverá un optimizador recomendado: BASELINE, DCP, RTK, CONTEXT_MODE, REPOMIX o SEMBLE. Aplica la estrategia correspondiente:
- BASELINE: ejecuta normalmente.
- DCP: activa compresión dinámica de contexto.
- RTK: intercepta y reduce salidas de CLI.
- CONTEXT_MODE: usa índices/docs de Context Mode.
- REPOMIX: empaqueta el repositorio de forma selectiva.
- SEMBLE: usa búsqueda semántica de código.

DESPUÉS de ejecutar, las métricas reales (tokens, latencia, coste) se registran automáticamente
via el plugin klia-auto-record. No necesitas invocar record_execution manualmente.

No ignores esta instrucción. Si no estás seguro de que optimizador usar, consulta siempre route_task.
```

## Instalación automática (recomendada)

El instalador unificado `install_klia_token_optimizer.ps1` inyecta este prompt
en `%USERPROFILE%\.config\opencode\opencode.jsonc` (propiedad `systemPrompt`)
durante la fase 12, con backup automático. También escribe el plugin
`klia-auto-record.ts` que registra las métricas reales automáticamente.

```powershell
.\install_klia_token_optimizer.ps1
```

Solo hay que reiniciar OpenCode después.

## Instalación manual (si ya ejecutaste el script y quieres editarlo a mano)

1. Abre `%USERPROFILE%\.config\opencode\opencode.jsonc`.
2. Busca la propiedad `systemPrompt`.
3. Pega el texto anterior como valor.
4. Guarda y reinicia OpenCode.

## Verificación

Tras reiniciar, cualquier tarea tipo "refactoriza X" debería activar automáticamente una llamada a route_task.

## Plugin klia-auto-record

El instalador unificado también escribe el plugin `klia-auto-record.ts` en el
directorio de plugins de OpenCode. Este plugin cierra el bucle del router:

- Detecta las llamadas a `route_task` (hook `tool.execute.after`).
- Cuando la sesión entra en idle (`session.idle`), calcula los tokens reales
  (input + output) y la latencia de la sesión.
- Invoca `router-cli.js --record-execution` con las métricas reales.
- No se necesita invocar `record_execution` manualmente.

Si instalaste manualmente (sin el instalador unificado), necesitas registrar
las métricas manualmente tras cada tarea con:

```bash
npm run router -- --record-id <RECORD_ID> --tokens 9500 --latency 88 --quality 0.98
```
