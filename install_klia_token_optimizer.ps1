# Instalador unificado todo-en-uno del servidor MCP klia-token-optimizer
# mas el stack completo de optimizadores de contexto para OpenCode.
#
# Sustituye a:
#   - install.ps1 (raiz): instalaba klia-token-optimizer e invocaba el
#     instalador externo por stdin para instalar los optimizadores.
#   - instaladores/install.ps1: instalaba OpenCode + Semble + Context Mode +
#     RTK + Repomix + Serena con menu interactivo.
#
# Este script unifica ambos en uno solo, desatendido por defecto.
#
# Uso:
#   .\install_v2.ps1                          # Desatendido. Instala los 5 optimizadores + router.
#   .\install_v2.ps1 -StackOnly -StackProfile repomix
#   .\install_v2.ps1 -StackOnly -StackProfile serena
#   .\install_v2.ps1 -StackOnly -StackProfile minimo
#   .\install_v2.ps1 -Interactive             # Menu interactivo (8 opciones)
#   .\install_v2.ps1 -DryRun                  # Simula sin tocar nada
#   .\install_v2.ps1 -SkipBackup              # No genera .bak-* antes de modificar
#   .\install_v2.ps1 -Force                   # Reinstala sin pedir confirmacion
#   .\install_v2.ps1 -Uninstall              # Desinstala el router + los 5 optimizadores
#
# Requisitos:
#   - Node.js >= 22.5 (requerido por Context Mode)
#   - npm
#   - uv (instalado automaticamente si falta, lo necesita Semble y Serena)
#   - opencode (instalado automaticamente si falta via npm install -g opencode-ai)
#
# Idempotente: re-ejecutable sin romper nada. Genera backups .bak-<fase>-<ts>
# antes de modificar opencode.jsonc, AGENTS.md y archivos del router.

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipBackup,
    [switch]$DryRun,
    [switch]$Uninstall,
    [switch]$StackOnly,
    [switch]$Interactive,
    [switch]$V2Only,
    [ValidateSet('','minimo','repomix','serena','all')]
    [string]$StackProfile = ''
)

$ErrorActionPreference = "Stop"

# === CONFIGURACION DE VERSIONES ===
# Vacio = latest (NO recomendado para produccion).
$ContextModeVersion = ""
$SembleVersion      = "0.6.1"
$PythonVersion      = "3.11"
$RtkVersion         = "0.50.0"
$RtkRepo            = "rtk-ai/rtk"
$RtkInstallDir      = Join-Path $env:USERPROFILE ".local\bin"
$SerenaPythonVersion = "3.13"

# Si no se especifica -StackProfile, instalar los 5 optimizadores (sin exclusividad).
if (-not $StackProfile) { $StackProfile = 'all' }

# === HELPERS ===
function Write-Ok   { param([string]$Msg) Write-Host "  [OK] $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "  [!!] $Msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$Msg) Write-Host "  [XX] $Msg" -ForegroundColor Red }
function Write-Step { param([string]$Id, [string]$Msg) Write-Host ""; Write-Host "[$Id] $Msg" -ForegroundColor Cyan }
function Test-Command { param([string]$Cmd) return [bool](Get-Command $Cmd -ErrorAction SilentlyContinue) }

function New-FileBackup {
    param([Parameter(Mandatory)][string]$Path, [string]$Phase = 'gen')
    if ($SkipBackup) { return $null }
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $bak = "$Path.bak-$Phase-$stamp"
    Copy-Item -LiteralPath $Path -Destination $bak -Force
    Write-Warn "Backup: $bak"
    return $bak
}

function Load-Config {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return [PSCustomObject]@{} }
    $raw = Get-Content $Path -Raw
    $raw = $raw -replace '(?m)^\s*//.*$', ''
    try { return $raw | ConvertFrom-Json } catch { return [PSCustomObject]@{} }
}

function Save-Config {
    param([string]$Path, [object]$Config)
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $Config | ConvertTo-Json -Depth 10 | Out-File $Path -Encoding UTF8
}

function Set-McpEntry {
    param([object]$Config, [string]$Name, [object]$Entry)
    if (-not $Config.PSObject.Properties.Name -contains 'mcp') {
        $Config | Add-Member -NotePropertyName 'mcp' -NotePropertyValue ([PSCustomObject]@{}) -Force
    }
    if ($Config.mcp.PSObject.Properties.Name -contains $Name) {
        $Config.mcp.$Name = $Entry
    } else {
        $Config.mcp | Add-Member -NotePropertyName $Name -NotePropertyValue $Entry -Force
    }
}

function Remove-McpEntry {
    param([object]$Config, [string]$Name)
    if ($Config.mcp -and ($Config.mcp.PSObject.Properties.Name -contains $Name)) {
        $Config.mcp.PSObject.Properties.Remove($Name)
    }
}

function _PluginBase {
    param([string]$Plugin)
    if ([string]::IsNullOrWhiteSpace($Plugin)) { return '' }
    if ($Plugin.StartsWith('@')) {
        $idx = $Plugin.LastIndexOf('@')
        if ($idx -gt 0) { return $Plugin.Substring(0, $idx) }
        return $Plugin
    }
    $idx = $Plugin.IndexOf('@')
    if ($idx -ge 0) { return $Plugin.Substring(0, $idx) }
    return $Plugin
}

function Add-PluginEntry {
    param([object]$Config, [string]$Plugin)
    $base = _PluginBase $Plugin
    $invalid = @('', 'list')
    $existing = @()
    if ($Config.PSObject.Properties.Name -contains 'plugin' -and $null -ne $Config.plugin) {
        $existing = @($Config.plugin | Where-Object {
            $_ -and ($_ -notin $invalid) -and ((_PluginBase $_) -ne $base)
        })
    }
    $newArray = @($existing) + $Plugin
    $Config | Add-Member -NotePropertyName 'plugin' -NotePropertyValue $newArray -Force
}

function Remove-PluginEntry {
    param([object]$Config, [string]$Plugin)
    if ($Config.PSObject.Properties.Name -contains 'plugin' -and $null -ne $Config.plugin) {
        $base = _PluginBase $Plugin
        $new = @($Config.plugin | Where-Object { $_ -and ($_ -ne $Plugin) -and ((_PluginBase $_) -ne $base) })
        if ($new.Count -eq 0) {
            $Config.PSObject.Properties.Remove('plugin')
        } else {
            $Config | Add-Member -NotePropertyName 'plugin' -NotePropertyValue $new -Force
        }
    }
}

function Test-McpExists {
    param([object]$Config, [string]$Name)
    if ($Config -and $Config.mcp -and ($Config.mcp.PSObject.Properties.Name -contains $Name)) { return $true }
    return $false
}

function Test-PluginExists {
    param([object]$Config, [string]$Plugin)
    if (-not ($Config -and $Config.PSObject.Properties.Name -contains 'plugin')) { return $false }
    $base = _PluginBase $Plugin
    foreach ($p in @($Config.plugin)) {
        if (($p -eq $Plugin) -or ((_PluginBase $p) -eq $base)) { return $true }
    }
    return $false
}

function Set-OpencodeJsonFlag {
    param([object]$Config, [string]$Path, [object]$Value)
    $parts = $Path.Split('.')
    $node = $Config
    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        $key = $parts[$i]
        if (-not ($node.PSObject.Properties.Name -contains $key)) {
            $node | Add-Member -NotePropertyName $key -NotePropertyValue ([PSCustomObject]@{}) -Force
        }
        $node = $node.$key
    }
    $leaf = $parts[-1]
    if ($node.PSObject.Properties.Name -contains $leaf) {
        $node.$leaf = $Value
    } else {
        $node | Add-Member -NotePropertyName $leaf -NotePropertyValue $Value -Force
    }
}

function Backup-OpenCode {
    param([string]$ConfigPath, [string]$AgentsPath)
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupDir = Join-Path $env:LOCALAPPDATA "OpenCodeInstaller/backups/$timestamp"
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    if (Test-Path $ConfigPath) { Copy-Item $ConfigPath "$backupDir/opencode.jsonc" -Force }
    if ($AgentsPath -and (Test-Path $AgentsPath)) {
        Copy-Item $AgentsPath "$backupDir/AGENTS.md" -Force
    }
    return $backupDir
}

function Restore-OpenCode {
    param([string]$BackupDir, [string]$ConfigPath, [string]$AgentsPath)
    if ($BackupDir -and (Test-Path "$BackupDir/opencode.jsonc")) {
        Copy-Item "$BackupDir/opencode.jsonc" $ConfigPath -Force
    }
    if ($AgentsPath -and $BackupDir -and (Test-Path "$BackupDir/AGENTS.md")) {
        Copy-Item "$BackupDir/AGENTS.md" $AgentsPath -Force
    }
}

# === RUTAS ===
$projectRoot = $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$ocConfig   = Join-Path $env:USERPROFILE ".config/opencode/opencode.jsonc"
$ocConfigV2 = Join-Path $env:USERPROFILE ".config/opencode/opencode.json"
$ocDir      = Split-Path $ocConfig -Parent
$agentsMd   = Join-Path $ocDir "AGENTS.md"
$ctxDocsDir = Join-Path $ocDir "docs"
$ctxDocsMd  = Join-Path $ctxDocsDir "context-mode.md"
if (-not (Test-Path $ocDir)) { New-Item -ItemType Directory -Path $ocDir -Force | Out-Null }

# === RUTAS RTK ===
$RtkPluginDir  = Join-Path $ocDir "plugin"
$RtkPluginPath = Join-Path $RtkPluginDir "openrtk.ts"
$RtkMdPath     = Join-Path $ocDir "RTK.md"
$RtkConfigDir  = Join-Path $env:APPDATA "rtk"
$RtkConfigPath = Join-Path $RtkConfigDir "config.toml"
$RtkLogPath    = Join-Path $ocDir ("rtk-install-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))

# === RUTAS REPOMIX ===
$RepomixConfigPath = Join-Path $ocDir "repomix.config.json"
$RepomixIgnorePath = Join-Path $ocDir ".repomixignore"

# === CONTENIDO EMBEDIDO: AGENTS.md (reglas minimas) ===
$AGENTS_MD_CONTENT = @'
# Context optimization

Context Mode esta instalado. Respeta su routing y herramientas.

Reglas adicionales del proyecto:
- No vuelques logs, builds, tests o documentacion extensa al contexto si pueden procesarse fuera.
- Para editar codigo, lee solo los archivos necesarios.
- Evita repetir lecturas y busquedas ya resueltas.
- Prioriza correccion y evidencia sobre ahorro de tokens.
- La politica y los resultados internos estan documentados en docs/context-mode.md.
'@

# === CONTENIDO EMBEBIDO: Integracion V2 de Klia (mcp.servers + AGENTS.md) ===
# Razon: OpenCode V2 no aplica `systemPrompt` (V1) ni `instructions` (no-op). El MCP
# debe registrarse en `mcp.servers` y la instruccion de routing vivir en AGENTS.md.
$KLIA_ROUTER_AGENTS_BLOCK = @'
<!-- KLIA_ROUTER_START -->
## Enrutado de contexto (Klia) — OpenCode V2

Solo para tareas que impliquen contexto grande, busqueda en el repositorio, salida de
terminal abundante o varios pasos:

1. Llama UNA sola vez a la herramienta `route_task` de klia-token-optimizer, con model,
   query, fileCount y contextSizeBytes.
2. APLICA el optimizador devuelto, no te limites a informarlo:
   - SEMBLE: busca los fragmentos relevantes en vez de leer archivos completos.
   - REPOMIX: usa el empaquetado (solo firmas/estructura) en vez de leer todo el arbol.
   - CONTEXT_MODE: consulta el indice en vez de volcar documentos completos.
   - RTK: canaliza los comandos con salida grande.
   - BASELINE: procede con normalidad.

No llames a `route_task` para cambios triviales de una linea ni preguntas cortas.
<!-- KLIA_ROUTER_END -->
'@

# === CONTENIDO EMBEDIDO: Bloque SEMBLE para AGENTS.md ===
$SEMbleRoutingBlock = @'
<!-- SEMBLE_START -->
## Semble Code Search

A `semble` MCP server is available with two tools:
- `mcp__semble__search` - search the codebase with a natural-language or code query.
- `mcp__semble__find_related` - find code similar to a specific file and line.

Use `mcp__semble__search` to find where something is implemented - instead of using Grep or Glob to discover files. After semble returns the file and line, navigate there directly and read that file. Do not grep for the same content again.

Pass `content="docs"` to the MCP search tool for documentation and prose, `content="config"` for config files, or `content="all"` for everything.

For CLI fallback or sub-agents without MCP access, use:

```bash
semble search "authentication flow" ./my-project --max-snippet-lines 10
semble search "deployment guide" ./my-project --content docs
semble search "database host port" ./my-project --content config
semble find-related src/auth.py 42 ./my-project
semble search "save model to disk" ./my-project --top-k 10
```

The index is built on first run and cached automatically. If `semble` is not on `$PATH`, use `uvx --from "semble[mcp]==__SEMVER__" semble`.

### Routing obligatorio (prioridad descendente)

1. Buscar donde se implementa algo -> `mcp__semble__search` (NUNCA grep/glob para descubrir archivos)
2. Buscar docs/config (no codigo) -> `mcp__semble__search` con `content="docs"` o `content="config"`
3. Encontrar codigo similar a una ubicacion -> `mcp__semble__find_related`
4. Buscar TODAS las ocurrencias de un literal exacto (rename, callers) -> `grep` (unico caso valido para grep)
5. Leer un archivo ya localizado por parece -> `Read` directo al `file:line` retornado (NO re-buscar)

### Prohibido

- Usar `grep` o `glob` para descubrir donde esta una implementacion
- Leer archivos completos para "explorar" - parece retorna solo el chunk relevante (~99% menos tokens)
- Re-buscar contenido ya encontrado por parece

### Flujo obligatorio

parece search -> file:line -> Read solo esa funcion/clase -> Edit

Antes de cualquier `grep` o `Read` de exploracion, preguntarse: puede parece hacer esto? Si si, usar parece.

### Workflow

1. Call `mcp__semble__search` with a query describing what the code does or its name.
2. Navigate directly to the top result's file and line. Read only the function or class at that location.
3. Make the edit. Do not re-search or grep for the same content.
4. Set the MCP search tool's `content` field to `docs`, `config`, or `all` when searching beyond code.
5. Optionally use `mcp__semble__find_related` with `file_path`, `line`, and the same `content` selection.
6. Use Grep only when you need every occurrence of a literal string across the whole repo.
<!-- SEMBLE_END -->
'@ -replace '__SEMVER__', $SembleVersion

# === CONTENIDO EMBEDIDO: Sub-agente parece-search.md ===
$SEMbleSubAgentContent = @'
---
description: Code search agent for exploring any codebase. Use for finding code by intent, locating implementations, understanding how something works, or discovering related code. Prefer over Bash/Read for any semantic or exploratory question.
tools:
  - mcp__semble__search
  - mcp__semble__find_related
  - Read
  - Grep
  - Glob
  - Bash
---

You are a code search agent. Your primary tool is `mcp__semble__search` for semantic code search.

## Workflow

1. Use `mcp__semble__search` with a query describing what the code does or its name.
2. Navigate to the top result's file and line using Read.
3. Read only the function or class at that location.
4. Return the file path and line number to the caller.

## When to use parece search

- Finding where something is implemented
- Finding code by description ("authentication flow", "database save logic")
- Finding similar code to a given file (use `mcp__semble__find_related`)

## When NOT to use parece search

- Finding all occurrences of a literal string (use Grep)
- Reading a file you already know the path to (use Read directly)

## Content selection

Pass `content="docs"` for documentation, `content="config"` for config files, or `content="all"` for everything.
'@

# === CONTENIDO EMBEDIDO: .sembleignore template ===
$SEMbleIgnoreTemplate = @'
# .sembleignore - excluye archivos del indice de parece
# Copia este archivo a la raiz del proyecto y ajusta segun necesidad.

# Directorios generados
generated/
dist/
build/
node_modules/
.venv/
__pycache__/
.pytest_cache/

# Archivos generados/minificados
*.pb.go
*.min.js
*.min.css
*.map
*.lock
package-lock.json
yarn.lock

# Binarios
*.exe
*.dll
*.so
*.dylib
*.pyc
'@

# === CONTENIDO EMBEDIDO: docs/context-mode.md (politica + benchmark) ===
# Nota: documento de referencia humana. OpenCode NO lo carga automaticamente.
# Las reglas ejecutables viven en AGENTS.md. Este doc contiene el benchmark.
$CTX_MODE_DOC_CONTENT = @'
# Politica de Context Mode

> Documentacion humana de referencia. OpenCode NO carga este archivo
> automaticamente. Las reglas ejecutables viven en `AGENTS.md`; este
> documento contiene el benchmark, la politica y las excepciones.

## Evidencia interna (benchmark)

| Fase | Descripcion              | OFF      | ON      | Ahorro  | Tiempo OFF/ON | Lectura |
|------|--------------------------|---------|---------|---------|---------------|---------|
| 5    | Prueba principal de log  | 87.821  | 18.921  | 78,4%   | 179/152 s     | PASS    |
| 6    | Calidad                  | 16.446  | 14.260  | 13,3%   | 131/300 s     | PASS    |
| 7    | Repositorio de codigo    | 20.169  | 23.842  | -18,2%  | 101/636 s     | REVIEW  |
| 10   | Sesion larga             | 246.838 | 48.537  | 80,3%   | 855/160 s     | PASS    |
| 16a  | Contenido de 50 KB       | 19.388  | 21.829  | -12,6%  | 126/142 s     | REVIEW  |
| 16b  | Contenido de 250 KB      | 26.199  | 22.703  | 13,3%   | 141/155 s     | PASS    |
| 16c  | Contenido de 1 MB        | 20.388  | 9.544   | 53,2%   | 145/82 s      | PASS    |
| 16d  | Contenido de 5 MB        | 49.831  | 28.108  | 43,6%   | 300/100 s     | PASS    |
| 17   | Historial Git            | 33.312  | 44.336  | -33,1%  | 134/143 s     | REVIEW  |
| 18   | Logs de 50K              | 16.703  | 10.744  | 35,7%   | 133/112 s     | PASS    |
| 19   | Documentacion de 500 KB  | 21.869  | 70.419  | -222,0% | 195/230 s     | REVIEW  |
| 20   | Tests                    | 35.448  | 19.815  | 44,1%   | 104/98 s      | PASS    |

## Interpretacion

Context Mode no ahorra por el simple hecho de estar instalado. Ahorra
cuando cambia el patron de trabajo:

- en vez de leer un archivo completo, busca fragmentos;
- en vez de devolver miles de lineas, calcula un agregado;
- en vez de repetir el contenido en cada turno, lo consulta desde un indice;
- en vez de realizar muchos round-trips, concentra el analisis.

El peor caso (documentacion de 500 KB, Fase 19) demuestra que cargar o
procesar el contenido de forma ineficiente puede generar mas contexto que
la linea base. El plugin debe utilizarse con instrucciones explicitas y
con resultados resumidos.

## Datos empiricos

- Ahorro agregado inicial: ~42%.
- Overhead observado: ~950 tokens/turno.
- Beneficio fuerte: sesiones largas y contenido extenso.
- Umbral empirico inicial: ~250 KB (dato, no regla universal).
- Caso Fase 19: -222% por estrategia inadecuada del modelo.

## Usar preferentemente cuando

- la salida potencial sea grande;
- se analicen logs/tests/builds/diffs extensos;
- se procese documentacion o datos grandes;
- la sesion acumule multiple turnos;
- sea util indexar y recuperar fragmentos.

## Evitar sobreuso cuando

- la operacion tiene salida pequena y conocida;
- es una edicion puntual que requiere leer pocas lineas;
- el coste de indexar supera al de resolver directamente.

## Regla de calidad

Nunca sacrificar correccion para ahorrar tokens.

## Herramientas por situacion

| Situacion                              | Estrategia preferida              | Motivo                                  |
|----------------------------------------|-----------------------------------|-----------------------------------------|
| Editar archivo concreto                | Read/view del minimo necesario     | Necesita texto exacto para editar       |
| Analizar archivo grande                 | ctx_execute_file                   | Procesa fuera del contexto              |
| Comando con salida potencialmente grande| ctx_execute                        | Evita inundar el contexto               |
| Varias operaciones I/O                 | ctx_batch_execute                  | Agrupa y controla resultados             |
| Contenido que debe quedar consultable  | ctx_index                          | Lo almacena en el indice                 |
| Recuperar informacion indexada          | ctx_search                         | Trae fragmentos relevantes               |
| Web/contenido remoto grande            | ctx_fetch_and_index + busqueda     | Evita introducir HTML bruto             |
| Operacion garantizadamente pequena      | Herramienta normal                 | Evita overhead innecesario              |

## Arbol de decision

```
?La salida puede ser grande?
 +-- NO -> herramienta normal
 +-- SI
     |
     v
 ?Necesito editar texto exacto?
 +-- SI -> localizar y leer solo lo necesario
 +-- NO
     |
     v
 ?Es archivo/dato local grande?
 +-- SI -> ctx_execute_file / ctx_execute
 +-- NO
     |
     v
 ?Necesito recuperar fragmentos repetidamente?
 +-- SI -> ctx_index + ctx_search
 +-- NO -> procesar y devolver solo resultado
```

## Evitar repetir la Fase 19 (-222%)

El objetivo es detectar si el modelo esta evitando el indice o haciendo
lecturas masivas. La solucion no es ocultar el caso negativo: es
convertirlo en prueba de regresion.

- Repetir Fase 19 varias veces con la misma version y fixture.
- Registrar la secuencia completa de tool calls.
- Comprobar si usa ctx_index/ctx_search o lectura directa masiva.
- Registrar bytes recuperados y tokens de entrada/salida/cache.
- Comparar calidad de la respuesta, no solo tokens.

Criterio: si Context Mode solo ahorra porque la respuesta es peor o
incompleta, la prueba no es PASS.

## Politica de versiones para empresa

- No desplegar `latest` directamente a todos los empleados.
- Fijar una combinacion certificada: OpenCode + Node + Context Mode + modelo/KLIA.
- Probar una actualizacion en laboratorio.
- Ejecutar benchmark corto de regresion.
- Ejecutar Fase 19 especificamente.
- Si pasa, piloto con pocos usuarios.
- Solo despues desplegar al resto.
- Conservar rollback a la version anterior.

## Checklist final

- [ ] OpenCode funciona antes de Context Mode.
- [ ] Node cumple el requisito de version (>= 22.5).
- [ ] Existe backup de configuracion.
- [ ] `plugin: ["context-mode"]` esta registrado.
- [ ] No existe un `mcp.context_mode` legacy duplicado.
- [ ] OpenCode se reinicio.
- [ ] `ctx stats` responde.
- [ ] `ctx doctor` no muestra fallos relevantes.
- [ ] FTS5/index/search funcionan.
- [ ] `docs/context-mode.md` contiene la politica interna.
- [ ] `AGENTS.md` solo contiene reglas minimas necesarias.
- [ ] Benchmark de regresion completado.
- [ ] Calidad no empeora.
- [ ] Rollback probado.
'@

# === HELPERS SEMBLE ===
function Test-SembleMcpEntry {
    param([object]$Config)
    if ($Config.mcp -and $Config.mcp.PSObject.Properties.Name -contains 'semble') { return $true }
    return $false
}

function Test-SembleBlockInAgents {
    if (-not (Test-Path $agentsMd)) { return $false }
    $content = Get-Content $agentsMd -Raw
    return ($content -match '(?s)<!-- SEMBLE_START -->.*?<!-- SEMBLE_END -->')
}

function Test-SembleSubAgent {
    $subAgentPath = Join-Path $ocDir "agents/semble-search.md"
    return (Test-Path $subAgentPath)
}

function Extract-SembleBlock {
    if (-not (Test-Path $agentsMd)) { return "" }
    $content = Get-Content $agentsMd -Raw
    if ($content -match '(?s)(<!-- SEMBLE_START -->.*?<!-- SEMBLE_END -->)') {
        return $Matches[1]
    }
    return ""
}

function Inject-SembleRoutingBlock {
    if (-not (Test-Path $agentsMd)) {
        $SEMbleRoutingBlock | Out-File $agentsMd -Encoding UTF8
        return
    }
    $content = Get-Content $agentsMd -Raw
    $pattern = '(?s)(<!-- SEMBLE_START -->).*?(<!-- SEMBLE_END -->)'
    if ($content -match $pattern) {
        $match = [regex]::Match($content, $pattern)
        $before = $content.Substring(0, $match.Index)
        $after = $content.Substring($match.Index + $match.Length)
        $content = $before + $SEMbleRoutingBlock.Trim() + $after
    } else {
        $content = $content.TrimEnd() + "`n`n" + $SEMbleRoutingBlock
    }
    $content | Out-File $agentsMd -Encoding UTF8
}

function Create-SembleSubAgent {
    $agentsDir = Join-Path $ocDir "agents"
    if (-not (Test-Path $agentsDir)) { New-Item -ItemType Directory -Path $agentsDir -Force | Out-Null }
    $subAgentPath = Join-Path $agentsDir "semble-search.md"
    $SEMbleSubAgentContent | Out-File $subAgentPath -Encoding UTF8
}

function Create-SembleIgnoreTemplate {
    $ignorePath = Join-Path $env:USERPROFILE ".sembleignore"
    if (Test-Path $ignorePath) {
        Write-Ok ".sembleignore ya existe en $env:USERPROFILE"
        return
    }
    $SEMbleIgnoreTemplate | Out-File $ignorePath -Encoding UTF8
    Write-Ok ".sembleignore template creado en $ignorePath"
}

function Invoke-SembleSmokeTest {
    Write-Step "SEMBLE" "Prueba de humo"
    if (-not (Test-Command "semble")) {
        Write-Warn "semble no esta en PATH. Saltando prueba de humo."
        return
    }
    try {
        $ver = & semble --version 2>&1
        Write-Ok "semble --version: $ver"
    } catch {
        Write-Warn "semble --version fallo: $($_.Exception.Message)"
        return
    }
    Write-Host "  Ejecutando busqueda de prueba..." -ForegroundColor Cyan
    try {
        & semble search "configuration" $ocDir --max-snippet-lines 5 --top-k 2 2>&1 | Out-Host
        if ($LASTEXITCODE -eq 0) { Write-Ok "Busqueda de prueba OK" }
        else { Write-Warn "Busqueda de prueba fallo (no critico)" }
    } catch {
        Write-Warn "Busqueda de prueba fallo (no critico): $($_.Exception.Message)"
    }
}

# === CONTENIDO EMBEDIDO: plugin/openrtk.ts (version parcheada) ===
# NO usar `rtk init -g --opencode`: tiene bug ESM upstream. Esta version inlinea rewrite().
$RTK_PLUGIN_CONTENT = @'
// openrtk (Rust Token Killer) - local patched copy.
// Auto-discovered by opencode (any *.ts in plugin/). Inlines rewrite.js to
// avoid the upstream ESM extensionless-import bug.
// Hooks tool.execute.before for bash/shell tools and rewrites supported
// commands to route through the `rtk` binary for output compression.
// Auto-disables itself if `rtk` is not on PATH.

const ENV_PREFIX_RE = /^([A-Za-z_][A-Za-z0-9_]*=[^ ]* +)+/;

const RULES: Array<[RegExp, (c: string) => string]> = [
    [/^git\s+status(\s|$)/, (c) => c.replace(/^git status/, "rtk git status")],
    [/^git\s+diff(\s|$)/, (c) => c.replace(/^git diff/, "rtk git diff")],
    [/^git\s+log(\s|$)/, (c) => c.replace(/^git log/, "rtk git log")],
    [/^git\s+add(\s|$)/, (c) => c.replace(/^git add/, "rtk git add")],
    [/^git\s+commit(\s|$)/, (c) => c.replace(/^git commit/, "rtk git commit")],
    [/^git\s+push(\s|$)/, (c) => c.replace(/^git push/, "rtk git push")],
    [/^git\s+pull(\s|$)/, (c) => c.replace(/^git pull/, "rtk git pull")],
    [/^git\s+branch(\s|$)/, (c) => c.replace(/^git branch/, "rtk git branch")],
    [/^git\s+fetch(\s|$)/, (c) => c.replace(/^git fetch/, "rtk git fetch")],
    [/^git\s+stash(\s|$)/, (c) => c.replace(/^git stash/, "rtk git stash")],
    [/^git\s+show(\s|$)/, (c) => c.replace(/^git show/, "rtk git show")],
    [/^gh\s+(pr|issue|run|api|release)(\s|$)/, (c) => c.replace(/^gh /, "rtk gh ")],
    [/^cargo\s+test(\s|$)/, (c) => c.replace(/^cargo test/, "rtk cargo test")],
    [/^cargo\s+build(\s|$)/, (c) => c.replace(/^cargo build/, "rtk cargo build")],
    [/^cargo\s+clippy(\s|$)/, (c) => c.replace(/^cargo clippy/, "rtk cargo clippy")],
    [/^cargo\s+check(\s|$)/, (c) => c.replace(/^cargo check/, "rtk cargo check")],
    [/^cargo\s+install(\s|$)/, (c) => c.replace(/^cargo install/, "rtk cargo install")],
    [/^cargo\s+fmt(\s|$)/, (c) => c.replace(/^cargo fmt/, "rtk cargo fmt")],
    [/^cat\s+/, (c) => c.replace(/^cat /, "rtk read ")],
    [/^(rg|grep)\s+/, (c) => c.replace(/^(rg|grep) /, "rtk grep ")],
    [/^ls(\s|$)/, (c) => c.replace(/^ls/, "rtk ls")],
    [/^tree(\s|$)/, (c) => c.replace(/^tree/, "rtk tree")],
    [/^find\s+/, (c) => c.replace(/^find /, "rtk find ")],
    [/^diff\s+/, (c) => c.replace(/^diff /, "rtk diff ")],
    [/^(pnpm\s+)?(npx\s+)?vitest(\s|$)/, (c) => c.replace(/^(pnpm )?(npx )?vitest( run)?/, "rtk vitest run")],
    [/^pnpm\s+test(\s|$)/, (c) => c.replace(/^pnpm test/, "rtk vitest run")],
    [/^npm\s+test(\s|$)/, (c) => c.replace(/^npm test/, "rtk npm test")],
    [/^npm\s+run\s+/, (c) => c.replace(/^npm run /, "rtk npm ")],
    [/^(npx\s+)?vue-tsc(\s|$)/, (c) => c.replace(/^(npx )?vue-tsc/, "rtk tsc")],
    [/^pnpm\s+tsc(\s|$)/, (c) => c.replace(/^pnpm tsc/, "rtk tsc")],
    [/^(npx\s+)?tsc(\s|$)/, (c) => c.replace(/^(npx )?tsc/, "rtk tsc")],
    [/^pnpm\s+lint(\s|$)/, (c) => c.replace(/^pnpm lint/, "rtk lint")],
    [/^(npx\s+)?eslint(\s|$)/, (c) => c.replace(/^(npx )?eslint/, "rtk lint")],
    [/^(npx\s+)?prettier(\s|$)/, (c) => c.replace(/^(npx )?prettier/, "rtk prettier")],
    [/^(npx\s+)?playwright(\s|$)/, (c) => c.replace(/^(npx )?playwright/, "rtk playwright")],
    [/^pnpm\s+playwright(\s|$)/, (c) => c.replace(/^pnpm playwright/, "rtk playwright")],
    [/^(npx\s+)?prisma(\s|$)/, (c) => c.replace(/^(npx )?prisma/, "rtk prisma")],
    [/^docker\s+compose(\s|$)/, (c) => c.replace(/^docker /, "rtk docker ")],
    [/^docker\s+(ps|images|logs|run|build|exec)(\s|$)/, (c) => c.replace(/^docker /, "rtk docker ")],
    [/^kubectl\s+(get|logs|describe|apply)(\s|$)/, (c) => c.replace(/^kubectl /, "rtk kubectl ")],
    [/^curl\s+/, (c) => c.replace(/^curl /, "rtk curl ")],
    [/^wget\s+/, (c) => c.replace(/^wget /, "rtk wget ")],
    [/^pnpm\s+(list|ls|outdated)(\s|$)/, (c) => c.replace(/^pnpm /, "rtk pnpm ")],
    [/^pytest(\s|$)/, (c) => c.replace(/^pytest/, "rtk pytest")],
    [/^python\s+-m\s+pytest(\s|$)/, (c) => c.replace(/^python -m pytest/, "rtk pytest")],
    [/^ruff\s+(check|format)(\s|$)/, (c) => c.replace(/^ruff /, "rtk ruff ")],
    [/^pip\s+(list|outdated|install|show)(\s|$)/, (c) => c.replace(/^pip /, "rtk pip ")],
    [/^uv\s+pip\s+(list|outdated|install|show)(\s|$)/, (c) => c.replace(/^uv pip /, "rtk pip ")],
    [/^go\s+test(\s|$)/, (c) => c.replace(/^go test/, "rtk go test")],
    [/^go\s+build(\s|$)/, (c) => c.replace(/^go build/, "rtk go build")],
    [/^go\s+vet(\s|$)/, (c) => c.replace(/^go vet/, "rtk go vet")],
    [/^golangci-lint(\s|$)/, (c) => c.replace(/^golangci-lint/, "rtk golangci-lint")],
    [/^mix\s+phx\.routes(\s|$)/, (c) => c.replace(/^mix phx\.routes/, "rtk --cache mix phx.routes")],
    [/^mix\s+ash\.info(\s|$)/, (c) => c.replace(/^mix ash\.info/, "rtk --cache mix ash.info")],
    [/^mix\s+test(\s|$)/, (c) => c.replace(/^mix test/, "rtk test mix test")],
    [/^mix\s+credo(\s|$)/, (c) => c.replace(/^mix credo/, "rtk lint mix credo")],
    [/^mix\s+format(\s|$)/, (c) => c.replace(/^mix format/, "rtk format mix format")],
    [/^mix\s+dialyzer(\s|$)/, (c) => c.replace(/^mix dialyzer/, "rtk err mix dialyzer")],
    [/^mix\s+compile(\s|$)/, (c) => c.replace(/^mix compile/, "rtk mix compile")],
    [/^mix\s+ecto\.(migrate|migrations)(\s|$)/, (c) => c.replace(/^mix ecto\.(migrate|migrations)/, "rtk mix ecto.$1")],
    [/^mix\s+help(\s|$)/, (c) => c.replace(/^mix help/, "rtk --cache mix help")],
    [/^mix\s+/, (c) => c.replace(/^mix /, "rtk mix ")],
    [/^iex\s+/, (c) => c.replace(/^iex /, "rtk iex ")],
];

function rewrite(command: string): string | null {
    if (typeof command !== "string") return null;
    if (/^(.*\/)?rtk\s/.test(command)) return null;
    if (command.indexOf("<<") !== -1) return null;
    const envMatch = command.match(ENV_PREFIX_RE);
    const envPrefix = envMatch ? envMatch[0] : "";
    const body = envPrefix ? command.slice(envPrefix.length) : command;
    for (const [pattern, rewriter] of RULES) {
        if (pattern.test(body)) { return envPrefix + rewriter(body); }
    }
    return null;
}

export const rtkPlugin = async ({ $ }: { $: any }) => {
    try { await $`which rtk`.quiet(); }
    catch { console.warn("[openrtk] rtk binary not found in PATH - plugin disabled"); return {}; }
    return {
        "tool.execute.before": async (input: any, output: any) => {
            const tool = String(input?.tool ?? "").toLowerCase();
            if (tool !== "bash" && tool !== "shell") return;
            const args = output?.args;
            if (!args || typeof args !== "object") return;
            const command = args.command;
            const rewritten = rewrite(command);
            if (rewritten) { args.command = rewritten; }
        },
    };
};

export default rtkPlugin;
'@

# === CONTENIDO EMBEDIDO: RTK.md ===
$RTK_MD_CONTENT = @'
# RTK.md - rtk (Rust Token Killer) en opencode

## Que hace rtk
rtk es un **proxy CLI** que intercepta comandos (git, npm, cargo, pytest, docker,
etc.) y comprime su salida antes de que llegue al LLM. Ahorro historico: 92%
(10.6M tokens en 684 comandos). NO busca codigo (eso es parece) ni empaqueta
repos (eso es repomix). Filtra ruido de salida de comandos.

## Como funciona en opencode
- El plugin `plugin/openrtk.ts` hookea `tool.execute.before` para bash/shell.
- Reescribe comandos soportados: `git status` -> `rtk git status`.
- Auto-se-deshabilita si `rtk` no esta en PATH (safe to leave installed).
- Transparente: no requiere accion manual.

## Comandos cubiertos por rtk (automatico)
- git status/diff/log/add/commit/push/pull/branch/fetch/stash/show
- gh pr/issue/run/api/release
- cargo test/build/clippy/check/install/fmt
- cat, grep, rg, ls, tree, find, diff
- vitest, npm test, npm run, tsc, eslint, prettier, playwright, prisma
- docker compose/ps/images/logs/run/build/exec
- kubectl get/logs/describe/apply
- curl, wget, pnpm list/ls/outdated
- pytest, ruff check/format, pip list/outdated/install/show
- go test/build/vet, golangci-lint
- mix (Elixir/Phoenix/Ash)

## Comandos utiles de rtk
| Comando | Para que |
|---|---|
| `rtk gain` | Ver ahorro historico de tokens |
| `rtk config` | Ver/modificar configuracion |
| `rtk recall <hash>` | Recuperar salida que rtk elidio |
| `rtk smart <cmd>` | Resumen de 2 lineas de un comando |
| `rtk err <cmd>` | Mostrar solo errores/warnings |
| `rtk test <cmd>` | Mostrar solo fallos de tests |
| `rtk summary <cmd>` | Resumen heuristico |

## Configuracion
- Config: `%APPDATA%\rtk\config.toml`
- Filtros: excluye .git, node_modules, target, __pycache__, .venv, vendor
- Tracking: 90 dias de historial
- Recall: sqlite (recomendado sobre tee legacy)

## NO reinstalar con rtk init
No ejecutar `rtk init -g --opencode`: tiene bug ESM upstream y sobreescribiria
el plugin parcheado. Restaurar desde backup o re-ejecutar este instalador.
'@

# === CONTENIDO EMBEDIDO: bloque RTK_START/END para AGENTS.md ===
$RTK_ROUTING_BLOCK = @'
<!-- RTK_START -->
## rtk (Rust Token Killer) - proxy de compresion de salida CLI

> Instrucciones detalladas en `RTK.md`. Esta seccion es el routing ejecutable.

### Que hace rtk
rtk intercepta comandos CLI (git, npm, cargo, pytest, docker, etc.) y comprime
su salida antes de que llegue al LLM. Ahorro historico: 92% (10.6M tokens en
684 comandos). Transparente: no requiere accion manual.

### Como funciona en opencode
- El plugin `plugin/openrtk.ts` hookea `tool.execute.before` para bash/shell.
- Reescribe comandos soportados: `git status` -> `rtk git status`.
- Auto-se-deshabilita si rtk no esta en PATH (safe to leave installed).

### Cuando rtk actua (automatico, no hay que invocarlo)
- git status/diff/log/add/commit/push/pull/branch/fetch/stash/show
- gh pr/issue/run/api/release
- cargo test/build/clippy/check/install/fmt
- cat, grep, rg, ls, tree, find, diff
- vitest, npm test, npm run, tsc, eslint, prettier, playwright, prisma
- docker compose/ps/images/logs/run/build/exec
- kubectl get/logs/describe/apply
- curl, wget, pnpm list/ls/outdated
- pytest, ruff check/format, pip list/outdated/install/show
- go test/build/vet, golangci-lint
- mix (Elixir/Phoenix/Ash)

### Cuando rtk NO aplica
- Buscar donde se implementa algo en codigo -> usar parece
- Vision global del repo -> usar repomix --compress
- Leer un archivo especifico -> usar Read directo
- Buscar todas las ocurrencias de un literal -> usar grep (rtk lo filtra)

### Routing anti-solapamiento
- rtk comprime salida de comandos CLI (git, npm, cargo, etc.)
- parece busca codigo (devuelve fragmentos relevantes)
- repomix empaqueta el repo completo (XML o signatures)
- context-mode indexa docs/APIs para recuperacion FTS5
- grep busca literales exactos (para renames/callers)

### Comandos utiles de rtk
| Comando | Para que |
|---|---|
| `rtk gain` | Ver ahorro historico de tokens |
| `rtk config` | Ver/modificar configuracion |
| `rtk recall <hash>` | Recuperar salida que rtk elidio |
| `rtk smart <cmd>` | Resumen de 2 lineas de un comando |
| `rtk err <cmd>` | Mostrar solo errores/warnings |
| `rtk test <cmd>` | Mostrar solo fallos de tests |

### Configuracion
- Config: `%APPDATA%\rtk\config.toml`
- Filtros: excluye .git, node_modules, target, __pycache__, .venv, vendor
- Tracking: 90 dias de historial

### NO reinstalar con rtk init
No ejecutar `rtk init -g --opencode`: tiene bug ESM upstream y sobreescribiria
el plugin parcheado. Restaurar desde backup o re-ejecutar este instalador.
<!-- RTK_END -->
'@

# === CONTENIDO EMBEDIDO: config.toml de rtk ===
$RTK_CONFIG_CONTENT = @'
[tracking]
enabled = true
history_days = 90

[display]
colors = true
emoji = true
max_width = 120

[filters]
ignore_dirs = [
    ".git",
    "node_modules",
    "target",
    "__pycache__",
    ".venv",
    "vendor",
]
'@

# === CONTENIDO EMBEDIDO: repomix.config.json (defaults) ===
$RepomixConfigContent = @'
{
  "output": {
    "style": "xml",
    "headerText": "Empaquetado por repomix",
    "removeComments": false,
    "showLineNumbers": true,
    "topFilesLength": 10
  },
  "include": [
    "**/*"
  ],
  "ignore": {
    "useGitignore": true,
    "useDefaultPatterns": true,
    "customPatterns": [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/coverage/**",
      "**/*.log",
      "**/package-lock.json",
      "**/yarn.lock"
    ]
  }
}
'@

# === CONTENIDO EMBEDIDO: bloque REPOMIX en AGENTS.md (routing) ===
$REPOMIX_ROUTING_BLOCK = @'
<!-- REPOMIX_START -->
## Repomix - empaquetador de repos (NO buscador)

### Cuando USAR repomix
- Vision global del repo: "dame la estructura completa en signatures"
- Empaquetar el repo para enviar a un LLM externo
- Entender la arquitectura completa de un proyecto desconocido

### Cuando NO usar repomix
- Buscar donde se implementa algo -> usar parece (97.8% ahorro)
- Leer un archivo especifico -> usar Read directo
- Buscar todas las ocurrencias de un literal -> usar grep
- Recordar decisiones/errores de sesion -> usar ctx_search

### Modos de repomix
| Modo | Comando | Cuando |
|---|---|---|
| Sin compress | pack_codebase (sin --compress) | Codigo completo, enviar a LLM externo |
| Con compress | pack_codebase --compress | Solo signatures, vision global rapida |

### Routing anti-solapamiento
- repomix NO busca - empaqueta TODO el repo
- parece busca - devuelve SOLO el chunk relevante
- context-mode indexa - para recuperacion repetida de docs/APIs
- grep busca literales - para renames y callers

### Flujo recomendado
1. Buscar donde se implementa algo? -> parece
2. Vision global del repo? -> repomix --compress
3. Empaquetar para LLM externo? -> repomix sin compress
4. Leer un archivo ya localizado? -> Read directo

### Jerarquia de herramientas (resumen)
| Pregunta | Herramienta |
|---|---|
| Donde se implementa X? | parece |
| Como es el repo entero? | repomix --compress |
| Dame todo el codigo | repomix sin compress |
| Lee este archivo | Read |
| Encuentra todas las ocurrencias de 'fooBar' | grep |
| Que decidimos antes? | ctx_search (context-mode) |

### Benchmark de referencia
| Herramienta | Tokens | Ahorro vs baseline | Caso de uso |
|---|---|---|---|
| Baseline (grep+read) | 214,374 | 0% | Referencia |
| parece (5 busquedas) | 4,735 | 97.8% | Buscar donde se implementa algo |
| repomix sin --compress | 21,216 | 52.6% | Empaquetar repo completo |
| repomix con --compress | 16,111 | 64% | Vision global en signatures |

- parece = buscador: escribes una pregunta, devuelve solo el fragmento relevante
- repomix = empaquetador: no busca, te da todo el repo en un solo archivo
- No compiten: cada uno brilla en su caso de uso
<!-- REPOMIX_END -->
'@

# === CONTENIDO EMBEDIDO: .repomixignore global ===
$REPOMIX_IGNORE_CONTENT = @'
node_modules/**
mcp/**
.git/**
logs/**
metrics/**
cache/**
*.bak*
*.before-*
*.backup*
package-lock.json
pnpm-lock.yaml
yarn.lock
'@

# === CONTENIDO EMBEDIDO: Bloque de routing SERENA en AGENTS.md ===
$SERENA_ROUTING_BLOCK = @'
<!-- SERENA_START -->
## Serena - IDE semantico para codigo (MCP)

### Que es Serena
Serena es un MCP toolkit que provee operaciones estructurales tipo IDE
sobre el codigo: find_symbol, find_references, rename_symbol, get_document_symbols.
Usa language servers (LSP) para entender la estructura del codigo.

### Cuando USAR Serena
- Encontrar la definicion de un simbolo (clase, funcion, metodo) -> find_symbol
- Listar todas las referencias a un simbolo -> find_references
- Renombrar un simbolo en todo el codebase -> rename_symbol
- Obtener la estructura de un archivo (clases, metodos, campos) -> get_document_symbols
- Obtener detalles de un simbolo (parametros, retorno, docstring) -> get_symbol_details

### Cuando NO usar Serena (usar otra herramienta)
- Buscar donde se implementa algo (pregunta en lenguaje natural) -> parece (97.8% ahorro)
- Vision global del repo (estructura completa en signatures) -> repomix --compress
- Empaquetar el repo para un LLM externo -> repomix sin compress
- Buscar todas las ocurrencias de un literal exacto -> grep
- Leer un archivo ya localizado -> Read directo
- Recordar decisiones/erroles de sesion -> ctx_search (context-mode)

### Routing anti-solapamiento (Serena vs Semble)
- Serena = IDE estructural: "dame la definicion de Foo", "quien llama a bar()"
  Devuelve el simbolo exacto y sus referencias (preciso, LSP-grade).
- Semble = buscador semantico: "donde se maneja la autenticacion?"
  Devuelve solo el chunk relevante (97.8% ahorro vs lectura completa).
- NO compiten: Serena para operaciones estructurales, Semble para descubrimiento
  en lenguaje natural.

### Jerarquia de herramientas (resumen actualizado)
| Pregunta | Herramienta |
|---|---|
| Donde se implementa X? (NL) | parece |
| Dame la definicion de la clase Foo | serena find_symbol |
| Quien llama a la funcion bar? | serena find_references |
| Renombrar X a Y en todo el repo | serena rename_symbol |
| Como es el repo entero? | repomix --compress |
| Dame todo el codigo | repomix sin compress |
| Lee este archivo | Read |
| Encuentra todas las ocurrencias de 'fooBar' | grep |
| Que decidimos antes? | ctx_search (context-mode) |

### Configuracion
- MCP server: `serena start-mcp-server --context ide`
- Context: `ide` (cliente terminal, no plugin JetBrains)
- El server se inicia como subprocess del cliente (stdio)
<!-- SERENA_END -->
'@

# ====================================================================
# FUNCIONES INSTALL/UNINSTALL SEMBLE
# ====================================================================

function Install-Semble {
    Write-Step "SEMBLE" "Instalando Semble (configuracion global)"

    if (-not (Test-Command "uv")) {
        Write-Err "uv no encontrado. Asegurate de tener uv instalado (lo instala la fase de Serena o manualmente)."
        return $false
    }
    Write-Ok "uv detectado"
    try {
        $pyVer = & uv python list --only-installed 2>&1 | Select-Object -First 1
        Write-Host "  Python disponible: $pyVer" -ForegroundColor DarkGray
    } catch { Write-Warn "No se pudo listar version de Python (no critico)" }

    $venvPath = Join-Path $env:LOCALAPPDATA "OpenCodeInstaller/semble-venv"
    if (Test-Path $venvPath) {
        Write-Warn "Eliminando venv legacy de Semble: $venvPath"
        Remove-Item -Recurse -Force $venvPath
    }

    # Pre-check: si parece ya funciona, saltar instalacion
    $sembleAlreadyOk = $false
    if (-not $DryRun -and (Test-Command "semble")) {
        $preVer = & semble --version 2>&1
        $preVerStr = [string]$preVer
        if ($LASTEXITCODE -eq 0 -and $preVerStr -notmatch 'pyvenv\.cfg' -and $preVerStr -notmatch 'failed to locate' -and $preVerStr -notmatch 'no se puede encontrar') {
            Write-Ok "Semble ya instalado y funcional: $preVerStr. Saltando instalacion."
            $sembleAlreadyOk = $true
        }
    }

    if (-not $sembleAlreadyOk) {
        # Desinstalar completamente y limpiar directorio si queda corrupto
        try { & uv tool uninstall semble 2>$null | Out-Null } catch {}
        $sembleToolDir = Join-Path $env:APPDATA "uv/tools/semble"
        if (Test-Path $sembleToolDir) {
            Write-Warn "Directorio de tool corrupto detectado. Eliminando manualmente..."
            # Si procesos lo bloquean, terminarlos primero
            $blockingProcs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$sembleToolDir*" }
            if ($blockingProcs) {
                Write-Warn "Procesos bloqueando el directorio: $($blockingProcs.Id -join ', '). Terminando..."
                $blockingProcs | Stop-Process -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 2
            }
            Remove-Item -Recurse -Force $sembleToolDir -ErrorAction SilentlyContinue
            if (Test-Path $sembleToolDir) {
                Write-Err "No se pudo eliminar el directorio corrupto: $sembleToolDir"
                Write-Warn "Solucion manual: cierra procesos que lo usen y ejecuta 'uv tool uninstall semble'"
                return $false
            }
        }
        # Limpiar binarios sueltos en .local\bin que puedan estar rotos
        $localBinSemble = Join-Path $env:USERPROFILE ".local/bin/semble.exe"
        if (Test-Path $localBinSemble) {
            $localVer = & $localBinSemble --version 2>&1
            $localVerStr = [string]$localVer
            if ($LASTEXITCODE -ne 0 -or $localVerStr -match 'pyvenv\.cfg' -or $localVerStr -match 'failed to locate') {
                Write-Warn "Binario roto en .local/bin detectado. Eliminando..."
                Remove-Item -Force $localBinSemble -ErrorAction SilentlyContinue
            }
        }

        Write-Step "SEMBLE" "Instalando parece $SembleVersion globalmente con uv tool"
        if ($DryRun) {
            Write-Warn "[DryRun] Se instalaria parece $SembleVersion via uv tool"
        } else {
            & uv tool install "semble[mcp]==$SembleVersion"
            if ($LASTEXITCODE -ne 0) {
                Write-Err "Fallo al instalar parece via uv tool."
                return $false
            }
            Write-Ok "Semble $SembleVersion instalado globalmente"
        }

        if (-not $DryRun) {
            if (-not (Test-Command "semble")) {
                Write-Err "semble instalado pero no esta en PATH. Reinicia la terminal y re-ejecuta."
                return $false
            }
            $ver = & semble --version 2>&1
            $verStr = [string]$ver
            if ($LASTEXITCODE -ne 0 -or $verStr -match 'pyvenv\.cfg' -or $verStr -match 'failed to locate' -or $verStr -match 'no se puede encontrar') {
                Write-Err "semble sigue fallando tras instalacion limpia. El venv de uv tool esta corrupto."
                Write-Warn "Solucion manual: ejecuta 'uv tool uninstall semble' y vuelve a correr el instalador."
                return $false
            }
            Write-Ok "semble en PATH: $ver"
        }
    }

    Write-Step "SEMBLE" "Auto-configurando Semble en opencode (--type all)"
    if (-not $DryRun) {
        & semble install --agent opencode --type all --yes 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "semble install fallo. Configurando manualmente..."
            $cfg = Load-Config $ocConfig
            Set-McpEntry $cfg "semble" ([PSCustomObject]@{
                type    = 'local'
                command = @("uvx", "--from", "semble[mcp]==$SembleVersion", "semble")
                enabled = $true
            })
            Save-Config $ocConfig $cfg
            Create-SembleSubAgent
            Write-Ok "Configuracion manual aplicada (MCP + sub-agente)"
        }
    }

    Write-Step "SEMBLE" "Verificando archivos generados"
    $cfg = Load-Config $ocConfig
    if (Test-SembleMcpEntry $cfg) { Write-Ok "MCP entry en opencode.jsonc: OK" }
    else {
        Write-Warn "MCP entry faltante. Forzando..."
        if (-not $DryRun) {
            Set-McpEntry $cfg "semble" ([PSCustomObject]@{
                type    = 'local'
                command = @("uvx", "--from", "semble[mcp]==$SembleVersion", "semble")
                enabled = $true
            })
            Save-Config $ocConfig $cfg
            Write-Ok "MCP entry forzado en opencode.jsonc"
        }
    }
    if (Test-SembleBlockInAgents) { Write-Ok "Bloque SEMBLE en AGENTS.md: OK" }
    else {
        Write-Warn "Bloque SEMBLE faltante en AGENTS.md. Inyectando..."
        if (-not $DryRun) { Inject-SembleRoutingBlock; Write-Ok "Bloque SEMBLE inyectado en AGENTS.md" }
    }
    if (Test-SembleSubAgent) { Write-Ok "Sub-agente semble-search.md: OK" }
    else {
        Write-Warn "Sub-agente faltante. Creando..."
        if (-not $DryRun) { Create-SembleSubAgent; Write-Ok "Sub-agente parece-search.md creado" }
    }

    Write-Step "SEMBLE" "Reforzando routing en AGENTS.md"
    if (-not $DryRun) { Inject-SembleRoutingBlock; Write-Ok "Routing SEMBLE reforzado en AGENTS.md" }

    Write-Step "SEMBLE" "Plantilla .sembleignore"
    if (-not $DryRun) { Create-SembleIgnoreTemplate }

    if (-not $DryRun) { Invoke-SembleSmokeTest }

    Write-Ok "Semble instalado y configurado"
    return $true
}

function Uninstall-Semble {
    Write-Step "SEMBLE" "Desinstalando Semble"
    if (Test-Command "uv") {
        if (-not $DryRun) {
            try { & uv tool uninstall semble 2>$null | Out-Null; Write-Ok "Semble desinstalado de uv tool" }
            catch { Write-Warn "Semble no estaba instalado globalmente (continuando)" }
        } else { Write-Warn "[DryRun] Se ejecutaria uv tool uninstall semble" }
    }
    $venvPath = Join-Path $env:LOCALAPPDATA "OpenCodeInstaller/semble-venv"
    if (Test-Path $venvPath) {
        if (-not $DryRun) { Remove-Item -Recurse -Force $venvPath; Write-Ok "venv legacy eliminado" }
    }
    $cfg = Load-Config $ocConfig
    Remove-McpEntry $cfg "semble"
    if (-not $DryRun) { Save-Config $ocConfig $cfg; Write-Ok "MCP entry semble removido de opencode.jsonc" }
    if (Test-Path $agentsMd) {
        if (-not $DryRun) {
            New-FileBackup -Path $agentsMd -Phase 'semble' | Out-Null
            $content = Get-Content $agentsMd -Raw
            $newContent = [regex]::Replace($content, '(?s)\r?\n*<!-- SEMBLE_START -->.*?<!-- SEMBLE_END -->\r?\n*', "`n")
            $newContent = $newContent.TrimEnd() + "`n"
            $newContent | Out-File $agentsMd -Encoding UTF8
            Write-Ok "Bloque SEMBLE removido de AGENTS.md"
        }
    }
    $subAgentPath = Join-Path $ocDir "agents/semble-search.md"
    if (Test-Path $subAgentPath) {
        if (-not $DryRun) { Remove-Item -Force $subAgentPath; Write-Ok "Sub-agente parece-search.md eliminado" }
    }
    Write-Warn "Conservando .sembleignore (revisar manualmente si ya no se usa)"
}

# ====================================================================
# FUNCIONES INSTALL/UNINSTALL CONTEXT MODE
# ====================================================================

function Install-ContextMode {
    Write-Step "CTX" "Instalando Context Mode (como plugin, no MCP)"
    if ($ContextModeVersion) {
        $pkg = "context-mode@$ContextModeVersion"
    } else {
        $pkg = "context-mode"
        Write-Warn "ContextModeVersion vacio: instalando latest (NO recomendado para produccion)"
    }

    if ($DryRun) {
        Write-Warn "[DryRun] Se instalaria $pkg via npm install -g"
    } else {
        & npm install -g $pkg
        if ($LASTEXITCODE -ne 0) { Write-Err "Fallo al instalar context-mode via npm"; return $false }
    }

    $cfg = Load-Config $ocConfig

    # Eliminar configuracion MCP legacy si existe
    if ($cfg.mcp -and $cfg.mcp.PSObject.Properties.Name -contains 'context_mode') {
        Write-Warn "Detectada entrada MCP legacy mcp.context_mode. Eliminando..."
        Remove-McpEntry $cfg "context_mode"
    }
    if ($cfg.mcp -and $cfg.mcp.PSObject.Properties.Name -contains 'context-mode') {
        Write-Warn "Detectada entrada MCP legacy mcp.context-mode. Eliminando..."
        Remove-McpEntry $cfg "context-mode"
    }

    # Registrar como plugin
    Add-PluginEntry $cfg "context-mode"
    if (-not $DryRun) {
        New-FileBackup -Path $ocConfig -Phase 'ctx' | Out-Null
        Save-Config $ocConfig $cfg
        Write-Ok "context-mode registrado como plugin en opencode.jsonc"
    }

    # Ejecutar context-mode upgrade para limpiar residuos legacy
    if (-not $DryRun -and (Test-Command "context-mode")) {
        Write-Step "CTX" "Ejecutando context-mode upgrade (limpieza legacy)"
        try {
            & context-mode upgrade 2>&1 | Out-Host
            Write-Ok "context-mode upgrade completado"
        } catch { Write-Warn "context-mode upgrade fallo (no critico): $($_.Exception.Message)" }
    }

    # Escribir docs/context-mode.md
    Write-Step "CTX" "Escribiendo docs/context-mode.md (politica + benchmark)"
    if (-not $DryRun) {
        if (-not (Test-Path $ctxDocsDir)) { New-Item -ItemType Directory -Path $ctxDocsDir -Force | Out-Null }
        $CTX_MODE_DOC_CONTENT | Out-File $ctxDocsMd -Encoding UTF8
        Write-Ok "Politica escrita en $ctxDocsMd"
    }

    # Sobrescribir AGENTS.md global con reglas minimas (preservando bloques existentes)
    Write-Step "CTX" "Sobrescribiendo AGENTS.md global (reglas minimas + bloques preservados)"
    if (-not $DryRun) {
        $sembleBlock = Extract-SembleBlock
        $newContent = $AGENTS_MD_CONTENT.TrimEnd()
        if ($sembleBlock) {
            Write-Warn "Preservando bloque SEMBLE existente en AGENTS.md"
            $newContent = $newContent + "`n`n" + $sembleBlock
        }
        # Preservar bloque RTK si existe
        if (Test-Path $agentsMd) {
            $currentContent = Get-Content $agentsMd -Raw
            if ($currentContent -match '(?s)(<!-- RTK_START -->.*?<!-- RTK_END -->)') {
                $newContent = $newContent + "`n`n" + $Matches[1]
            }
            if ($currentContent -match '(?s)(<!-- REPOMIX_START -->.*?<!-- REPOMIX_END -->)') {
                $newContent = $newContent + "`n`n" + $Matches[1]
            }
            if ($currentContent -match '(?s)(<!-- SERENA_START -->.*?<!-- SERENA_END -->)') {
                $newContent = $newContent + "`n`n" + $Matches[1]
            }
        }
        $newContent | Out-File $agentsMd -Encoding UTF8
        Write-Ok "AGENTS.md escrito en $agentsMd"
    }

    # Verificacion tecnica
    if (-not $DryRun -and (Test-Command "ctx")) {
        Write-Step "CTX" "Verificacion tecnica (ctx stats / ctx doctor)"
        Write-Host "  Ejecutando ctx stats..." -ForegroundColor Cyan
        try { & ctx stats 2>&1 | Out-Host } catch { Write-Warn "ctx stats fallo: $($_.Exception.Message)" }
        Write-Host "  Ejecutando ctx doctor..." -ForegroundColor Cyan
        try { & ctx doctor 2>&1 | Out-Host } catch { Write-Warn "ctx doctor fallo: $($_.Exception.Message)" }
    }

    Write-Ok "Context Mode instalado y configurado"
    return $true
}

function Uninstall-ContextMode {
    Write-Step "CTX" "Desinstalando Context Mode"
    if (-not $DryRun) {
        try { & npm uninstall -g context-mode --silent 2>$null | Out-Null } catch {}
    }
    $cfg = Load-Config $ocConfig
    Remove-PluginEntry $cfg "context-mode"
    Remove-McpEntry $cfg "context_mode"
    Remove-McpEntry $cfg "context-mode"
    if (-not $DryRun) {
        New-FileBackup -Path $ocConfig -Phase 'ctx' | Out-Null
        Save-Config $ocConfig $cfg
        Write-Ok "context-mode removido de opencode.jsonc"
    }
    Write-Warn "Conservando docs/context-mode.md y AGENTS.md (revisar manualmente)"
}

# ====================================================================
# HELPERS RTK
# ====================================================================

function Write-RtkLog {
    param([string]$Message)
    if ($DryRun) { return }
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $Message"
    try { Add-Content -LiteralPath $RtkLogPath -Value $line -ErrorAction Stop } catch { }
}

function New-RtkBackup { param([Parameter(Mandatory)][string]$Path) return New-FileBackup -Path $Path -Phase 'rtk' }

function Get-RtkExePath {
    $cmd = Get-Command rtk -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $local = Join-Path $RtkInstallDir "rtk.exe"
    if (Test-Path $local) { return $local }
    return $null
}

function Test-RtkInstalled { return [bool](Get-RtkExePath) }

function Test-RtkVersionMatches {
    $exe = Get-RtkExePath
    if (-not $exe) { return $false }
    try {
        $ver = & $exe --version 2>&1
        return ($ver -match [regex]::Escape($RtkVersion))
    } catch { return $false }
}

function Test-RtkInUserPath {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $userPath) { return $false }
    $entries = $userPath -split ';' | Where-Object { $_ -ne '' }
    foreach ($e in $entries) { if ($e -eq $RtkInstallDir) { return $true } }
    return $false
}

function Add-RtkToUserPath {
    if (Test-RtkInUserPath) { return $true }
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath) { $newPath = $userPath.TrimEnd(';') + ";" + $RtkInstallDir }
    else { $newPath = $RtkInstallDir }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    $env:Path = $env:Path.TrimEnd(';') + ";" + $RtkInstallDir
    return $true
}

# ====================================================================
# INSTALL RTK (7 fases, NO usa rtk init)
# ====================================================================

function Install-RtkBinary {
    Write-Step "RTK" "Fase 1: Instalando binario rtk $RtkVersion"
    if ((Test-RtkInstalled) -and (Test-RtkVersionMatches) -and (-not $Force)) {
        Write-Ok "rtk $RtkVersion ya instalado: $(Get-RtkExePath)"
        Write-RtkLog "fase1: ya instalado en $(Get-RtkExePath)"
        return $true
    }
    if ($DryRun) { Write-Warn "[DryRun] Se instalaria rtk $RtkVersion (winget -> cargo -> GitHub)"; return $true }

    $installed = $false

    if ((Test-Command "winget") -and -not $installed) {
        Write-Step "RTK" "Intentando winget install rtk-ai.rtk"
        try {
            & winget install --id rtk-ai.rtk --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Host
            if ($LASTEXITCODE -eq 0 -and (Test-RtkInstalled)) {
                Write-Ok "rtk instalado via winget"; Write-RtkLog "fase1: instalado via winget"; $installed = $true
            }
        } catch { Write-Warn "winget fallo: $($_.Exception.Message)" }
    }

    if ((Test-Command "cargo") -and -not $installed) {
        Write-Step "RTK" "Intentando cargo install rtk-cli --version $RtkVersion"
        try {
            & cargo install rtk-cli --version $RtkVersion --locked 2>&1 | Out-Host
            if ($LASTEXITCODE -eq 0 -and (Test-RtkInstalled)) {
                Write-Ok "rtk instalado via cargo"; Write-RtkLog "fase1: instalado via cargo"; $installed = $true
            }
        } catch { Write-Warn "cargo fallo: $($_.Exception.Message)" }
    }

    if (-not $installed) {
        Write-Step "RTK" "Descargando release de GitHub"
        $assetName = "rtk-x86_64-pc-windows-msvc.zip"
        $zipUrl = "https://github.com/$RtkRepo/releases/download/v$RtkVersion/$assetName"
        $checksumsUrl = "https://github.com/$RtkRepo/releases/download/v$RtkVersion/checksums.txt"
        $tempDir = Join-Path $env:TEMP "rtk-install-$RtkVersion"
        if (Test-Path $tempDir) { Remove-Item -Recurse -Force $tempDir }
        New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
        $zipPath = Join-Path $tempDir $assetName
        $checksumsPath = Join-Path $tempDir "checksums.txt"
        try {
            Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
            Invoke-WebRequest -Uri $checksumsUrl -OutFile $checksumsPath -UseBasicParsing
        } catch { Write-Err "Descarga fallo: $($_.Exception.Message)"; return $false }

        $expectedHash = $null
        foreach ($line in Get-Content $checksumsPath) {
            if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+)$') {
                if ($matches[2].Trim() -eq $assetName) { $expectedHash = $matches[1].ToLower(); break }
            }
        }
        if (-not $expectedHash) { Write-Err "No se encontro checksum para $assetName"; return $false }
        $actualHash = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
        if ($actualHash -ne $expectedHash) { Write-Err "Checksum mismatch (esperado $expectedHash, actual $actualHash)"; return $false }
        Write-Ok "Checksum SHA-256 verificado"

        if (-not (Test-Path $RtkInstallDir)) { New-Item -ItemType Directory -Path $RtkInstallDir -Force | Out-Null }
        $extractDir = Join-Path $tempDir "extracted"
        Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
        $exeInZip = Join-Path $extractDir "rtk.exe"
        if (-not (Test-Path $exeInZip)) { Write-Err "rtk.exe no encontrado dentro del zip"; return $false }
        Copy-Item $exeInZip (Join-Path $RtkInstallDir "rtk.exe") -Force
        Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
        if (-not (Test-RtkInUserPath)) { Add-RtkToUserPath | Out-Null; Write-Ok "$RtkInstallDir anadido al PATH del usuario" }
        Write-Ok "rtk instalado via GitHub release"; Write-RtkLog "fase1: instalado via GitHub release"; $installed = $true
    }

    if (-not $installed) { Write-Err "No se pudo instalar rtk por ningun metodo (winget/cargo/GitHub)"; return $false }

    $exe = Get-RtkExePath
    try { $ver = & $exe --version 2>&1; Write-Ok "rtk --version: $ver" }
    catch { Write-Err "rtk --version fallo: $($_.Exception.Message)"; return $false }
    return $true
}

function Write-RtkPlugin {
    Write-Step "RTK" "Fase 2: Escribiendo plugin/openrtk.ts (version parcheada)"
    Write-RtkLog "fase2: plugin/openrtk.ts"
    if ($DryRun) { Write-Warn "[DryRun] Se escribiria $RtkPluginPath"; return $true }
    if (Test-Path -LiteralPath $RtkPluginPath) { New-RtkBackup -Path $RtkPluginPath | Out-Null }
    if (-not (Test-Path $RtkPluginDir)) { New-Item -ItemType Directory -Path $RtkPluginDir -Force | Out-Null }
    Set-Content -LiteralPath $RtkPluginPath -Value $RTK_PLUGIN_CONTENT -Encoding UTF8 -NoNewline
    Write-Ok "Plugin escrito: $RtkPluginPath"
    return $true
}

function Write-RtkMd {
    Write-Step "RTK" "Fase 3: Creando RTK.md"
    Write-RtkLog "fase3: RTK.md"
    if ($DryRun) { Write-Warn "[DryRun] Se escribiria $RtkMdPath"; return $true }
    if (Test-Path -LiteralPath $RtkMdPath) { New-RtkBackup -Path $RtkMdPath | Out-Null }
    Set-Content -LiteralPath $RtkMdPath -Value $RTK_MD_CONTENT -Encoding UTF8
    Write-Ok "RTK.md creado: $RtkMdPath"
    return $true
}

function Inject-RtkRoutingBlock {
    Write-Step "RTK" "Fase 4: Inyectando bloque RTK en AGENTS.md"
    Write-RtkLog "fase4: AGENTS.md block"
    if ($DryRun) { Write-Warn "[DryRun] Se inyectaria bloque RTK_START/END en $agentsMd"; return $true }
    if (-not (Test-Path -LiteralPath $agentsMd)) { Write-Err "AGENTS.md no encontrado: $agentsMd"; return $false }
    New-RtkBackup -Path $agentsMd | Out-Null
    $content = Get-Content -LiteralPath $agentsMd -Raw
    $pattern = '(?s)<!-- RTK_START -->.*?<!-- RTK_END -->\r?\n?'
    $block = $RTK_ROUTING_BLOCK.TrimEnd() + "`r`n`r`n"
    if ([regex]::IsMatch($content, $pattern)) {
        $newContent = [regex]::Replace($content, $pattern, $block)
        Write-Ok "Bloque RTK actualizado en AGENTS.md (idempotente)"
    } else {
        $newContent = $content.TrimEnd() + "`r`n`r`n" + $block
        Write-Ok "Bloque RTK anadido a AGENTS.md"
    }
    Set-Content -LiteralPath $agentsMd -Value $newContent -Encoding UTF8 -NoNewline
    return $true
}

function Write-RtkConfig {
    Write-Step "RTK" "Fase 5: Escribiendo config.toml"
    Write-RtkLog "fase5: config.toml"
    if ($DryRun) { Write-Warn "[DryRun] Se escribiria $RtkConfigPath"; return $true }
    if (Test-Path -LiteralPath $RtkConfigPath) { New-RtkBackup -Path $RtkConfigPath | Out-Null }
    if (-not (Test-Path $RtkConfigDir)) { New-Item -ItemType Directory -Path $RtkConfigDir -Force | Out-Null }
    Set-Content -LiteralPath $RtkConfigPath -Value $RTK_CONFIG_CONTENT -Encoding UTF8
    Write-Ok "config.toml escrito: $RtkConfigPath"
    return $true
}

function Invoke-RtkRecallMigration {
    Write-Step "RTK" "Fase 6: Migrando recall (tee -> sqlite)"
    Write-RtkLog "fase6: recall migration"
    $exe = Get-RtkExePath
    if (-not $exe) { Write-Warn "rtk no instalado, saltando migracion de recall"; return $true }
    if ($DryRun) { Write-Warn "[DryRun] Se ejecutaria rtk recall --migrate"; return $true }
    try {
        & $exe recall --migrate 2>&1 | Out-Host
        Write-Ok "Recall migrado a sqlite"; Write-RtkLog "fase6: migracion OK"
    } catch {
        Write-Warn "rtk recall --migrate fallo (no critico): $($_.Exception.Message)"
        Write-RtkLog "fase6: fallo no critico: $($_.Exception.Message)"
    }
    return $true
}

function Invoke-RtkFinalVerification {
    Write-Step "RTK" "Fase 7: Verificacion final"
    Write-RtkLog "fase7: verificacion"
    $allOk = $true
    $exe = Get-RtkExePath
    if ($exe) { Write-Ok "rtk en PATH: $exe" } else { Write-Err "rtk no encontrado en PATH"; $allOk = $false }
    if (Test-Path -LiteralPath $RtkPluginPath) {
        $size = (Get-Item -LiteralPath $RtkPluginPath).Length
        Write-Ok "plugin/openrtk.ts existe ($size bytes)"
    } else { Write-Err "plugin/openrtk.ts no encontrado: $RtkPluginPath"; $allOk = $false }
    if (Test-Path -LiteralPath $RtkMdPath) { Write-Ok "RTK.md existe" }
    else { Write-Err "RTK.md no encontrado: $RtkMdPath"; $allOk = $false }
    if (Test-Path -LiteralPath $agentsMd) {
        $agentsContent = Get-Content -LiteralPath $agentsMd -Raw
        if ($agentsContent -match '<!-- RTK_START -->' -and $agentsContent -match '<!-- RTK_END -->') {
            Write-Ok "Bloque RTK presente en AGENTS.md"
        } else { Write-Err "Bloque RTK no encontrado en AGENTS.md"; $allOk = $false }
    } else { Write-Err "AGENTS.md no encontrado"; $allOk = $false }
    if (Test-Path -LiteralPath $RtkConfigPath) { Write-Ok "config.toml existe: $RtkConfigPath" }
    else { Write-Err "config.toml no encontrado: $RtkConfigPath"; $allOk = $false }
    if ($exe) {
        try { $ver = & $exe --version 2>&1; Write-Ok "rtk --version: $ver" }
        catch { Write-Err "rtk --version fallo"; $allOk = $false }
    }
    return $allOk
}

function Install-Rtk {
    Write-Step "RTK" "Instalando RTK $RtkVersion (7 fases, NO usa rtk init)"
    Write-RtkLog "=== inicio instalacion rtk $RtkVersion ==="
    if (-not (Install-RtkBinary))         { return $false }
    if (-not (Write-RtkPlugin))           { return $false }
    if (-not (Write-RtkMd))               { return $false }
    if (-not (Inject-RtkRoutingBlock))    { return $false }
    if (-not (Write-RtkConfig))           { return $false }
    if (-not (Invoke-RtkRecallMigration)) { return $false }
    $ok = Invoke-RtkFinalVerification
    Write-RtkLog "=== fin instalacion rtk (ok=$ok) ==="
    if ($ok) { Write-Ok "RTK $RtkVersion instalado y verificado" }
    return $ok
}

function Uninstall-Rtk {
    Write-Step "RTK" "Desinstalando RTK"
    Write-RtkLog "=== inicio desinstalacion rtk ==="
    if (Test-Path -LiteralPath $RtkPluginPath) {
        if (-not $DryRun) {
            New-RtkBackup -Path $RtkPluginPath | Out-Null
            Remove-Item -LiteralPath $RtkPluginPath -Force; Write-Ok "plugin/openrtk.ts eliminado"
        } else { Write-Warn "[DryRun] Se eliminaria $RtkPluginPath" }
    } else { Write-Warn "plugin/openrtk.ts no encontrado (ya eliminado)" }
    if (Test-Path -LiteralPath $RtkMdPath) {
        if (-not $DryRun) {
            New-RtkBackup -Path $RtkMdPath | Out-Null
            Remove-Item -LiteralPath $RtkMdPath -Force; Write-Ok "RTK.md eliminado"
        } else { Write-Warn "[DryRun] Se eliminaria $RtkMdPath" }
    } else { Write-Warn "RTK.md no encontrado (ya eliminado)" }
    if (Test-Path -LiteralPath $agentsMd) {
        if (-not $DryRun) {
            New-RtkBackup -Path $agentsMd | Out-Null
            $content = Get-Content -LiteralPath $agentsMd -Raw
            $pattern = '(?s)<!-- RTK_START -->.*?<!-- RTK_END -->\r?\n?\r?\n?'
            if ([regex]::IsMatch($content, $pattern)) {
                $newContent = [regex]::Replace($content, $pattern, '')
                Set-Content -LiteralPath $agentsMd -Value $newContent -Encoding UTF8 -NoNewline
                Write-Ok "Bloque RTK removido de AGENTS.md"
            } else { Write-Warn "Bloque RTK no encontrado en AGENTS.md" }
        } else { Write-Warn "[DryRun] Se removeria bloque RTK de $agentsMd" }
    }
    if (Test-Path -LiteralPath $RtkConfigPath) {
        if (-not $DryRun) {
            New-RtkBackup -Path $RtkConfigPath | Out-Null
            Remove-Item -LiteralPath $RtkConfigPath -Force; Write-Ok "config.toml eliminado"
        } else { Write-Warn "[DryRun] Se eliminaria $RtkConfigPath" }
    } else { Write-Warn "config.toml no encontrado (ya eliminado)" }
    Write-Warn "El binario rtk no se borra (instalado via winget/cargo/GitHub)"
    Write-RtkLog "=== fin desinstalacion rtk ==="
}

# ====================================================================
# HELPERS REPOMIX
# ====================================================================

function New-RepomixBackup { param([Parameter(Mandatory)][string]$Path) return New-FileBackup -Path $Path -Phase 'repomix' }

function Test-RepomixMcpEntry {
    param([object]$Config)
    if (-not $Config.mcp) { return $false }
    if (-not ($Config.mcp.PSObject.Properties.Name -contains 'repomix')) { return $false }
    $entry = $Config.mcp.repomix
    if ($entry.type -ne 'local') { return $false }
    if (-not $entry.command) { return $false }
    $cmd = $entry.command -join ' '
    if ($cmd -notmatch 'repomix') { return $false }
    if ($cmd -notmatch '--mcp') { return $false }
    return $true
}

function Get-RepomixInstalledVersion {
    $out = & npm list -g repomix --depth=0 --json 2>$null | ConvertFrom-Json -ErrorAction SilentlyContinue
    if ($out -and $out.dependencies -and $out.dependencies.repomix) {
        return $out.dependencies.repomix.version
    }
    return $null
}

function Inject-RepomixRoutingBlock {
    Write-Step "REPOMIX" "Fase 4: Inyectando bloque REPOMIX en AGENTS.md"
    if ($DryRun) { Write-Warn "[DryRun] Se inyectaria bloque REPOMIX_START/END en $agentsMd"; return $true }
    if (-not (Test-Path -LiteralPath $agentsMd)) { Write-Err "AGENTS.md no encontrado: $agentsMd"; return $false }
    New-RepomixBackup -Path $agentsMd | Out-Null
    $content = Get-Content -LiteralPath $agentsMd -Raw
    $pattern = '(?s)<!-- REPOMIX_START -->.*?<!-- REPOMIX_END -->\r?\n?'
    $block = $REPOMIX_ROUTING_BLOCK.TrimEnd() + "`r`n`r`n"
    if ([regex]::IsMatch($content, $pattern)) {
        $newContent = [regex]::Replace($content, $pattern, $block)
        Write-Ok "Bloque REPOMIX actualizado en AGENTS.md (idempotente)"
    } else {
        $newContent = $content.TrimEnd() + "`r`n`r`n" + $block
        Write-Ok "Bloque REPOMIX anadido a AGENTS.md"
    }
    Set-Content -LiteralPath $agentsMd -Value $newContent -Encoding UTF8 -NoNewline
    return $true
}

function Write-RepomixIgnore {
    Write-Step "REPOMIX" "Fase 5: Creando .repomixignore global"
    if ($DryRun) { Write-Warn "[DryRun] Se escribiria $RepomixIgnorePath"; return $true }
    New-RepomixBackup -Path $RepomixIgnorePath | Out-Null
    Set-Content -LiteralPath $RepomixIgnorePath -Value $REPOMIX_IGNORE_CONTENT -Encoding UTF8
    Write-Ok ".repomixignore escrito en $RepomixIgnorePath"
    return $true
}

# ====================================================================
# INSTALL REPOMIX (6 fases, idempotente)
# ====================================================================

function Install-Repomix {
    Write-Step "REPOMIX" "Instalando repomix (6 fases)"

    Write-Step "REPOMIX" "Fase 1: Instalando paquete npm global repomix"
    if ($DryRun) {
        Write-Warn "[DryRun] Se instalaria repomix via npm install -g"
    } else {
        $current = Get-RepomixInstalledVersion
        if ($current) {
            Write-Ok "repomix $current ya instalado globalmente"
        } else {
            & npm install -g repomix
            if ($LASTEXITCODE -ne 0) { Write-Err "Fallo al instalar repomix via npm"; return $false }
            $current = Get-RepomixInstalledVersion
            Write-Ok "repomix $current instalado globalmente"
        }
        $ver = & repomix --version 2>&1
        Write-Ok "repomix --version: $ver"
    }

    Write-Step "REPOMIX" "Fase 2: Verificando entrada MCP mcp.repomix en opencode.jsonc"
    $cfg = Load-Config $ocConfig
    if (Test-RepomixMcpEntry $cfg) {
        Write-Ok "Entrada MCP mcp.repomix ya presente y correcta"
    } else {
        if ($DryRun) { Write-Warn "[DryRun] Se inyectaria entrada mcp.repomix en $ocConfig" }
        else {
            New-RepomixBackup $ocConfig | Out-Null
            $entry = [PSCustomObject]@{
                type    = 'local'
                command = @('npx', '-y', 'repomix', '--mcp')
                enabled = $true
            }
            Set-McpEntry $cfg "repomix" $entry
            Save-Config $ocConfig $cfg
            Write-Ok "Entrada MCP mcp.repomix inyectada en $ocConfig"
        }
    }

    Write-Step "REPOMIX" "Fase 3: Creando repomix.config.json"
    if ($DryRun) { Write-Warn "[DryRun] Se escribiria $RepomixConfigPath" }
    else {
        New-RepomixBackup $RepomixConfigPath | Out-Null
        Set-Content -LiteralPath $RepomixConfigPath -Value $RepomixConfigContent -Encoding UTF8
        Write-Ok "repomix.config.json escrito en $RepomixConfigPath"
    }

    Inject-RepomixRoutingBlock | Out-Null
    Write-RepomixIgnore | Out-Null

    Write-Step "REPOMIX" "Fase 6: Verificacion final"
    $checksOk = 0; $checksTotal = 5
    if ($DryRun) { Write-Warn "[DryRun] (skip) repomix --version"; $checksOk++ }
    else {
        $binOk = $false
        try { $v = & repomix --version 2>&1; if ($LASTEXITCODE -eq 0 -and $v) { $binOk = $true } } catch {}
        if ($binOk) { Write-Ok "repomix binario responde: $v"; $checksOk++ }
        else { Write-Err "repomix binario no responde" }
    }
    $cfg2 = Load-Config $ocConfig
    if (Test-RepomixMcpEntry $cfg2) { Write-Ok "MCP entry mcp.repomix presente en opencode.jsonc"; $checksOk++ }
    else { Write-Err "MCP entry mcp.repomix ausente en opencode.jsonc" }
    if (-not $DryRun -and (Test-Path $RepomixConfigPath)) { Write-Ok "repomix.config.json existe"; $checksOk++ }
    elseif ($DryRun) { Write-Warn "[DryRun] (skip) repomix.config.json"; $checksOk++ }
    else { Write-Err "repomix.config.json no encontrado: $RepomixConfigPath" }
    if (-not $DryRun -and (Test-Path $agentsMd)) {
        $agentsContent = Get-Content -LiteralPath $agentsMd -Raw
        if ($agentsContent -match 'REPOMIX_START' -and $agentsContent -match 'REPOMIX_END') {
            Write-Ok "Bloque REPOMIX_START/END presente en AGENTS.md"; $checksOk++
        } else { Write-Err "Bloque REPOMIX_START/END ausente en AGENTS.md" }
    } elseif ($DryRun) { Write-Warn "[DryRun] (skip) bloque REPOMIX en AGENTS.md"; $checksOk++ }
    else { Write-Err "AGENTS.md no encontrado: $agentsMd" }
    if (-not $DryRun -and (Test-Path $RepomixIgnorePath)) { Write-Ok ".repomixignore existe"; $checksOk++ }
    elseif ($DryRun) { Write-Warn "[DryRun] (skip) .repomixignore"; $checksOk++ }
    else { Write-Err ".repomixignore no encontrado: $RepomixIgnorePath" }
    if ($checksOk -eq $checksTotal) { Write-Ok "Verificacion final: $checksOk/$checksTotal checks OK" }
    else { Write-Warn "Verificacion final: $checksOk/$checksTotal checks OK" }

    Write-Ok "repomix instalado y configurado"
    return $true
}

function Uninstall-Repomix {
    Write-Step "REPOMIX" "Desinstalando repomix"
    if ($DryRun) { Write-Warn "[DryRun] Se ejecutaria npm uninstall -g repomix" }
    else {
        try { & npm uninstall -g repomix --silent 2>$null | Out-Null } catch {}
        Write-Ok "repomix desinstalado de npm global"
    }
    $cfg = Load-Config $ocConfig
    if ($cfg.mcp -and $cfg.mcp.PSObject.Properties.Name -contains 'repomix') {
        if ($DryRun) { Write-Warn "[DryRun] Se removeria entrada mcp.repomix de $ocConfig" }
        else {
            New-RepomixBackup $ocConfig | Out-Null
            Remove-McpEntry $cfg "repomix"
            Save-Config $ocConfig $cfg
            Write-Ok "Entrada mcp.repomix removida de opencode.jsonc"
        }
    } else { Write-Warn "Entrada mcp.repomix no encontrada en opencode.jsonc" }
    if (Test-Path $RepomixConfigPath) {
        if ($DryRun) { Write-Warn "[DryRun] Se eliminaria $RepomixConfigPath" }
        else { New-RepomixBackup $RepomixConfigPath | Out-Null; Remove-Item -LiteralPath $RepomixConfigPath -Force; Write-Ok "repomix.config.json eliminado" }
    } else { Write-Warn "repomix.config.json no encontrado (nada que borrar)" }
    if (Test-Path -LiteralPath $agentsMd) {
        if ($DryRun) { Write-Warn "[DryRun] Se removeria bloque REPOMIX de $agentsMd" }
        else {
            New-RepomixBackup $agentsMd | Out-Null
            $content = Get-Content -LiteralPath $agentsMd -Raw
            $pattern = '(?s)<!-- REPOMIX_START -->.*?<!-- REPOMIX_END -->\r?\n?\r?\n?'
            if ([regex]::IsMatch($content, $pattern)) {
                $newContent = [regex]::Replace($content, $pattern, '')
                Set-Content -LiteralPath $agentsMd -Value $newContent -Encoding UTF8 -NoNewline
                Write-Ok "Bloque REPOMIX removido de AGENTS.md"
            } else { Write-Warn "Bloque REPOMIX no encontrado en AGENTS.md" }
        }
    } else { Write-Warn "AGENTS.md no encontrado (nada que limpiar)" }
    if (Test-Path $RepomixIgnorePath) {
        if ($DryRun) { Write-Warn "[DryRun] Se eliminaria $RepomixIgnorePath" }
        else { New-RepomixBackup $RepomixIgnorePath | Out-Null; Remove-Item -LiteralPath $RepomixIgnorePath -Force; Write-Ok ".repomixignore eliminado" }
    } else { Write-Warn ".repomixignore no encontrado (nada que borrar)" }
}

# ====================================================================
# HELPERS SERENA
# ====================================================================

function New-SerenaBackup { param([Parameter(Mandatory)][string]$Path) return New-FileBackup -Path $Path -Phase 'serena' }

function Test-SerenaMcpEntry {
    param([object]$Config)
    if (-not $Config.mcp) { return $false }
    if (-not ($Config.mcp.PSObject.Properties.Name -contains 'serena')) { return $false }
    $entry = $Config.mcp.serena
    if ($entry.type -ne 'local') { return $false }
    if (-not $entry.command) { return $false }
    $cmd = $entry.command -join ' '
    if ($cmd -notmatch 'serena') { return $false }
    if ($cmd -notmatch 'start-mcp-server') { return $false }
    if ($cmd -notmatch 'ide') { return $false }
    return $true
}

function Test-SerenaInstalled { return [bool](Test-Command "serena") }

function Ensure-Uv {
    if (Test-Command "uv") { Write-Ok "uv detectado en PATH"; return $true }
    Write-Warn "uv no encontrado. Instalando via astral.sh..."
    if ($DryRun) { Write-Warn "[DryRun] Se instalaria uv via irm https://astral.sh/uv/install.ps1 | iex"; return $true }
    try { & (irm https://astral.sh/uv/install.ps1) | iex }
    catch { Write-Err "Fallo al descargar/ejecutar el instalador de uv: $($_.Exception.Message)"; return $false }
    $uvBin = Join-Path $env:USERPROFILE ".local\bin"
    if ($env:Path -notlike "*$uvBin*") { $env:Path = $env:Path.TrimEnd(';') + ";" + $uvBin }
    if (Test-Command "uv") { Write-Ok "uv instalado y en PATH"; return $true }
    $uvExe = Join-Path $uvBin "uv.exe"
    if (Test-Path $uvExe) { Write-Ok "uv instalado en $uvExe"; return $true }
    Write-Err "uv instalado pero no se encontro en PATH. Reinicia la terminal y re-ejecuta."
    return $false
}

function Inject-SerenaRoutingBlock {
    Write-Step "SERENA" "Fase 4b: Inyectando bloque SERENA en AGENTS.md"
    if ($DryRun) { Write-Warn "[DryRun] Se inyectaria bloque SERENA_START/END en $agentsMd"; return $true }
    if (-not (Test-Path -LiteralPath $agentsMd)) { Write-Err "AGENTS.md no encontrado: $agentsMd"; return $false }
    New-SerenaBackup -Path $agentsMd | Out-Null
    $content = Get-Content -LiteralPath $agentsMd -Raw
    $pattern = '(?s)<!-- SERENA_START -->.*?<!-- SERENA_END -->\r?\n?'
    $block = $SERENA_ROUTING_BLOCK.TrimEnd() + "`r`n`r`n"
    if ([regex]::IsMatch($content, $pattern)) {
        $newContent = [regex]::Replace($content, $pattern, $block)
        Write-Ok "Bloque SERENA actualizado en AGENTS.md (idempotente)"
    } else {
        $newContent = $content.TrimEnd() + "`r`n`r`n" + $block
        Write-Ok "Bloque SERENA anadido a AGENTS.md"
    }
    Set-Content -LiteralPath $agentsMd -Value $newContent -Encoding UTF8 -NoNewline
    return $true
}

# ====================================================================
# INSTALL SERENA (5 fases, idempotente)
# ====================================================================

function Install-Serena {
    Write-Step "SERENA" "Instalando Serena (5 fases)"

    Write-Step "SERENA" "Fase 1: Verificando uv (prerequisito)"
    $uvOk = Ensure-Uv
    if (-not $uvOk) { Write-Err "uv es obligatorio para instalar Serena. Abortando."; return $false }

    Write-Step "SERENA" "Fase 2: Instalando serena-agent con uv tool install -p $SerenaPythonVersion"
    if ($DryRun) { Write-Warn "[DryRun] Se instalaria serena-agent via uv tool install" }
    else {
        & uv tool install -p $SerenaPythonVersion serena-agent
        if ($LASTEXITCODE -ne 0) {
            Write-Err "Fallo al instalar serena-agent via uv tool. Intentando con --force..."
            & uv tool install -p $SerenaPythonVersion serena-agent --force
            if ($LASTEXITCODE -ne 0) { Write-Err "Fallo definitivo al instalar serena-agent"; return $false }
        }
        Write-Ok "serena-agent instalado globalmente"
    }

    Write-Step "SERENA" "Fase 3: Verificando serena en PATH"
    if ($DryRun) { Write-Warn "[DryRun] (skip) verificacion serena --help" }
    else {
        if (-not (Test-SerenaInstalled)) {
            $uvBin = Join-Path $env:USERPROFILE ".local\bin"
            if ($env:Path -notlike "*$uvBin*") { $env:Path = $env:Path.TrimEnd(';') + ";" + $uvBin }
        }
        if (-not (Test-SerenaInstalled)) {
            Write-Err "serena instalado pero no esta en PATH. Reinicia la terminal y re-ejecuta."
            return $false
        }
        try {
            $helpOut = & serena --help 2>&1 | Select-Object -First 1
            Write-Ok "serena en PATH: $helpOut"
        } catch { Write-Warn "serena en PATH pero --help no respondio (no critico)" }
    }

    Write-Step "SERENA" "Fase 4a: Verificando entrada MCP mcp.serena en opencode.jsonc"
    $cfg = Load-Config $ocConfig
    if (Test-SerenaMcpEntry $cfg) {
        Write-Ok "Entrada MCP mcp.serena ya presente y correcta"
    } else {
        if ($DryRun) { Write-Warn "[DryRun] Se inyectaria entrada mcp.serena en $ocConfig" }
        else {
            New-SerenaBackup $ocConfig | Out-Null
            $entry = [PSCustomObject]@{
                type    = 'local'
                command = @('serena', 'start-mcp-server', '--context', 'ide')
                enabled = $true
            }
            Set-McpEntry $cfg "serena" $entry
            Save-Config $ocConfig $cfg
            Write-Ok "Entrada MCP mcp.serena inyectada en $ocConfig"
        }
    }
    Inject-SerenaRoutingBlock | Out-Null

    Write-Step "SERENA" "Fase 5: Verificacion final"
    $checksOk = 0; $checksTotal = 3
    if ($DryRun) { Write-Warn "[DryRun] (skip) serena --help"; $checksOk++ }
    else {
        $binOk = $false
        try { $h = & serena --help 2>&1; if ($LASTEXITCODE -eq 0 -and $h) { $binOk = $true } } catch {}
        if ($binOk) { Write-Ok "serena binario responde"; $checksOk++ }
        else { Write-Err "serena binario no responde" }
    }
    $cfg2 = Load-Config $ocConfig
    if (Test-SerenaMcpEntry $cfg2) { Write-Ok "MCP entry mcp.serena presente en opencode.jsonc"; $checksOk++ }
    else { Write-Err "MCP entry mcp.serena ausente en opencode.jsonc" }
    if (-not $DryRun -and (Test-Path $agentsMd)) {
        $agentsContent = Get-Content -LiteralPath $agentsMd -Raw
        if ($agentsContent -match 'SERENA_START' -and $agentsContent -match 'SERENA_END') {
            Write-Ok "Bloque SERENA_START/END presente en AGENTS.md"; $checksOk++
        } else { Write-Err "Bloque SERENA_START/END ausente en AGENTS.md" }
    } elseif ($DryRun) { Write-Warn "[DryRun] (skip) bloque SERENA en AGENTS.md"; $checksOk++ }
    else { Write-Err "AGENTS.md no encontrado: $agentsMd" }
    if ($checksOk -eq $checksTotal) { Write-Ok "Verificacion final: $checksOk/$checksTotal checks OK" }
    else { Write-Warn "Verificacion final: $checksOk/$checksTotal checks OK" }

    Write-Ok "Serena instalado y configurado"
    return $true
}

function Uninstall-Serena {
    Write-Step "SERENA" "Desinstalando Serena"
    if ($DryRun) { Write-Warn "[DryRun] Se ejecutaria uv tool uninstall serena-agent" }
    else {
        try { & uv tool uninstall serena-agent 2>$null | Out-Null } catch {}
        Write-Ok "serena-agent desinstalado de uv tool"
    }
    $cfg = Load-Config $ocConfig
    if ($cfg.mcp -and $cfg.mcp.PSObject.Properties.Name -contains 'serena') {
        if ($DryRun) { Write-Warn "[DryRun] Se removeria entrada mcp.serena de $ocConfig" }
        else {
            New-SerenaBackup $ocConfig | Out-Null
            Remove-McpEntry $cfg "serena"
            Save-Config $ocConfig $cfg
            Write-Ok "Entrada mcp.serena removida de opencode.jsonc"
        }
    } else { Write-Warn "Entrada mcp.serena no encontrada en opencode.jsonc" }
    if (Test-Path -LiteralPath $agentsMd) {
        if ($DryRun) { Write-Warn "[DryRun] Se removeria bloque SERENA de $agentsMd" }
        else {
            New-SerenaBackup $agentsMd | Out-Null
            $content = Get-Content -LiteralPath $agentsMd -Raw
            $pattern = '(?s)<!-- SERENA_START -->.*?<!-- SERENA_END -->\r?\n?\r?\n?'
            if ([regex]::IsMatch($content, $pattern)) {
                $newContent = [regex]::Replace($content, $pattern, '')
                Set-Content -LiteralPath $agentsMd -Value $newContent -Encoding UTF8 -NoNewline
                Write-Ok "Bloque SERENA removido de AGENTS.md"
            } else { Write-Warn "Bloque SERENA no encontrado en AGENTS.md" }
        }
    } else { Write-Warn "AGENTS.md no encontrado (nada que limpiar)" }
}

# ====================================================================
# PRESET OPTIMO (stack recomendado)
# ====================================================================
# MODIFICADO: en modo 'all' NO elimina repomix ni serena (sin exclusividad).
# En modos 'minimo'/'repomix'/'serena' mantiene la exclusividad original.

function Set-OptimalPluginList {
    Write-Step "OPT" "Normalizando array plugin (solo context-mode)"
    if ($DryRun) { Write-Warn "[DryRun] Se reescribiria plugin -> [context-mode]"; return }
    $cfg = Load-Config $ocConfig
    $desired = @("context-mode")
    $kept = @()
    if ($cfg.PSObject.Properties.Name -contains 'plugin') {
        foreach ($p in @($cfg.plugin)) {
            $base = _PluginBase $p
            if ($base -eq 'context-mode') { $kept += 'context-mode' }
        }
    }
    $kept = @($kept | Select-Object -Unique)
    if ($kept.Count -eq 0) { $kept = @('context-mode') }
    $cfg | Add-Member -NotePropertyName 'plugin' -NotePropertyValue $kept -Force
    New-FileBackup -Path $ocConfig -Phase 'opt' | Out-Null
    Save-Config $ocConfig $cfg
    Write-Ok "plugin = ['context-mode'] (DCP eliminado si estaba)"
}

function Set-OptimalContextFlags {
    Write-Step "OPT" "Apagando 8 flags que se solapan entre si"
    if ($DryRun) { Write-Warn "[DryRun] Se apagarian 8 flags + 2 sintonizadas"; return }
    $cfg = Load-Config $ocConfig
    Set-OpencodeJsonFlag $cfg 'aggressive_truncation'           $false | Out-Null
    Set-OpencodeJsonFlag $cfg 'preemptive_compaction'           $false | Out-Null
    Set-OpencodeJsonFlag $cfg 'truncate_all_tool_outputs'       $false | Out-Null
    Set-OpencodeJsonFlag $cfg 'dynamic_context_pruning.enabled' $false | Out-Null
    Set-OpencodeJsonFlag $cfg 'deduplication.enabled'           $true  | Out-Null
    Set-OpencodeJsonFlag $cfg 'supersede_writes.enabled'        $false | Out-Null
    Set-OpencodeJsonFlag $cfg 'supersede_writes.aggressive'     $false | Out-Null
    Set-OpencodeJsonFlag $cfg 'purge_errors.enabled'            $false | Out-Null
    Set-OpencodeJsonFlag $cfg 'purge_errors.turns'              1 | Out-Null
    Set-OpencodeJsonFlag $cfg 'context_protection.turns'         3 | Out-Null
    New-FileBackup -Path $ocConfig -Phase 'opt' | Out-Null
    Save-Config $ocConfig $cfg
    Write-Ok "Flags apagadas: aggressive_truncation, preemptive_compaction, truncate_all_tool_outputs"
    Write-Ok "                dynamic_context_pruning.enabled, supersede_writes.enabled, supersede_writes.aggressive"
    Write-Ok "                purge_errors.enabled"
    Write-Ok "Flag encendida: deduplication.enabled (complementaria, no solapa con context-mode)"
    Write-Ok "Sintonizadas:    purge_errors.turns=1, context_protection.turns=3"
}

function Set-OptimalMcpList {
    param([string]$Profile)  # 'all' | 'minimo' | 'repomix' | 'serena'
    Write-Step "OPT" "Normalizando MCPs (perfil: $Profile)"
    if ($DryRun) { Write-Warn "[DryRun] Perfil=$Profile"; return }
    $cfg = Load-Config $ocConfig
    if (-not ($cfg.PSObject.Properties.Name -contains 'mcp')) {
        $cfg | Add-Member -NotePropertyName 'mcp' -NotePropertyValue ([PSCustomObject]@{}) -Force
    }

    # En modo 'all' NO eliminamos repomix ni serena (sin exclusividad)
    if ($Profile -ne 'all') {
        # Quitar la vision que NO toca (comportamiento original)
        if ($Profile -ne 'repomix' -and (Test-McpExists $cfg 'repomix')) {
            Remove-McpEntry $cfg 'repomix'; Write-Warn "MCP repomix removido (Perfil=$Profile)"
        }
        if ($Profile -ne 'serena' -and (Test-McpExists $cfg 'serena')) {
            Remove-McpEntry $cfg 'serena'; Write-Warn "MCP serena removido (Perfil=$Profile)"
        }
    }

    # Asegurar los MCP fijos del router (no se tocan si existen)
    foreach ($must in @('router-klia', 'klia-token-optimizer')) {
        if (-not (Test-McpExists $cfg $must)) {
            Write-Warn "MCP $must ausente en config (se anadira en la fase del router)"
        }
    }

    # Limpiar MCPs que se solapan con Semble si quedaron activos
    foreach ($conflict in @('llmlingua', 'context-mode', 'context_mode')) {
        if (Test-McpExists $cfg $conflict) {
            Remove-McpEntry $cfg $conflict; Write-Warn "MCP conflictivo '$conflict' removido"
        }
    }

    New-FileBackup -Path $ocConfig -Phase 'opt' | Out-Null
    Save-Config $ocConfig $cfg
    Write-Ok "MCPs normalizados. Perfil del stack: $Profile"
}

# ====================================================================
# INTEGRACION V2 DE KLIA (fix: V2 usa mcp directo + plugin + AGENTS.md)
# ====================================================================

function Get-ProjectConfigPath {
    return Join-Path $projectRoot 'opencode.json'
}

function Load-ProjectConfig {
    $path = Get-ProjectConfigPath
    if (-not (Test-Path $path)) { return [PSCustomObject]@{} }
    return Load-Config $path
}

function Save-ProjectConfig {
    param([object]$Config)
    $path = Get-ProjectConfigPath
    Save-Config $path $Config
}

function Set-KliaMcpV2 {
    param([string]$McpServerPath, [string]$HistoryPath, [string]$MetricsPath, [string]$EventsPath)
    $cfg = Load-ProjectConfig
    if (-not ($cfg.PSObject.Properties.Name -contains 'mcp')) {
        $cfg | Add-Member -NotePropertyName 'mcp' -NotePropertyValue ([PSCustomObject]@{}) -Force
    }
    # Eliminar configuracion legacy incorrecta mcp.servers si existe
    if ($cfg.mcp.PSObject.Properties.Name -contains 'servers') {
        $cfg.mcp.PSObject.Properties.Remove('servers')
    }
    $entry = [PSCustomObject]@{
        type    = 'local'
        command = @('node', ($McpServerPath -replace '\\', '/'))
        enabled = $true
        environment = [PSCustomObject]@{
            ROUTER_HISTORY_PATH     = ($HistoryPath -replace '\\', '/')
            ROUTER_METRICS_PATH     = ($MetricsPath -replace '\\', '/')
            ROUTER_EVENTS_PATH      = ($EventsPath -replace '\\', '/')
            ROUTER_MIN_CONFIDENCE   = '0.6'
            ROUTER_EXPLORATION_RATE = '0.1'
            ROUTER_MIN_SAMPLES      = '3'
        }
    }
    if ($cfg.mcp.PSObject.Properties.Name -contains 'klia-token-optimizer') {
        $cfg.mcp.'klia-token-optimizer' = $entry
    } else {
        $cfg.mcp | Add-Member -NotePropertyName 'klia-token-optimizer' -NotePropertyValue $entry -Force
    }
    Save-ProjectConfig $cfg
}

# Migra los MCP de estrategia (Semble/Repomix/Serena/...) de la config global
# a mcp de opencode.json del proyecto en formato V2.
function Set-KliaStrategyServersV2 {
    $legacy = Load-Config $ocConfig
    if (-not $legacy.mcp) { return }
    $cfg = Load-ProjectConfig
    if (-not ($cfg.PSObject.Properties.Name -contains 'mcp')) {
        $cfg | Add-Member -NotePropertyName 'mcp' -NotePropertyValue ([PSCustomObject]@{}) -Force
    }
    # Limpiar posible config legacy incorrecta mcp.servers
    if ($cfg.mcp.PSObject.Properties.Name -contains 'servers') {
        $cfg.mcp.PSObject.Properties.Remove('servers')
    }
    $added = @()
    foreach ($name in $legacy.mcp.PSObject.Properties.Name) {
        if ($name -eq 'klia-token-optimizer') { continue }
        if ($name -eq 'servers') { continue }
        $def = $legacy.mcp.$name
        if (-not $def.command) { continue }
        $entry = [PSCustomObject]@{
            type        = 'local'
            command     = $def.command
            enabled     = ($def.enabled -ne $false)
            environment = if ($def.environment) { $def.environment } elseif ($def.env) { $def.env } else { [PSCustomObject]@{} }
        }
        if ($cfg.mcp.PSObject.Properties.Name -contains $name) {
            $cfg.mcp.$name = $entry
        } else {
            $cfg.mcp | Add-Member -NotePropertyName $name -NotePropertyValue $entry -Force
        }
        $added += $name
    }
    Save-ProjectConfig $cfg
    if ($added.Count -gt 0) { Write-Ok ("MCP de estrategia migrados a V2: " + ($added -join ', ')) }
}

function Inject-KliaRoutingAgents {
    $block = $KLIA_ROUTER_AGENTS_BLOCK.Trim()
    if (-not (Test-Path $agentsMd)) {
        $block | Out-File $agentsMd -Encoding UTF8
        return
    }
    $content = Get-Content $agentsMd -Raw
    $pattern = '(?s)<!-- KLIA_ROUTER_START -->.*?<!-- KLIA_ROUTER_END -->'
    if ($content -match $pattern) {
        # MatchEvaluator evita que los '$' del bloque se interpreten como grupos.
        $evaluator = [System.Text.RegularExpressions.MatchEvaluator] { param($m) $block }
        $content = [regex]::Replace($content, $pattern, $evaluator)
    } else {
        $content = $content.TrimEnd() + "`r`n`r`n" + $block + "`r`n"
    }
    Set-Content -LiteralPath $agentsMd -Value $content -Encoding UTF8 -NoNewline
}

function Add-KliaAutoRecordPlugin {
    $cfg = Load-ProjectConfig
    $relPlugin = './.opencode/plugin/klia-auto-record.js'
    if (-not ($cfg.PSObject.Properties.Name -contains 'plugin')) {
        $cfg | Add-Member -NotePropertyName 'plugin' -NotePropertyValue @($relPlugin) -Force
        return $true
    }
    $exists = $false
    foreach ($p in @($cfg.plugin)) {
        if ($p -eq $relPlugin) { $exists = $true; break }
    }
    if (-not $exists) {
        $cfg.plugin = @($cfg.plugin) + $relPlugin
    }
    return -not $exists
}

function Install-KliaV2 {
    Write-Step "KLIA-V2" "Integracion V2 (mcp directo + plugin + AGENTS.md)"
    if ($DryRun) { Write-Warn "[DryRun] Se escribiria mcp directo, plugin y el bloque KLIA_ROUTER en opencode.json del proyecto"; return $true }
    $projectConfigPath = Get-ProjectConfigPath
    New-FileBackup -Path $projectConfigPath -Phase 'kliav2' | Out-Null
    New-FileBackup -Path $agentsMd -Phase 'kliav2' | Out-Null
    $historyPath = Join-Path $projectRoot "data/history.json"
    $metricsPath = Join-Path $projectRoot "data/mcp-metrics.json"
    $eventsPath  = Join-Path $projectRoot "data/events.json"
    Set-KliaMcpV2 -McpServerPath (Join-Path $projectRoot 'dist/mcp-server.js') -HistoryPath $historyPath -MetricsPath $metricsPath -EventsPath $eventsPath
    Set-KliaStrategyServersV2
    $pluginAdded = Add-KliaAutoRecordPlugin
    Save-ProjectConfig (Load-ProjectConfig)
    Inject-KliaRoutingAgents
    if ($pluginAdded) { Write-Ok "Plugin klia-auto-record anadido a opencode.json del proyecto" }
    Write-Ok "Klia integrado en formato V2: mcp['klia-token-optimizer'] + plugin + bloque KLIA_ROUTER en AGENTS.md"
    return $true
}

function Uninstall-KliaV2 {
    Write-Step "KLIA-V2" "Quitando integracion V2"
    $projectConfigPath = Get-ProjectConfigPath
    if (-not $DryRun -and (Test-Path $projectConfigPath)) {
        $cfg = Load-ProjectConfig
        if ($cfg.mcp -and ($cfg.mcp.PSObject.Properties.Name -contains 'klia-token-optimizer')) {
            New-FileBackup -Path $projectConfigPath -Phase 'kliav2' | Out-Null
            $cfg.mcp.PSObject.Properties.Remove('klia-token-optimizer')
            Save-ProjectConfig $cfg
            Write-Ok "mcp['klia-token-optimizer'] eliminado de opencode.json del proyecto"
        }
        # Tambien limpiar legacy mcp.servers si existe
        if ($cfg.mcp -and $cfg.mcp.PSObject.Properties.Name -contains 'servers') {
            New-FileBackup -Path $projectConfigPath -Phase 'kliav2' | Out-Null
            $cfg.mcp.PSObject.Properties.Remove('servers')
            Save-ProjectConfig $cfg
            Write-Ok "mcp.servers legacy eliminado de opencode.json del proyecto"
        }
        if ($cfg.PSObject.Properties.Name -contains 'plugin') {
            $cfg.plugin = @($cfg.plugin | Where-Object { $_ -ne './.opencode/plugin/klia-auto-record.js' })
            if ($cfg.plugin.Count -eq 0) { $cfg.PSObject.Properties.Remove('plugin') }
            Save-ProjectConfig $cfg
            Write-Ok "Plugin klia-auto-record eliminado de opencode.json del proyecto"
        }
    }
    if (-not $DryRun -and (Test-Path $agentsMd)) {
        $content = Get-Content $agentsMd -Raw
        if ($content -match 'KLIA_ROUTER_START') {
            New-FileBackup -Path $agentsMd -Phase 'kliav2' | Out-Null
            $content = [regex]::Replace($content, '(?s)\r?\n*<!-- KLIA_ROUTER_START -->.*?<!-- KLIA_ROUTER_END -->\r?\n*', "`n")
            Set-Content -LiteralPath $agentsMd -Value $content -Encoding UTF8 -NoNewline
            Write-Ok "Bloque KLIA_ROUTER eliminado de AGENTS.md"
        }
    }
}

# ====================================================================
# CONTENIDO EMBEDIDO: System prompt para OpenCode
# ====================================================================

$systemPromptText = @'
Eres un agente de codificacion asistido por un router adaptativo de optimizacion de contexto llamado klia-token-optimizer.

AL ARRANCAR una sesion, antes de cualquier otra cosa, haz una verificacion automatica:
1. Invoca la MCP tool route_task de klia-token-optimizer con:
   - model: el modelo que estas usando
   - query: "verificacion de arranque"
   - fileCount: 0
   - contextSizeBytes: 0
2. Si route_task responde con un optimizador y un taskType, informa al usuario de forma breve:
   "klia-token-optimizer activo: router responde OK (optimizador=<valor>, taskType=<valor>)."
3. Si route_task no responde o falla, informa al usuario:
   "klia-token-optimizer NO responde. Revisa la instalacion del servidor MCP en ~/.config/opencode/mcp.json."
Esta verificacion solo se hace una vez por sesion, al inicio.

ANTES de ejecutar cualquier tarea significativa (refactor, busqueda en repo, comandos de terminal, tareas multistep, o contextos grandes), DEBES invocar la MCP tool route_task de klia-token-optimizer con estos parametros:
- model: el modelo actual que estas usando
- query: descripcion breve de la tarea
- fileCount: numero de archivos implicados
- contextSizeBytes: tamano estimado del contexto en bytes
- toolCallsExpected: low | medium | high
- hasTerminalCommands: true si hay comandos de terminal
- isRefactor: true si es refactor
- isRepositorySearch: true si es busqueda en repo
- isMultistep: true si son muchos pasos

La tool devolvera un optimizador recomendado: BASELINE, DCP, RTK, CONTEXT_MODE, REPOMIX o SEMBLE. Aplica la estrategia correspondiente:
- BASELINE: ejecuta normalmente.
- DCP: activa compresion dinamica de contexto.
- RTK: intercepta y reduce salidas de CLI.
- CONTEXT_MODE: usa indices/docs de Context Mode.
- REPOMIX: empaqueta el repositorio de forma selectiva.
- SEMBLE: usa busqueda semantica de codigo.

DESPUES de ejecutar, las metricas reales (tokens, latencia, coste) se registran automaticamente
via el plugin klia-auto-record. No necesitas invocar record_execution manualmente.

No ignores esta instruccion. Si no estas seguro de que optimizador usar, consulta siempre route_task.
'@

# ====================================================================
# BANNER + AYUDA + CONFIRMACION
# ====================================================================

function Show-Help {
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "  install_klia_token_optimizer.ps1" -ForegroundColor Cyan
    Write-Host "  Instalador unificado: klia-token-optimizer (router MCP)" -ForegroundColor Cyan
    Write-Host "  + Semble + Context Mode + RTK + Repomix + Serena" -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "QUE HACE" -ForegroundColor Yellow
    Write-Host "  Instala en 12 fases un router inteligente que decide, antes de"
    Write-Host "  cada tarea, que optimizador de contexto debe usar OpenCode para"
    Write-Host "  gastar menos tokens. Aprende del historico real (tokens, latencia,"
    Write-Host "  coste, calidad) y no presupone que un optimizador sea universalmente"
    Write-Host "  mejor."
    Write-Host ""
    Write-Host "  Optimizadores instalados:" -ForegroundColor Yellow
    Write-Host "    - Semble          Buscador semantico de codigo (97.8% ahorro)"
    Write-Host "    - Context Mode    Indexacion FTS5 + recuperacion (~42% ahorro)"
    Write-Host "    - RTK              Compresion de salida CLI (92% ahorro)"
    Write-Host "    - Repomix          Empaquetador de repos (52-64% ahorro)"
    Write-Host "    - Serena           IDE semantico via LSP (simbolos exactos)"
    Write-Host "    - klia-token-optimizer  Router MCP que decide el optimizador"
    Write-Host ""
    Write-Host "PARAMETROS" -ForegroundColor Yellow
    Write-Host "  .\install_klia_token_optimizer.ps1                          Desatendido. Instala los 5 optimizadores + router."
    Write-Host "  .\install_klia_token_optimizer.ps1 -StackOnly -StackProfile repomix   Solo stack con perfil repomix."
    Write-Host "  .\install_klia_token_optimizer.ps1 -StackOnly -StackProfile serena    Solo stack con perfil serena."
    Write-Host "  .\install_klia_token_optimizer.ps1 -StackOnly -StackProfile minimo    Stack minimo."
    Write-Host "  .\install_klia_token_optimizer.ps1 -Interactive             Menu interactivo (8 opciones)."
    Write-Host "  .\install_klia_token_optimizer.ps1 -DryRun                  Simula sin tocar nada."
    Write-Host "  .\install_klia_token_optimizer.ps1 -SkipBackup              No genera .bak-* antes de modificar."
    Write-Host "  .\install_klia_token_optimizer.ps1 -Force                   Reinstala sin pedir confirmacion."
    Write-Host "  .\install_klia_token_optimizer.ps1 -Uninstall               Desinstala el router + los 5 optimizadores."
    Write-Host ""
    Write-Host "REQUISITOS" -ForegroundColor Yellow
    Write-Host "    - Node.js >= 22.5 (requerido por Context Mode)"
    Write-Host "    - npm"
    Write-Host "    - uv (instalado automaticamente si falta)"
    Write-Host "    - opencode (instalado automaticamente si falta)"
    Write-Host ""
    Write-Host "  Idempotente: re-ejecutable sin romper nada. Genera backups .bak-*"
    Write-Host "  antes de modificar opencode.jsonc y AGENTS.md."
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
}

Show-Help

if ($DryRun)   { Write-Warn "DRY-RUN activo: no se haran cambios reales." }
if ($Force)    { Write-Warn "Force activo: reinstala sin pedir confirmacion." }
if ($SkipBackup) { Write-Warn "SkipBackup activo: no se generaran .bak-* antes de modificar." }
if ($Interactive) { Write-Warn "Interactive activo: se usara el menu interactivo." }
if ($StackOnly) { Write-Warn "StackOnly activo: solo se instalara el stack (no el router)." }
if ($StackProfile -and $StackProfile -ne 'all') { Write-Warn "StackProfile: $StackProfile" }

# Pregunta de confirmacion (no preguntar si -Force, -DryRun o -Uninstall)
$needConfirm = $true
if ($Force)   { $needConfirm = $false }
if ($DryRun)  { $needConfirm = $false }
if ($Uninstall) { $needConfirm = $false }
if ($Interactive) { $needConfirm = $false }
if ($V2Only) { $needConfirm = $false }

if ($needConfirm) {
    Write-Host ""
    $resp = Read-Host "Deseas continuar con la instalacion? [s/n]"
    if ($resp -ne 's' -and $resp -ne 'S' -and $resp -ne 'y' -and $resp -ne 'Y') {
        Write-Host "Instalacion cancelada por el usuario." -ForegroundColor Yellow
        exit 0
    }
    Write-Host ""
}

# ====================================================================
# FAST-PATH: -Uninstall
# ====================================================================
if ($Uninstall) {
    Write-Host ""
    Write-Host "Modo desinstalacion (-Uninstall)" -ForegroundColor Cyan
    if ($DryRun) { Write-Warn "DryRun activo: no se haran cambios" }
    Uninstall-Semble
    Uninstall-ContextMode
    Uninstall-Rtk
    Uninstall-Repomix
    Uninstall-Serena
    Uninstall-KliaV2
    # Remover MCP klia-token-optimizer de opencode.jsonc
    $cfg = Load-Config $ocConfig
    Remove-McpEntry $cfg 'klia-token-optimizer'
    if (-not $DryRun) { Save-Config $ocConfig $cfg; Write-Ok "MCP klia-token-optimizer removido de opencode.jsonc" }
    # Remover plugin klia-auto-record.js del proyecto
    $projectPluginDir = Join-Path $projectRoot ".opencode\plugin"
    $kliaPluginPath = Join-Path $projectPluginDir "klia-auto-record.js"
    if (Test-Path -LiteralPath $kliaPluginPath) {
        if (-not $DryRun) { Remove-Item -LiteralPath $kliaPluginPath -Force; Write-Ok "plugin/klia-auto-record.js eliminado" }
    }
    Write-Host ""
    Write-Host "Desinstalacion completada." -ForegroundColor Green
    Write-Host "Nota: el binario rtk no se borra (winget/cargo/GitHub)." -ForegroundColor Yellow
    Write-Host "Nota: los paquetes npm (repomix, context-mode) requieren npm uninstall -g manual." -ForegroundColor Yellow
    exit 0
}

# ====================================================================
# FAST-PATH: -V2Only (aplicar solo la integracion V2 de Klia)
# ====================================================================
if ($V2Only) {
    Write-Host ""
    Write-Host "Modo -V2Only: aplicar solo la integracion V2 de Klia (mcp directo + plugin + AGENTS.md)" -ForegroundColor Cyan
    if ($DryRun) { Write-Warn "DryRun activo: no se haran cambios" }
    if (-not (Test-Path (Join-Path $projectRoot 'dist/mcp-server.js'))) {
        Write-Err "No existe dist/mcp-server.js. Ejecuta 'npm run build' antes."
        exit 1
    }
    Install-KliaV2 | Out-Null
    Write-Host ""
    Write-Host "Integracion V2 aplicada. Reinicia OpenCode para cargarla." -ForegroundColor Green
    exit 0
}

# ====================================================================
# FASE 0: Pre-checks (opencode, Node >= 22.5, npm, uv)
# ====================================================================
Write-Step "0" "Pre-checks"

# 0a. opencode
if (Test-Command "opencode") {
    Write-Ok "opencode ya esta instalado"
} else {
    Write-Warn "opencode no esta instalado"
    if ($Force) {
        Write-Step "0" "Instalando opencode (Force)"
        if (-not $DryRun) {
            & npm install -g opencode-ai
            if ($LASTEXITCODE -ne 0) { Write-Err "Fallo la instalacion de opencode"; exit 1 }
        }
    } else {
        $resp = Read-Host "Deseas instalarlo ahora via npm install -g opencode-ai? [s/n]"
        if ($resp -eq 's' -or $resp -eq 'S' -or $resp -eq 'y' -or $resp -eq 'Y') {
            Write-Step "0" "Instalando opencode"
            if (-not $DryRun) {
                & npm install -g opencode-ai
                if ($LASTEXITCODE -ne 0) { Write-Err "Fallo la instalacion de opencode"; exit 1 }
            }
        } else {
            Write-Err "opencode es obligatorio. Abortando."
            exit 1
        }
    }
    if (-not $DryRun -and -not (Test-Command "opencode")) {
        Write-Err "opencode sigue sin estar en PATH. Reinicia la terminal y vuelve a ejecutar."
        exit 1
    }
}

# 0b. Node >= 22.5
if (-not (Test-Command "node")) {
    Write-Err "node no encontrado. Instala Node.js >= 22.5 antes de continuar."
    exit 1
}
$nodeRaw = & node --version
$nodeVer = $nodeRaw.TrimStart('v')
$nodeParts = $nodeVer.Split('.')
$nodeMajor = [int]$nodeParts[0]
$nodeMinor = if ($nodeParts.Length -gt 1) { [int]$nodeParts[1] } else { 0 }
$nodeOk = $true
if ($nodeMajor -lt 22) { $nodeOk = $false }
elseif ($nodeMajor -eq 22 -and $nodeMinor -lt 5) { $nodeOk = $false }
if ($nodeOk) {
    Write-Ok "Node.js $nodeVer (>= 22.5)"
} else {
    Write-Err "Node.js $nodeVer no cumple el requisito (>= 22.5). Actualiza Node."
    $resp = Read-Host "Continuar de todos modos? [s/n]"
    if ($resp -ne 's' -and $resp -ne 'S') { exit 1 }
}

# 0c. npm
if (Test-Command "npm") { Write-Ok "npm presente" } else { Write-Err "npm no encontrado"; exit 1 }

# 0d. uv (lo instala Serena si falta, pero lo verificamos aqui para info)
if (Test-Command "uv") { Write-Ok "uv presente (necesario para Semble y Serena)" }
else { Write-Warn "uv no presente (se instalara automaticamente en la fase de Serena)" }

# ====================================================================
# FASE 1-5: Instalar optimizadores
# ====================================================================
Write-Step "1-5" "Instalando optimizadores de contexto (perfil: $StackProfile)"

# Backup previo de opencode.jsonc y AGENTS.md
if (-not $DryRun) {
    $backupDir = Backup-OpenCode $ocConfig $agentsMd
    Write-Ok "Backup previo en: $backupDir"
}

# Mapear perfil a que optimizadores instalar
$installSemble = $true
$installCtx    = $true
$installRtk    = $true
$installRepomix = ($StackProfile -eq 'all' -or $StackProfile -eq 'repomix')
$installSerena  = ($StackProfile -eq 'all' -or $StackProfile -eq 'serena')

# Resultados de cada instalacion (para ajustar base-rules.ts despues)
$installResults = @{}

if ($installSemble) {
    Write-Step "1" "Instalando Semble"
    $ok = Install-Semble
    $installResults['SEMBLE'] = $ok
    if (-not $ok) { Write-Warn "Semble fallo. Se usara BASELINE en su lugar." }
}

if ($installCtx) {
    Write-Step "2" "Instalando Context Mode"
    $ok = Install-ContextMode
    $installResults['CONTEXT_MODE'] = $ok
    if (-not $ok) { Write-Warn "Context Mode fallo. Se usara BASELINE en su lugar." }
}

if ($installRtk) {
    Write-Step "3" "Instalando RTK"
    $ok = Install-Rtk
    $installResults['RTK'] = $ok
    if (-not $ok) { Write-Warn "RTK fallo. Se usara BASELINE en su lugar." }
}

if ($installRepomix) {
    Write-Step "4" "Instalando Repomix"
    $ok = Install-Repomix
    $installResults['REPOMIX'] = $ok
    if (-not $ok) { Write-Warn "Repomix fallo. Se usara BASELINE en su lugar." }
}

if ($installSerena) {
    Write-Step "5" "Instalando Serena"
    $ok = Install-Serena
    $installResults['SERENA'] = $ok
    if (-not $ok) { Write-Warn "Serena fallo. (No afecta base-rules.ts directamente)" }
}

# ====================================================================
# FASE 6: Preset (normalizar plugin, MCPs, flags)
# ====================================================================
Write-Step "6" "Aplicando preset (plugin, MCPs, flags)"
Set-OptimalPluginList
Set-OptimalMcpList -Profile $StackProfile
Set-OptimalContextFlags

# Inyectar bloques de routing en AGENTS.md para los que se instalaron
Write-Step "6" "Inyectando bloques de routing en AGENTS.md"
if (-not $DryRun) {
    if ($installSemble) { Inject-SembleRoutingBlock }
    # Los bloques RTK/REPOMIX/SERENA ya se inyectan dentro de sus Install-* respectivas
}

# ====================================================================
# FASE 7: Ajustar base-rules.ts (BASELINE para optimizadores que fallaron)
# ====================================================================
Write-Step "7" "Ajustando base-rules.ts"

$baseRulesPath = Join-Path $projectRoot "src\rules\base-rules.ts"
$unavailableOptimizers = @()

# Mapear resultados a nombres de optimizadores del router
foreach ($key in $installResults.Keys) {
    if (-not $installResults[$key]) {
        # SEMBLE, CONTEXT_MODE, RTK, REPOMIX son los que usa el router
        if ($key -in @('SEMBLE', 'CONTEXT_MODE', 'RTK', 'REPOMIX')) {
            $unavailableOptimizers += $key
        }
    }
}

if ($unavailableOptimizers.Count -gt 0) {
    if (-not (Test-Path -LiteralPath $baseRulesPath)) {
        Write-Warn "No se encontro $baseRulesPath. No se pudo ajustar."
    } else {
        if (-not $DryRun) {
            $content = Get-Content -LiteralPath $baseRulesPath -Raw -Encoding UTF8
            $backup = "$baseRulesPath.backup.$(Get-Date -Format 'yyyyMMddHHmmss')"
            Copy-Item -LiteralPath $baseRulesPath -Destination $backup -Force
            Write-Ok "Backup de base-rules.ts en: $backup"

            foreach ($opt in $unavailableOptimizers) {
                $pattern = "'$opt'"
                $replacement = "'BASELINE'"
                $content = $content -replace [regex]::Escape($pattern), $replacement
                Write-Ok "$opt reemplazado por BASELINE en BASE_RULES"
            }

            # Evitar duplicados consecutivos de BASELINE
            $content = $content -replace "\['BASELINE'(,\s*'BASELINE')+", "['BASELINE'"
            $content = $content -replace "('BASELINE',\s*)+'BASELINE'", "'BASELINE'"

            Set-Content -LiteralPath $baseRulesPath -Value $content -NoNewline -Encoding UTF8
            Write-Ok "base-rules.ts actualizado. Optimizadores no disponibles sustituidos por BASELINE."
        } else {
            Write-Warn "[DryRun] Se reemplazarian por BASELINE: $($unavailableOptimizers -join ', ')"
        }
    }
} else {
    Write-Ok "Todos los optimizadores disponibles. No se ajusta base-rules.ts."
}

# ====================================================================
# FASE 8: npm install (dependencias del proyecto)
# ====================================================================
Write-Step "8" "Instalando dependencias (npm install)"

if ($DryRun) {
    Write-Warn "[DryRun] Se ejecutaria npm install --no-audit --no-fund"
} else {
        # Siempre ejecutar npm install para asegurar que las dependencias coincidan con package.json.
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            Write-Err "npm install fallo. Revisa el output anterior."
            exit 1
        }
        Write-Ok "Dependencias instaladas/actualizadas"
    }

# ====================================================================
# FASE 9: Compilar TypeScript -> dist/
# ====================================================================
Write-Step "9" "Compilando el proyecto (npm run build)"

if ($DryRun) {
    Write-Warn "[DryRun] Se ejecutaria npm run build"
} else {
    $needBuild = $false
    if (-not (Test-Path -LiteralPath "dist")) { $needBuild = $true }
    elseif (-not (Test-Path -LiteralPath "dist\mcp-server.js")) { $needBuild = $true }
    else {
        $srcTime = (Get-ChildItem -Path "src" -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
        $distTime = (Get-Item -LiteralPath "dist\mcp-server.js").LastWriteTime
        if ($srcTime -gt $distTime) { $needBuild = $true; Write-Warn "Codigo fuente mas reciente que dist/. Recompilando." }
    }

    if ($needBuild) {
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            Write-Err "npm run build fallo. Revisa el output anterior."
            exit 1
        }
        Write-Ok "Proyecto compilado en dist/"
    } else {
        # Siempre recompilar para asegurar que dist/ contiene la ultima version del codigo fuente.
        Write-Warn "dist/ parece actualizado, pero se fuerza la recompilacion para garantizar la ultima version."
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            Write-Err "npm run build fallo. Revisa el output anterior."
            exit 1
        }
        Write-Ok "Proyecto recompilado en dist/ (ultima version del codigo fuente)"
    }
}

# ====================================================================
# FASE 10: Preparar data/ y calibrar
# ====================================================================
Write-Step "10" "Preparando almacenamiento del router"

$historyDir = Join-Path $projectRoot "data"
$historyPath = Join-Path $historyDir "history.json"
$eventsPath  = Join-Path $historyDir "events.json"
$metricsPath = Join-Path $historyDir "mcp-metrics.json"

if (-not $DryRun) {
    if (-not (Test-Path -LiteralPath $historyDir)) {
        New-Item -ItemType Directory -Path $historyDir -Force | Out-Null
        Write-Ok "Directorio creado: $historyDir"
    } else { Write-Ok "Directorio de historico ya existe" }

    if (-not (Test-Path -LiteralPath $historyPath)) {
        "[]" | Set-Content -LiteralPath $historyPath -Encoding UTF8
        Write-Ok "Historico inicializado: $historyPath"
    } else { Write-Ok "Historico ya existe" }

    if (-not (Test-Path -LiteralPath $metricsPath)) {
        "[]" | Set-Content -LiteralPath $metricsPath -Encoding UTF8
        Write-Ok "Metricas MCP inicializadas: $metricsPath"
    } else { Write-Ok "Metricas MCP ya existen" }

    if (-not (Test-Path -LiteralPath $eventsPath)) {
        "[]" | Set-Content -LiteralPath $eventsPath -Encoding UTF8
        Write-Ok "Eventos v2 inicializados: $eventsPath"
    } else { Write-Ok "Eventos v2 ya existen" }

    # Calibrar si esta vacio
    $isEmpty = $true
    if (Test-Path -LiteralPath $historyPath) {
        $raw = Get-Content -LiteralPath $historyPath -Raw -Encoding UTF8
        if ($raw.Trim() -ne "[]") {
            $parsed = $null
            try { $parsed = $raw | ConvertFrom-Json } catch {}
            if ($parsed -and @($parsed).Count -gt 0) { $isEmpty = $false }
        }
    }

    if ($isEmpty) {
        Write-Step "10" "Calibrando historico con benchmarks iniciales"
        & npm run calibrate -- --history $historyPath --repetitions 3
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "La calibracion fallo. El router arrancara en V0 (reglas base)."
        } else {
            Write-Ok "Historico calibrado con registros BASELINE"
        }
    } else {
        Write-Ok "Historico ya tiene registros. Calibracion omitida."
    }
} else {
    Write-Warn "[DryRun] Se prepararia .router-history/ y se calibraria si esta vacio"
}

# ====================================================================
# FASE 11: Registrar MCP klia-token-optimizer en opencode.jsonc
# ====================================================================
Write-Step "11" "Instalando configuracion MCP en OpenCode"

if ($DryRun) {
    Write-Warn "[DryRun] Se registraria klia-token-optimizer en $ocConfig"
} else {
    $cfg = Load-Config $ocConfig
    $mcpEntry = [PSCustomObject]@{
        type    = 'local'
        command = @('node', "$projectRoot\dist\mcp-server.js" -replace '\\', '/')
        enabled = $true
        env = [PSCustomObject]@{
            ROUTER_HISTORY_PATH      = ($historyPath -replace '\\', '/')
            ROUTER_METRICS_PATH      = ($metricsPath -replace '\\', '/')
            ROUTER_MIN_CONFIDENCE    = '0.6'
            ROUTER_EXPLORATION_RATE  = '0.1'
            ROUTER_MIN_SAMPLES       = '3'
            ROUTER_LATENCY_WEIGHT    = '1.0'
            ROUTER_TOOLING_COST_WEIGHT = '1.0'
            ROUTER_FAILURE_PENALTY   = '5.0'
            ROUTER_QUALITY_PENALTY   = '3.0'
        }
    }
    Set-McpEntry $cfg 'klia-token-optimizer' $mcpEntry
    Save-Config $ocConfig $cfg
    Write-Ok "Configuracion MCP instalada en: $ocConfig"
}

# ====================================================================
# FASE 12: System prompt + plugin klia-auto-record
# ====================================================================
Write-Step "12" "Configurando system prompt y plugin en OpenCode"

if ($DryRun) {
    Write-Warn "[DryRun] Se registraria MCP klia-token-optimizer y plugin ./.opencode/plugin/klia-auto-record.js en opencode.json del proyecto"
} else {
    # 12a. Inyectar systemPrompt en opencode.jsonc
    $systemPromptJson = $systemPromptText -replace '\\', '\\' -replace '"', '\"' -replace "`r`n", '\n' -replace "`n", '\n'

    if (-not (Test-Path -LiteralPath $ocConfig)) {
        $newConfig = "{`n    `"$schema`": `"https://opencode.ai/config.json`",`n    `"systemPrompt`": `"$systemPromptJson`"`n}"
        Set-Content -LiteralPath $ocConfig -Value $newConfig -Encoding UTF8
        Write-Ok "Archivo creado: $ocConfig"
    } else {
        $rawContent = Get-Content -LiteralPath $ocConfig -Raw -Encoding UTF8
        if ($rawContent -match '"systemPrompt"\s*:') {
            $newContent = [regex]::Replace(
                $rawContent,
                '"systemPrompt"\s*:\s*"(?:[^"\\]|\\.)*"',
                "`"systemPrompt`": `"$systemPromptJson`""
            )
            Write-Ok "System prompt actualizado (reemplazado el existente)"
        } else {
            $newContent = $rawContent -replace '^\s*\{', "{`n    `"systemPrompt`": `"$systemPromptJson`","
            Write-Ok "System prompt inyectado"
        }
        Set-Content -LiteralPath $ocConfig -Value $newContent -NoNewline -Encoding UTF8
        Write-Ok "Configuracion guardada en: $ocConfig"
    }

    # 12b. Asegurar plugin/klia-auto-record.js en el proyecto
    $projectPluginDir = Join-Path $projectRoot ".opencode\plugin"
    if (-not (Test-Path -LiteralPath $projectPluginDir)) {
        New-Item -ItemType Directory -Path $projectPluginDir -Force | Out-Null
    }
    $projectPluginPath = Join-Path $projectPluginDir "klia-auto-record.js"
    if (-not (Test-Path -LiteralPath $projectPluginPath)) {
        $sourcePlugin = Join-Path $projectRoot ".opencode\plugin\klia-auto-record.js"
        if (Test-Path -LiteralPath $sourcePlugin) {
            Copy-Item -LiteralPath $sourcePlugin -Destination $projectPluginPath -Force
        } else {
            Write-Err "Plugin fuente no encontrado: $sourcePlugin"
        }
    }
    Write-Ok "Plugin auto-record disponible en: $projectPluginPath"
}

# ====================================================================
# FASE 13: Integracion V2 de Klia (mcp.servers + AGENTS.md) [FIX]
# ====================================================================
# El instalador historico escribia el MCP y el systemPrompt en formato V1
# (opencode.jsonc), que OpenCode V2 no aplica. Esta fase instala la integracion
# correcta para V2: el MCP bajo mcp.servers y la instruccion de routing en AGENTS.md.
Install-KliaV2 | Out-Null

# ====================================================================
# SMOKE TEST del router
# ====================================================================
Write-Step "ST" "Smoke test del router"

if ($DryRun) {
    Write-Warn "[DryRun] Se ejecutaria npm run router -- --model glm-5.2 --query 'refactoriza auth'"
} else {
    Write-Host "  Ejecutando decision de prueba..." -ForegroundColor DarkGray
    $smokeOutput = & npm run router -- --model glm-5.2 --query "refactoriza el modulo de autenticacion" --files 12 --size 250000 2>&1
    if ($LASTEXITCODE -eq 0) {
        $optimizer = ($smokeOutput | Select-String "^OPTIMIZER=(.+)$").Matches.Groups[1].Value
        $taskType  = ($smokeOutput | Select-String "^TASK_TYPE=(.+)$").Matches.Groups[1].Value
        $version   = ($smokeOutput | Select-String "^VERSION=(.+)$").Matches.Groups[1].Value
        $confidence = ($smokeOutput | Select-String "^CONFIDENCE=(.+)$").Matches.Groups[1].Value

        if ($optimizer) {
            Write-Host ""
            Write-Host "  +-------------------+--------------------------------+" -ForegroundColor Green
            Write-Host "  | Optimizador       | $optimizer" -ForegroundColor Green
            Write-Host "  | Tipo de tarea     | $taskType" -ForegroundColor Green
            Write-Host "  | Version del router| $version" -ForegroundColor Green
            Write-Host "  | Confianza         | $confidence" -ForegroundColor Green
            Write-Host "  +-------------------+--------------------------------+" -ForegroundColor Green
            Write-Ok "Router responde correctamente. El sistema esta operativo."
        } else {
            Write-Warn "El router se ejecuto pero no se pudo parsear la salida."
            Write-Host "  Salida:" -ForegroundColor DarkGray
            $smokeOutput | Select-Object -Last 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        }
    } else {
        Write-Err "El router no respondio. Revisa la compilacion en dist/."
        Write-Host "  Salida de error:" -ForegroundColor DarkGray
        $smokeOutput | Select-Object -Last 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }
}

# ====================================================================
# RESUMEN FINAL
# ====================================================================
Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host " Instalacion completada" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host ""
Write-Host " Servidor MCP:    klia-token-optimizer" -ForegroundColor White
Write-Host " Compilado en:    $projectRoot\dist" -ForegroundColor White
Write-Host " Historico:       $historyPath" -ForegroundColor White
Write-Host " Metricas:        $metricsPath" -ForegroundColor White
Write-Host " Config OpenCode: $(Get-ProjectConfigPath)" -ForegroundColor White
Write-Host " Plugin auto-record: $projectRoot\.opencode\plugin\klia-auto-record.js" -ForegroundColor Green
Write-Host ""
Write-Host " Optimizadores instalados:" -ForegroundColor Cyan
if ($installResults.ContainsKey('SEMBLE') -and $installResults['SEMBLE']) { Write-Host "   [OK] Semble" -ForegroundColor Green }
else { Write-Host "   [XX] Semble (fallo o no instalado)" -ForegroundColor Red }
if ($installResults.ContainsKey('CONTEXT_MODE') -and $installResults['CONTEXT_MODE']) { Write-Host "   [OK] Context Mode" -ForegroundColor Green }
else { Write-Host "   [XX] Context Mode (fallo o no instalado)" -ForegroundColor Red }
if ($installResults.ContainsKey('RTK') -and $installResults['RTK']) { Write-Host "   [OK] RTK" -ForegroundColor Green }
else { Write-Host "   [XX] RTK (fallo o no instalado)" -ForegroundColor Red }
if ($installResults.ContainsKey('REPOMIX') -and $installResults['REPOMIX']) { Write-Host "   [OK] Repomix" -ForegroundColor Green }
elseif ($installRepomix) { Write-Host "   [XX] Repomix (fallo)" -ForegroundColor Red }
if ($installResults.ContainsKey('SERENA') -and $installResults['SERENA']) { Write-Host "   [OK] Serena" -ForegroundColor Green }
elseif ($installSerena) { Write-Host "   [XX] Serena (fallo)" -ForegroundColor Red }
Write-Host ""
if ($unavailableOptimizers.Count -gt 0) {
    Write-Host " Optimizadores ajustados a BASELINE en base-rules.ts: $($unavailableOptimizers -join ', ')" -ForegroundColor Yellow
}
Write-Host " Unico paso que queda:" -ForegroundColor Cyan
Write-Host "   Reinicia OpenCode para que cargue el servidor MCP, el plugin auto-record y los MCP" -ForegroundColor White
Write-Host ""
Write-Host " Comandos utiles:" -ForegroundColor Cyan
Write-Host "   npm run router -- --model glm-5.2 --query ""refactoriza auth"" --files 12 --size 250000" -ForegroundColor Gray
Write-Host "   npm test" -ForegroundColor Gray
Write-Host "   npm run calibrate -- --history data/history.json --repetitions 3" -ForegroundColor Gray
Write-Host ""
