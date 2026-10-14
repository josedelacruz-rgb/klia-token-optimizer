# install_klia_token_optimizer.ps1

Instalador unificado "todo-en-uno" en PowerShell que monta el entorno completo
de **OpenCode** con el router adaptativo `klia-token-optimizer` y los 5
optimizadores de contexto en Windows.

Sustituye a los antiguos scripts separados:
- `install.ps1` (raiz): instalaba solo el router e invocaba el instalador
  externo por stdin.
- `instaladores/install.ps1`: instalaba OpenCode + Semble + Context Mode +
  RTK + Repomix + Serena con menu interactivo.

Este script unifica ambos en uno solo, desatendido por defecto.

## Que instala

| Componente          | Funcion                                               | Origen            |
|---------------------|-------------------------------------------------------|-------------------|
| klia-token-optimizer| Router adaptativo (servidor MCP)                      | `npm run build`   |
| Semble              | Busqueda semantica de codigo (MCP)                    | `uv tool` (PyPI)  |
| Context Mode        | Indexacion y sandbox de archivos grandes (plugin)    | `npm`             |
| RTK                 | Proxy que comprime salida de comandos CLI             | winget/cargo/GitHub |
| repomix             | Empaquetador de repos para vision global (MCP)        | `npm`             |
| Serena              | Operaciones estructurales tipo IDE (MCP con LSP)      | `uv tool` (PyPI)  |
| klia-auto-record    | Plugin OpenCode que registra metricas reales automaticamente | `.opencode/plugin/` |

## Uso

```powershell
# Desatendido (por defecto): instala los 5 optimizadores + router
.\install_klia_token_optimizer.ps1

# Perfil especifico
.\install_klia_token_optimizer.ps1 -StackProfile minimo
.\install_klia_token_optimizer.ps1 -StackProfile repomix
.\install_klia_token_optimizer.ps1 -StackProfile serena

# Menu interactivo
.\install_klia_token_optimizer.ps1 -Interactive

# Simular sin tocar nada
.\install_klia_token_optimizer.ps1 -DryRun

# Reinstalar sin pedir confirmacion
.\install_klia_token_optimizer.ps1 -Force

# No generar backups antes de modificar
.\install_klia_token_optimizer.ps1 -SkipBackup

# Desinstalar todo
.\install_klia_token_optimizer.ps1 -Uninstall
```

## Perfiles

| Perfil    | Optimizadores instalados                          |
|-----------|---------------------------------------------------|
| `all`     | Semble + Context Mode + RTK + Repomix + Serena (default) |
| `minimo`  | Semble + Context Mode + RTK                       |
| `repomix` | minimo + Repomix                                  |
| `serena`  | minimo + Serena                                    |

En modo `all` no se aplica exclusividad entre Repomix y Serena (ambos se
instalan). En los perfiles `minimo`/`repomix`/`serena` si se aplica la
exclusividad original: repomix XOR serena.

## Parametros

| Parametro       | Descripcion                                          |
|-----------------|------------------------------------------------------|
| `-Force`        | Reinstala sin pedir confirmacion.                    |
| `-SkipBackup`   | No genera copias `.bak-*` antes de modificar.        |
| `-DryRun`       | Muestra que haria sin tocar nada.                    |
| `-Uninstall`    | Desinstala el router + los 5 optimizadores.          |
| `-StackOnly`    | Solo instala optimizadores, sin el router.           |
| `-Interactive`  | Menu interactivo (8 opciones).                        |
| `-StackProfile` | `all` (default), `minimo`, `repomix`, `serena`.      |

## Fases del instalador (12 fases)

| Fase | Descripcion                                                  |
|------|--------------------------------------------------------------|
| 0    | Pre-checks: opencode, Node >= 22.5, npm, uv                 |
| 1    | Instalar Semble (`uv tool install`, configura MCP + AGENTS) |
| 2    | Instalar Context Mode (plugin npm, limpia MCP legacy)        |
| 3    | Instalar RTK (7 sub-fases: binario, plugin, RTK.md, AGENTS)  |
| 4    | Instalar Repomix (6 sub-fases: npm, MCP, config, AGENTS)    |
| 5    | Instalar Serena (5 sub-fases: uv, serena-agent, MCP, AGENTS) |
| 6    | Preset: normalizar plugin, MCPs y flags (8 apagadas)         |
| 7    | Ajustar `base-rules.ts` (BASELINE si un optimizador fallo)   |
| 8    | `npm install` (dependencias del proyecto, siempre)             |
| 9    | `npm run build` (compilar a `dist/`, siempre)                |
| 10   | Preparar `.router-history/` + calibrar si esta vacio         |
| 11   | Registrar MCP `klia-token-optimizer` en `opencode.jsonc`     |
| 12   | Configurar plugin `klia-auto-record.js` en el proyecto y registrar MCP V2 |
| ST   | Smoke test del router                                         |

### Detalle de cada optimizador

**Semble** (fase 1):
- Verifica `uv` + Python >= 3.10.
- Instala globalmente con `uv tool install semble[mcp]==0.6.1`.
- Ejecuta `semble install --agent opencode --type all --yes`.
- Verifica los 3 archivos: `opencode.jsonc` (MCP), `AGENTS.md` (bloque
  SEMBLE), `agents/semble-search.md` (sub-agente).
- Inyecta/refuerza routing en `AGENTS.md` (semble > grep para semantica).
- Crea `.sembleignore` template.
- Prueba de humo (`semble --version` + `semble search`).

**Context Mode** (fase 2):
- Lo registra como **plugin** (no MCP), segun benchmark interno.
- Limpia configuracion MCP legacy si existe.
- Crea `~/.config/opencode/docs/context-mode.md` (politica + benchmark).
- Sobrescribe `~/.config/opencode/AGENTS.md` con reglas minimas
  PRESERVANDO los bloques SEMBLE, RTK, REPOMIX y SERENA si existen.
- Ejecuta `ctx stats` / `ctx doctor` si estan disponibles.

**RTK** (fase 3, 7 sub-fases, NO usa `rtk init`):
1. Instalar binario rtk (winget -> cargo -> GitHub release + SHA-256).
2. Escribir `plugin/openrtk.ts` (version parcheada, inlinea `rewrite()`
   para evitar bug ESM upstream de `rtk init -g --opencode`).
3. Crear `RTK.md` (instrucciones de rtk para el agente).
4. Insertar bloque `RTK_START`/`RTK_END` en `AGENTS.md` (idempotente).
5. Escribir `%APPDATA%\rtk\config.toml` (tracking, display, filters).
6. Migrar recall de tee a sqlite (`rtk config recall sqlite`).
7. Verificacion final (rtk --version, plugin, RTK.md, bloque AGENTS.md,
   config.toml, rtk gain).
- Log: `~/.config/opencode/rtk-install-<fecha>.log`
- Backups: `.bak-rtk-<fecha>` por archivo modificado (salvo `-SkipBackup`).
- Coexiste con semble (busqueda) y context-mode (archivos grandes).

**Repomix** (fase 4, 6 sub-fases):
1. Instalar paquete npm global `repomix`.
2. Verificar/inyectar entrada MCP `mcp.repomix` en `opencode.jsonc`.
3. Crear `~/.config/opencode/repomix.config.json` con defaults.
4. Inyectar bloque `REPOMIX_START`/`END` en `AGENTS.md` con routing
   anti-solapamiento (repomix = empaquetador, NO buscador).
5. Crear `~/.config/opencode/.repomixignore` global.
6. Verificacion final (5 checks).
- Coexiste con semble (busqueda) y context-mode (archivos grandes).

**Serena** (fase 5, 5 sub-fases):
1. Verificar/instalar `uv` (si no esta, lo instala via `irm | iex`).
2. Instalar `serena-agent` globalmente con `uv tool install -p 3.13`.
3. Verificar que `serena` esta en PATH.
4. Verificar/inyectar entrada MCP `mcp.serena` en `opencode.jsonc` +
   inyectar bloque `SERENA_START`/`END` en `AGENTS.md` con routing
   anti-solapamiento (serena = IDE semantico, NO buscador NL como semble).
5. Verificacion final (3 checks).
- Coexiste con semble (busqueda semantica NL), repomix (empaquetado) y
  context-mode (archivos grandes).

### Preset (fase 6)

Ademas de instalar, el preset:
1. Quita `@tarquinen/opencode-dcp` del array `plugin` (solapa con Context Mode).
2. Asegura que solo `["context-mode"]` quede en `plugin`.
3. Apaga 8 flags que se solapan entre si:
   - `aggressive_truncation`, `preemptive_compaction`, `truncate_all_tool_outputs`
   - `dynamic_context_pruning.enabled`, `supersede_writes.enabled`,
     `supersede_writes.aggressive`
   - `purge_errors.enabled`
4. Enciende `deduplication.enabled` (complementaria, no solapa).
5. Sintoniza `purge_errors.turns=1` y `context_protection.turns=3`.
6. En modo `all` NO elimina repomix ni serena (sin exclusividad).
   En modos `minimo`/`repomix`/`serena` mantiene la exclusividad original.
7. Inyecta bloques `SEMBLE`, `RTK`, `REPOMIX` o `SERENA` en `AGENTS.md`
   segun perfil.

### Ajuste automatico de base-rules.ts (fase 7)

Si un optimizador fallo al instalarse, el instalador reemplaza automaticamente
su nombre por `BASELINE` en `src/rules/base-rules.ts` para que el router
nunca recomiende un optimizador que no esta disponible. Genera backup de
`base-rules.ts` antes de modificarlo.

### Plugin klia-auto-record (fase 12)

El instalador asegura que el plugin `.opencode/plugin/klia-auto-record.js`
exista en el proyecto y lo declara en `opencode.json` del proyecto. Este
plugin cierra el bucle del router adaptativo:
- Hookea `tool.execute.before` y `tool.execute.after` para cada tool call soportada.
- Clasifica la tarea con el router y decide el optimizador esperado.
- Registra las metricas reales (tokens estimados, latencia, calidad, fallos)
  inmediatamente despues de la ejecucion.
- No requiere accion manual del usuario.
- Ignora las tool calls cuyo nombre empiece por `klia-token-optimizer`
  para evitar recursion.

### System prompt (fase 12)

El instalador inyecta automaticamente el system prompt del router en
`opencode.jsonc` (propiedad `systemPrompt`). El prompt instruye al modelo
para:
1. Verificar al arrancar que el router responde.
2. Invocar `route_task` antes de tareas significativas.
3. Aplicar el optimizador recomendado.
4. Dejar que el plugin `klia-auto-record` registre las metricas.

## Caracteristicas

- **Idempotente**: detecta lo que ya esta instalado y solo anade lo que falta.
- **Con backups**: cada archivo modificado deja una copia `.bak-<fase>-<fecha>`.
- **Sin sobreescritura destructiva**: preserva bloques previos en `AGENTS.md`
  (SEMBLE, RTK, REPOMIX, SERENA) y solo actualiza su contenido entre
  marcadores `<!-- ..._START --> / <!-- ..._END -->`.
- **Ajuste automatico**: si un optimizador falla, `base-rules.ts` se ajusta
  para que el router use `BASELINE` en su lugar.
- **Smoke test**: ejecuta una decision de prueba del router al final.
- **Politica de versiones fijas**: Semble 0.6.1, RTK 0.50.0, Python 3.11
  para Context Mode y 3.13 para Serena (politica empresarial, no usa
  `latest`).

## Requisitos

- **Node.js >= 22.5** (requerido por Context Mode).
- **npm**.
- **uv** (gestor de Python, instalado automaticamente si falta, lo necesita
  Semble y Serena).
- **opencode** (instalado automaticamente si falta via `npm install -g
  opencode-ai`).

## Notas

- El script debe ejecutarse desde la raiz del proyecto
  `klia-token-optimizer`.
- Cada modulo es idempotente (re-ejecutable sin romper nada).
- Para uso desatendido (CI, despliegue masivo) usar el modo por defecto
  (sin `-Interactive`).
- Despues de instalar, solo queda reiniciar OpenCode para que cargue el
  servidor MCP, el plugin auto-record y los MCP adicionales.
