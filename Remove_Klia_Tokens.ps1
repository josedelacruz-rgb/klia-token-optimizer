<#
.SYNOPSIS
    Script de desinstalacion completa para KLIA Token Optimizer y todos sus optimizadores dependientes.

    Desinstala:
    - Semble (via uv tool)
    - Context Mode (via npm)
    - RTK (plugin + configuracion + openrtk via npm)
    - Repomix (via npm)
    - Serena (via uv tool)
    - Entradas MCP, entradas de plugin y bloques de AGENTS.md de OpenCode
    - Comando slash /klia-stats (fichero .md, no vive en opencode.jsonc)

    Garantias:
    - Idempotente: re-ejecutarlo no genera errores ni re-escrituras inutiles del config.
    - El resumen distingue "eliminado" / "ya no existia" / "FALLO" segun el estado real.
    - Verifica exit codes y presencia en disco; nunca asume exito.
    - Nunca reescribe opencode.jsonc si no se pudo parsear (evita dejarlo vacio).
    - Crea un unico backup de opencode.jsonc por ejecucion antes de modificarlo.
    - No usa winget. El binario rtk se deja para baja manual.

    Codigo de salida: 0 = sin fallos, 1 = hubo al menos un FALLO.
#>

$projectRoot = "C:\ProyectosV2\telemetria\klia-token-optimizer - copia"
Set-Location -LiteralPath $projectRoot

# Configuracion de rutas (mismo que el instalador)
if (-not $env:USERPROFILE) { $env:USERPROFILE = [System.Environment]::GetEnvironmentVariable("USERPROFILE", "User") }
if (-not $env:USERPROFILE) { $env:USERPROFILE = [System.Environment]::GetEnvironmentVariable("USERPROFILE", "Process") }
if (-not $env:USERPROFILE) { $env:USERPROFILE = $env:HOME }
$ocConfig   = Join-Path $env:USERPROFILE ".config/opencode/opencode.jsonc"
$ocDir      = Split-Path $ocConfig -Parent
$agentsMd   = Join-Path $ocDir "AGENTS.md"
$ctxDocsMd  = Join-Path $ocDir "docs/context-mode.md"
$RtkPluginDir  = Join-Path $ocDir "plugin"
$RtkPluginPath = Join-Path $RtkPluginDir "openrtk.ts"
$RtkMdPath     = Join-Path $ocDir "RTK.md"
$RtkConfigPath = Join-Path $env:APPDATA "rtk/config.toml"
$RepomixConfigPath = Join-Path $ocDir "repomix.config.json"
$RepomixIgnorePath = Join-Path $ocDir ".repomixignore"
$NpmGlobalModules = Join-Path $env:APPDATA "npm/node_modules"
$UvToolsDir = Join-Path $env:APPDATA "uv/tools"

# ==========================================
# Estado de la ejecucion (para el resumen real)
# ==========================================
$script:Results   = New-Object System.Collections.Generic.List[object]
$script:ConfigBroken = $false
$script:ConfigBackupPath = $null
$script:ConfigDirty = $false

function Add-Result {
    param(
        [string]$Section,
        [string]$Item,
        [ValidateSet('Eliminado','YaNoExistia','Fallo','Conservado')][string]$Status
    )
    $script:Results.Add([PSCustomObject]@{ Section = $Section; Item = $Item; Status = $Status })
}

# Helper functions
function Write-Ok   { param([string]$Msg) Write-Host "  [OK] $Msg" -ForegroundColor Green }
function Write-Err  { param([string]$Msg) Write-Host "  [XX] $Msg" -ForegroundColor Red }
function Write-Warn { param([string]$Msg) Write-Host "  [!!] $Msg" -ForegroundColor Yellow }
function Write-Info { param([string]$Msg) Write-Host "  [--] $Msg" -ForegroundColor DarkGray }
function Write-Step { param([string]$Id, [string]$Msg) Write-Host ""; Write-Host "[$Id] $Msg" -ForegroundColor Cyan }

# ==========================================
# Config seguro (opencode.jsonc)
# ==========================================
function Load-Config {
    param([string]$Path)
    $script:ConfigBroken = $false
    if (-not (Test-Path -LiteralPath $Path)) { return [PSCustomObject]@{} }
    $raw = Get-Content -LiteralPath $Path -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) { return [PSCustomObject]@{} }
    $stripped = $raw -replace '(?m)^\s*//.*$', ''
    try { return $stripped | ConvertFrom-Json } catch {
        # Segundo intento: tolerar comas finales (tipico de JSONC)
        try { return ($stripped -replace '(?m),(\s*[}\]])', '$1') | ConvertFrom-Json } catch {
            $script:ConfigBroken = $true
            return [PSCustomObject]@{}
        }
    }
}

function Save-Config {
    param([string]$Path, [object]$Config)
    if ($script:ConfigBroken) {
        Write-Err "opencode.jsonc NO se reescribe: no se pudo parsear (se evita perder la config original)"
        return $false
    }
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    # Un unico backup por ejecucion, antes de la primera escritura
    if (-not $script:ConfigBackupPath -and (Test-Path -LiteralPath $Path)) {
        $script:ConfigBackupPath = "$Path.bak-remove-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item -LiteralPath $Path -Destination $script:ConfigBackupPath
    }
    $json = $Config | ConvertTo-Json -Depth 20
    try {
        [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
        return $true
    } catch {
        Write-Err "Error escribiendo opencode.jsonc: $($_.Exception.Message)"
        return $false
    }
}

function Remove-McpEntry {
    param([object]$Config, [string]$Name)
    if ($Config -and ($Config.PSObject.Properties.Name -contains 'mcp') -and $Config.mcp -and
        ($Config.mcp.PSObject.Properties.Name -contains $Name)) {
        $Config.mcp.PSObject.Properties.Remove($Name)
        $script:ConfigDirty = $true
        return $true
    }
    return $false
}

function Remove-PluginEntry {
    param([object]$Config, [string]$Plugin)
    if ($Config -and ($Config.PSObject.Properties.Name -contains 'plugin') -and $null -ne $Config.plugin) {
        $new = @($Config.plugin | Where-Object { $_ -and $_ -ne $Plugin })
        if ($new.Count -eq @($Config.plugin).Count) { return $false }
        if ($new.Count -eq 0) {
            $Config.PSObject.Properties.Remove('plugin')
        } else {
            $Config | Add-Member -NotePropertyName 'plugin' -NotePropertyValue $new -Force
        }
        $script:ConfigDirty = $true
        return $true
    }
    return $false
}

function Test-Command {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Native {
    # Ejecuta un comando nativo y devuelve $true solo si exit code == 0
    param([string]$File, [string[]]$Arguments)
    & $File @Arguments 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

# ==========================================
# Desinstaladores con verificacion real
# ==========================================
function Uninstall-NpmPackage {
    param([string]$Section, [string]$Name)
    $modDir = Join-Path $NpmGlobalModules $Name
    if (-not (Test-Path -LiteralPath $modDir)) {
        Write-Info "npm: '$Name' ya no esta instalado"
        Add-Result $Section "npm:$Name" 'YaNoExistia'
        return
    }
    if (Test-Command "npm") {
        if (-not (Invoke-Native 'npm' @('uninstall', '-g', $Name, '--silent'))) {
            Write-Warn "npm uninstall devolvio error para '$Name'; se verificara el estado en disco"
        }
    } else {
        Write-Warn "npm no disponible; eliminando modulo global manualmente"
    }
    if (Test-Path -LiteralPath $modDir) {
        try { Remove-Item -LiteralPath $modDir -Recurse -Force -ErrorAction Stop } catch { }
    }
    if (Test-Path -LiteralPath $modDir) {
        Write-Err "npm: '$Name' sigue presente en $modDir"
        Add-Result $Section "npm:$Name" 'Fallo'
    } else {
        Write-Ok "npm: '$Name' desinstalado"
        Add-Result $Section "npm:$Name" 'Eliminado'
    }
}

function Uninstall-UvTool {
    param([string]$Section, [string]$Name)
    $toolDir = Join-Path $UvToolsDir $Name
    if (-not (Test-Path -LiteralPath $toolDir)) {
        Write-Info "uv tool: '$Name' ya no esta instalado"
        Add-Result $Section "uv:$Name" 'YaNoExistia'
        return
    }
    if (Test-Command "uv") {
        if (-not (Invoke-Native 'uv' @('tool', 'uninstall', $Name))) {
            Write-Warn "uv tool uninstall devolvio error para '$Name'"
        }
    } else {
        Write-Warn "uv no disponible; eliminando entorno tool manualmente"
    }
    if (Test-Path -LiteralPath $toolDir) {
        # Entorno residual (ej. instalacion rota): forzar borrado
        Write-Warn "uv dejo un entorno residual en $toolDir; forzando borrado"
        try { Remove-Item -LiteralPath $toolDir -Recurse -Force -ErrorAction Stop } catch { }
    }
    if (Test-Path -LiteralPath $toolDir) {
        Write-Err "uv tool: '$Name' sigue presente en $toolDir"
        Add-Result $Section "uv:$Name" 'Fallo'
    } else {
        Write-Ok "uv tool: '$Name' desinstalado"
        Add-Result $Section "uv:$Name" 'Eliminado'
    }
}

function Remove-McpEntryReported {
    param([object]$Config, [string]$Section, [string]$Name)
    if (Remove-McpEntry $Config $Name) {
        Write-Ok "Entrada MCP '$Name' removida de opencode.jsonc"
        Add-Result $Section "mcp:$Name" 'Eliminado'
    } else {
        Write-Info "Entrada MCP '$Name' ya no estaba en opencode.jsonc"
        Add-Result $Section "mcp:$Name" 'YaNoExistia'
    }
}

function Remove-AgentsBlock {
    param([string]$Section, [string]$Marker)
    if (-not (Test-Path -LiteralPath $agentsMd)) {
        Write-Info "AGENTS.md no existe; bloque $Marker ya no esta"
        Add-Result $Section "AGENTS.md:$Marker" 'YaNoExistia'
        return
    }
    $content = Get-Content -LiteralPath $agentsMd -Raw
    $pattern = "(?s)<!-- $Marker`_START -->.*?<!-- $Marker`_END -->`r?`n?"
    if ([regex]::IsMatch($content, $pattern)) {
        $newContent = [regex]::Replace($content, $pattern, '')
        [System.IO.File]::WriteAllText($agentsMd, $newContent, (New-Object System.Text.UTF8Encoding($false)))
        Write-Ok "Bloque $Marker removido de AGENTS.md"
        Add-Result $Section "AGENTS.md:$Marker" 'Eliminado'
    } else {
        Write-Info "Bloque $Marker no encontrado en AGENTS.md (ya no existe)"
        Add-Result $Section "AGENTS.md:$Marker" 'YaNoExistia'
    }
}

function Remove-FileChecked {
    param([string]$Section, [string]$Path, [string]$Label)
    if (Test-Path -LiteralPath $Path) {
        try {
            Remove-Item -LiteralPath $Path -Force -Recurse -ErrorAction Stop
            Write-Ok "$Label eliminado"
            Add-Result $Section $Label 'Eliminado'
        } catch {
            Write-Err "No se pudo eliminar $Label : $($_.Exception.Message)"
            Add-Result $Section $Label 'Fallo'
        }
    } else {
        Write-Info "$Label ya no existe"
        Add-Result $Section $Label 'YaNoExistia'
    }
}

# Carga una unica vez; se guarda una sola vez al final
$cfg = Load-Config $ocConfig
if ($script:ConfigBroken) {
    Write-Warn "opencode.jsonc no parsea como JSON; las modificaciones NO se guardaran"
}

# ==========================================
# 1. DESINSTALAR SEMBLE
# ==========================================
Write-Step "SEMBLE" "Desinstalando Semble"
Uninstall-UvTool "SEMBLE" "semble"
Remove-McpEntryReported $cfg "SEMBLE" "semble"
Remove-FileChecked "SEMBLE" (Join-Path $ocDir "agents/semble-search.md") "Sub-agente semble-search.md"
Remove-AgentsBlock "SEMBLE" "SEMBLE"

# ==========================================
# 2. DESINSTALAR CONTEXT MODE
# ==========================================
Write-Step "CTX" "Desinstalando Context Mode"
Uninstall-NpmPackage "CTX" "context-mode"
Remove-McpEntryReported $cfg "CTX" "context-mode"
Remove-McpEntryReported $cfg "CTX" "context_mode"
$ctxPluginRemoved = Remove-PluginEntry $cfg "context-mode"
if ($ctxPluginRemoved) {
    Write-Ok "Entrada de plugin 'context-mode' removida de opencode.jsonc"
    Add-Result "CTX" "plugin:context-mode" 'Eliminado'
} else {
    Write-Info "Entrada de plugin 'context-mode' ya no estaba en opencode.jsonc"
    Add-Result "CTX" "plugin:context-mode" 'YaNoExistia'
}

# ==========================================
# 3. DESINSTALAR RTK (plugin + configuracion + openrtk)
# ==========================================
Write-Step "RTK" "Desinstalando RTK (plugin y configuracion)"
Remove-FileChecked "RTK" $RtkPluginPath "Plugin openrtk.ts"
Remove-FileChecked "RTK" $RtkMdPath "RTK.md"
Remove-AgentsBlock "RTK" "RTK"
Remove-FileChecked "RTK" $RtkConfigPath "config.toml de RTK"
Uninstall-NpmPackage "RTK" "openrtk"

# El binario rtk no se instala via npm/uv: se deja para baja manual
$rtkCmd = Get-Command rtk -ErrorAction SilentlyContinue
if ($rtkCmd) {
    Write-Info "Binario rtk instalado en: $($rtkCmd.Source)"
    Write-Info "Para eliminarlo: winget uninstall --id rtk-ai.rtk | cargo uninstall rtk-cli | borrar el .exe"
    Add-Result "RTK" "binario rtk ($($rtkCmd.Source))" 'Conservado'
} else {
    Write-Info "Binario rtk no esta en PATH (nada que eliminar manualmente)"
    Add-Result "RTK" "binario rtk" 'YaNoExistia'
}

# ==========================================
# 4. DESINSTALAR REPOMIX
# ==========================================
Write-Step "REPOMIX" "Desinstalando Repomix"
Uninstall-NpmPackage "REPOMIX" "repomix"
Remove-McpEntryReported $cfg "REPOMIX" "repomix"
Remove-FileChecked "REPOMIX" $RepomixConfigPath "repomix.config.json"
Remove-FileChecked "REPOMIX" $RepomixIgnorePath ".repomixignore"
Remove-AgentsBlock "REPOMIX" "REPOMIX"

# ==========================================
# 5. DESINSTALAR SERENA
# ==========================================
Write-Step "SERENA" "Desinstalando Serena"
Uninstall-UvTool "SERENA" "serena-agent"
Remove-McpEntryReported $cfg "SERENA" "serena"
Remove-AgentsBlock "SERENA" "SERENA"

# ==========================================
# 6. NORMALIZAR CONFIGURACION DE OPENCODE
# ==========================================
Write-Step "OPT" "Normalizando configuracion OpenCode"
Remove-McpEntryReported $cfg "OPT" "klia-token-optimizer"

# El comando slash /klia-stats no esta en opencode.jsonc: se registra como
# fichero .md dentro de una carpeta de comandos. Sin borrarlo sigue apareciendo
# en el autocompletado de OpenCode aunque el MCP ya este desinstalado.
$kliaCmdPaths = @(
    (Join-Path $projectRoot ".opencode\command\klia-stats.md"),
    (Join-Path $projectRoot ".opencode\command\klia_stats.md"),
    (Join-Path $projectRoot ".opencode\commands\klia-stats.md"),
    (Join-Path $projectRoot ".opencode\commands\klia_stats.md"),
    (Join-Path $ocDir "command\klia-stats.md"),
    (Join-Path $ocDir "command\klia_stats.md"),
    (Join-Path $ocDir "commands\klia-stats.md"),
    (Join-Path $ocDir "commands\klia_stats.md"),
    (Join-Path $ocDir ".opencode\command\klia-stats.md"),
    (Join-Path $ocDir ".opencode\command\klia_stats.md"),
    (Join-Path $ocDir ".opencode\commands\klia-stats.md"),
    (Join-Path $ocDir ".opencode\commands\klia_stats.md")
)
$kliaCmdFound = @($kliaCmdPaths | Where-Object { Test-Path -LiteralPath $_ })
if ($kliaCmdFound.Count -gt 0) {
    foreach ($cmdPath in $kliaCmdFound) {
        Remove-FileChecked "OPT" $cmdPath "Comando /klia-stats ($cmdPath)"
    }
} else {
    Write-Info "Comando /klia-stats ya no esta registrado"
    Add-Result "OPT" "comando /klia-stats" 'YaNoExistia'
}

if ($cfg.PSObject.Properties.Name -contains 'plugin') {
    $restantes = @($cfg.plugin)
    if ($restantes.Count -eq 0) {
        $cfg.PSObject.Properties.Remove('plugin')
        $script:ConfigDirty = $true
        Write-Ok "Array 'plugin' vacio: eliminado de opencode.jsonc"
        Add-Result "OPT" "plugin:(array)" 'Eliminado'
    } else {
        Write-Info "Array 'plugin' conservado con otras entradas: $($restantes -join ', ')"
        Add-Result "OPT" "plugin:(array con $($restantes.Count) entradas)" 'Conservado'
    }
} else {
    Write-Info "Array 'plugin' no existe en opencode.jsonc"
    Add-Result "OPT" "plugin:(array)" 'YaNoExistia'
}

if ($script:ConfigDirty) {
    if (Save-Config $ocConfig $cfg) {
        Write-Ok "opencode.jsonc actualizado (backup: $([System.IO.Path]::GetFileName($script:ConfigBackupPath)))"
    } else {
        Write-Err "opencode.jsonc NO se pudo actualizar"
        Add-Result "OPT" "opencode.jsonc" 'Fallo'
    }
} else {
    Write-Info "opencode.jsonc sin cambios; no se reescribe"
}

# ==========================================
# 7. LIMPIEZA / NOTAS FINALES
# ==========================================
Write-Step "FIN" "Notas finales"
if (Test-Path -LiteralPath $ctxDocsMd) {
    Write-Info "docs/context-mode.md se conserva como documentacion de referencia"
    Add-Result "FIN" "docs/context-mode.md" 'Conservado'
}
Add-Result "FIN" "AGENTS.md (reglas base)" 'Conservado'
Add-Result "FIN" ".router-history/ (historial del router)" 'Conservado'
$kliaPlugin = Join-Path $projectRoot ".opencode\plugin\klia-auto-record.js"
if (Test-Path -LiteralPath $kliaPlugin) {
    Write-Info "plugin/klia-auto-record.js existe pero ya no esta registrado en opencode.json"
    Add-Result "FIN" "plugin/klia-auto-record.js" 'Conservado'
}

# ==========================================
# RESUMEN REAL (generado desde el estado observado)
# ==========================================
Write-Host ""
Write-Host "=== RESUMEN DE DESINSTALACION ===" -ForegroundColor Cyan
Write-Host ""

function Show-Group {
    param([string]$Title, [string]$Status, [string]$Color, [string]$Symbol)
    $items = @($script:Results | Where-Object { $_.Status -eq $Status })
    if ($items.Count -eq 0) { return }
    Write-Host "$Title ($($items.Count)):" -ForegroundColor $Color
    foreach ($i in $items) { Write-Host "  $Symbol [$($i.Section)] $($i.Item)" }
    Write-Host ""
}

Show-Group "ELIMINADOS"      'Eliminado'   'Green'  'OK  '
Show-Group "YA NO EXISTIAN"  'YaNoExistia' 'DarkGray' '--  '
Show-Group "FALLOS"          'Fallo'       'Red'    'FAIL'
Show-Group "CONSERVADOS (manual / referencia)" 'Conservado' 'Yellow' 'KEPT'

$fallos = @($script:Results | Where-Object { $_.Status -eq 'Fallo' })
Write-Host "NOTAS:" -ForegroundColor Yellow
Write-Host "  1. Reinicia OpenCode para que los cambios de config surtan efecto."
if ($script:ConfigBackupPath) {
    Write-Host "  2. Backup de opencode.jsonc: $script:ConfigBackupPath"
} else {
    Write-Host "  2. opencode.jsonc no se modifico (sin backup)."
}
Write-Host "  3. El historial (.router-history/) se conserva para que el router siga aprendiendo."
if ($fallos.Count -gt 0) {
    Write-Host ""
    Write-Host "=== DESINSTALACION COMPLETADA CON FALLOS ($($fallos.Count)) ===" -ForegroundColor Red
    exit 1
}
Write-Host ""
Write-Host "=== DESINSTALACION COMPLETADA ===" -ForegroundColor Green
exit 0
