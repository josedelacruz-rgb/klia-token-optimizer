# Test Plan — Plan de pruebas profesional

> Plan ejecutado por `pruebas/benchmark/run-benchmark.ts`.
> Suites: A (auditoria), B (instrumentacion), C+D (benchmark emparejado),
> E (metricas), F (revision tabla anterior), G (aprendizaje), H (robustez), I (presupuesto).

## 1. Hipotesis

- **H1**: El router clasifica correctamente los 6 TaskType con senales explicitas o implicitas suficientes.
- **H2**: Sin historico, el router aplica BASE_RULES correctamente.
- **H3**: Con historico sintetico valido, el router pasa a V2 y elige el optimizador de menor coste.
- **H4**: Los optimizadores (RTK, SEMBLE, CONTEXT_MODE, REPOMIX) producen salidas mas pequenas que BASELINE para sus tareas objetivo.
- **H5**: El agregado honesto de ahorro (solo sobre comparaciones validas emparejadas) es diferente del 88,9% anterior cuando se excluyen DCP y BASELINE sin par.

## 2. Criterios de aceptacion

### 2.1 Clasificacion (A2)

- Acierto >= 70% en 14 casos (2 por tipo + 2 ambiguos/UNKNOWN).
- Matriz de confusion reportada.
- Falsos positivos y negativos listados.

### 2.2 Reglas (A3)

- Sin historico: 6/6 decisiones coinciden con BASE_RULES.
- Con historico: >= 4/6 son V2.
- `excludeSynthetic=true` excluye todos los sinteticos.

### 2.3 Registro (A4)

- JSON corrupto no crashea sin control (o se documenta como HALLAZGO).
- Migracion v1->v2 funciona.
- Concurrencia: 5 ejecuciones paralelas, 5 persistidas.
- Duplicados: documentar que CLI no deduplica (D3).

### 2.4 Benchmark emparejado (C+D)

- N=3 repeticiones por condicion.
- Cada BenchmarkRecord incluye: bytes por canal, tokens por canal, coste USD, latencia, calidad (`desconocida` si no medida), tests si aplica, completada, errores.
- Tabla final con: tokens BASE/OPT, ahorro tokens/%, latencia BASE/OPT, delta latencia, coste BASE/OPT, ahorro coste/%, calidad, tests.

### 2.5 Agregado honesto (E+F)

- El agregado SOLO incluye comparaciones validas emparejadas.
- Tareas excluidas listadas con motivo.
- Denominador documentado.

### 2.6 Aprendizaje (G)

- Train/test split con al menos 1 tarea en test.
- Decisiones en test reportadas; V2 >= 1 si hay senal suficiente.
- Nota: cambio != mejora.

### 2.7 Robustez (H)

- Evento invalido no crashea.
- Historial vacio: route_task funciona.
- Solo sinteticos: `realExecutions=0`.

## 3. Casos de prueba

### 3.1 A2 — 14 casos de clasificacion

| ID | Query (resumida) | Esperado | Nota |
|---|---|---|---|
| C1 | "corrige un typo" | SMALL_CODE | claro |
| C2 | "renombra la variable" | SMALL_CODE | claro |
| C3 | "ejecuta npm test" | TERMINAL | claro |
| C4 | "corre el comando git status" | TERMINAL | claro |
| C5 | "explica el sistema" (size>=2MB) | LARGE_CONTEXT | claro |
| C6 | "revisa toda la documentacion" | LARGE_CONTEXT | claro |
| C7 | "busca todas las referencias" | REPOSITORY_SEARCH | claro |
| C8 | "encuentra donde se usa" | REPOSITORY_SEARCH | claro |
| C9 | "planifica la migracion en pasos" | MULTISTEP | claro |
| C10 | "migra en fases" | MULTISTEP | claro |
| C11 | "refactoriza el modulo" | REFACTOR | claro |
| C12 | "restructure el codigo" | REFACTOR | claro |
| C13 | "mejora el proyecto" | UNKNOWN | ambiguo |
| C14 | "ayuda con esto" | UNKNOWN | ambiguo |

### 3.2 C+D — 6 tareas del benchmark

| ID | TaskType | Optimizador esperado | Archivos / Comando |
|---|---|---|---|
| T1 | SMALL_CODE | BASELINE | src/index.ts |
| T2 | TERMINAL | RTK | `npx tsc --noEmit --listFiles` |
| T3 | LARGE_CONTEXT | SEMBLE | 8 archivos del scorer+selector |
| T4 | REPOSITORY_SEARCH | CONTEXT_MODE | 8 archivos con extractModelFamily |
| T5 | MULTISTEP | DCP (no medible) | 4 archivos de history |
| T6 | REFACTOR | RTK | 4 archivos de history |

## 4. Orden de ejecucion

1. A1 (build + CLI + MCP)
2. A2 (clasificacion 14 casos)
3. A3 (reglas sin/con historico, exclusion sinteticos)
4. A4 (registro: idempotencia, corrupcion, migracion, concurrencia)
5. C+D (benchmark emparejado, 3 repeticiones)
6. F (revision tabla anterior)
7. G (aprendizaje train/test)
8. H (robustez adicional)

## 5. Metricas de aceptacion globales

| Metrica | Criterio |
|---|---|
| Tiempo total | < 20 min (suite rapida) |
| % acierto clasificacion | >= 70% |
| Decisiones V2 con historico | >= 4/6 |
| Migracion v1->v2 | funciona, 1 registro migrado |
| Concurrencia | 5/5 persistidas |
| Excluir sinteticos | realExecutions=0 cuando solo hay sinteticos |

## 6. Lo que NO se acepta como valido

- Quality medida como 0.95 hardcodeado: **NO VALIDO** como evaluacion real.
- Tokens calculados como `bytes/4`: **NO VALIDO** como medicion principal (solo estimacion auxiliar).
- DCP medido sin sesion interactiva: **NO VALIDO**, se reporta como PENDIENTE.
- Ahorro global sobre tareas no medidas: **NO VALIDO**, se excluyen del agregado.
