# Router Adaptativo de Optimizadores de Contexto

## Visión

Construir un router adaptativo para OpenCode que seleccione la estrategia de optimización de contexto más adecuada en función de:

- Tipo de tarea (clasificación estable)
- Características del contexto (tamaño, número de archivos, tool calls esperadas)
- Modelo/familia del LLM como variable de ajuste
- Histórico de ejecuciones reales (tokens, latencia, calidad, fallos)

El objetivo no es crear una tabla gigante `modelo × tarea × optimizador`, sino un sistema portable que aprenda progresivamente y haga fallback seguro a `baseline` cuando no exista evidencia suficiente.

---

## Arquitectura objetivo

```text
              OpenCode
                 │
                 ▼
        ┌─────────────────┐
        │ ROUTER ADAPTATIVO│
        └────────┬────────┘
                 │
     ┌───────────┼───────────┐
     ▼           ▼           ▼
  Tarea       Contexto     Modelo
  T1-T6       tamaño      familia
              /etc.
     │           │           │
     └───────────┼───────────┘
                 ▼
        Selección optimizador
                 │
       ┌─────────┼─────────┐
       ▼         ▼         ▼
      DCP       RTK     Repomix/CM
       │         │         │
       └─────────┼─────────┘
                 ▼
              OpenCode
```

Optimizadores considerados:

- `BASELINE`: sin optimización adicional.
- `DCP`: Dynamic Context Pruning / compresión selectiva.
- `RTK`: Reducción de tokens en salidas de CLI (comandos, logs, salida de consola).
- `CONTEXT_MODE`: Context Mode del proyecto (índices FTS5, docs, APIs).
- `REPOMIX`: Empaquetado inteligente del repositorio.

---

## Versionado del router

| Versión | Descripción |
| ------- | ----------- |
| V0 | Reglas manuales por tipo de tarea. |
| V1 | Reglas generales + ajuste por modelo cuando hay evidencia. |
| V2 | Estadísticas de coste relativo por `(modelo, tipo_tarea, optimizador)`. |
| V3 | Estrategia de exploración/explotación con fallback a baseline y pruebas controladas. |

---

## Clasificación de tareas

| Tipo | Señales |
| ---- | ------- |
| `SMALL_CODE` | Pocos archivos, cambio pequeño. |
| `TERMINAL` | Comandos, logs, salida de consola. |
| `LARGE_CONTEXT` | Archivos grandes, documentación extensa. |
| `REPOSITORY_SEARCH` | Búsqueda entre muchos archivos. |
| `MULTISTEP` | Muchas decisiones/pasos. |
| `REFACTOR` | Dependencias, múltiples archivos. |

---

## Reglas base V0

| Tarea | Optimizadores a evaluar |
| ----- | ------------------------ |
| `SMALL_CODE` | `BASELINE` |
| `TERMINAL` | `RTK`, `DCP` |
| `LARGE_CONTEXT` | `CONTEXT_MODE`, `REPOMIX` |
| `REPOSITORY_SEARCH` | `CONTEXT_MODE`, `REPOMIX` |
| `MULTISTEP` | `DCP` |
| `REFACTOR` | `RTK` |

---

## Función de coste esperado

```
Score = tokens
      + latencia
      + coste_tooling
      + penalización_por_fallos
      + penalización_por_calidad
```

El coste se normaliza respecto al baseline para obtener un coste relativo.

Ejemplo de matriz objetivo V2:

| Modelo/Tarea | DCP | RTK | CM | BASELINE |
| ------------ | --- | --- | -- | -------- |
| GLM/T5 | 0.58 | 0.91 | 0.83 | 1.00 |
| DeepSeek/T5 | 1.21 | 1.20 | 1.45 | 1.00 |
| GLM/T6 | 0.59 | 0.58 | 0.71 | 1.00 |
| DeepSeek/T6 | 1.25 | 1.10 | 1.72 | 1.00 |

Donde `1.00` es el coste relativo del baseline para esa `(modelo, tarea)`.

---

## Adaptación a nuevos modelos

Cuando aparece un modelo nuevo:

```text
Nuevo modelo
     ↓
¿Tengo historial?
     │
    NO
     ↓
baseline seguro
     ↓
recoger resultados
     ↓
¿hay suficiente evidencia?
     │
    SÍ
     ↓
crear/actualizar regla
```

No es necesario volver a ejecutar un benchmark completo. El sistema aprende de las ejecuciones reales.

---

## Plan de tareas

- [x] **T1. Diseñar arquitectura y contratos del router adaptativo**
  Definir componentes (`TaskClassifier`, `RuleEngine`, `ExpectedCostScorer`, `HistoryStore`, `ModelAdaptor`, `Explorer`), interfaces de entrada/salida y formato de decisión. Elegir lenguaje/tech stack acorde al entorno (OpenCode/Node).

- [x] **T2. Implementar clasificador de tareas (TaskClassifier)**
  Recibir señales (número de archivos, tamaño de contexto, tipo de query, comandos esperados, tool calls esperadas) y devolver una categoría: `SMALL_CODE`, `TERMINAL`, `LARGE_CONTEXT`, `REPOSITORY_SEARCH`, `MULTISTEP`, `REFACTOR`.

- [x] **T3. Implementar motor de reglas base V0**
  Crear reglas generales por tipo de tarea: `SMALL_CODE→baseline`, `TERMINAL→RTK/DCP`, `LARGE_CONTEXT→Context Mode/Repomix`, `REPOSITORY_SEARCH→Context Mode/Repomix`, `MULTISTEP→DCP`, `REFACTOR→RTK`.

- [x] **T4. Diseñar e implementar almacenamiento de histórico de ejecuciones**
  Estructura de registro: modelo, tipo_tarea, contexto, optimizador, tokens, latencia, coste_tooling, fallos, calidad. Soporte JSON/DB liviana (por ejemplo SQLite o archivo JSON con índices).

- [x] **T5. Implementar función de coste esperado (ExpectedCostScorer)**
  Combinar tokens, latencia, coste de tooling, penalización por fallos y penalización por calidad en un score relativo al baseline.

- [x] **T6. Implementar ajuste por modelo/familia V1-V2**
  A partir del histórico, calcular costes relativos por `(modelo, tipo_tarea, optimizador)` y decidir con umbral de confianza. Fallback a baseline si no hay datos suficientes.

- [x] **T7. Implementar estrategia de exploración/explotación V3**
  Cuando la confianza sea baja, ejecutar baseline, registrar resultado y actualizar estadísticas. Permitir exploración ocasional controlada de alternativas con buena razón de esperanza de mejora.

- [x] **T8. Crear API/CLI del router**
  Exponer un comando o función principal `route(task, model, context)` que devuelva la optimización recomendada, su justificación y el nivel de confianza.

- [x] **T9. Escribir tests unitarios y de integración iniciales**
  Cubrir clasificación, scoring, fallback y aprendizaje con datos sintéticos y con los benchmarks GLM-5.2 + DeepSeek del usuario.

- [x] **T10. Documentar diseño y guía de uso**
  Crear `README.md` y `AGENTS.md` con arquitectura, versionado, criterios de decisión y cómo añadir un modelo nuevo sin re-benchmark completo.

---

## Notas de calibración recomendada

No es necesario probar `todos los modelos × todos los optimizadores × todas las tareas`. Una calibración representativa puede ser:

```text
4 modelos × 6 tareas × 5 configuraciones × 3 repeticiones = 360 ejecuciones
```

Después de una fase inicial, reducir el espacio de optimizadores candidatos por tipo de tarea (por ejemplo, `SEMBLE` solo para `LARGE_CONTEXT` extremo).

---

## Frase clave

> "El sistema no presupone que un optimizador sea universalmente beneficioso. Selecciona la estrategia en función de la tarea y adapta su decisión mediante evidencia histórica del modelo y del entorno de ejecución."

---

## Estado final

Todas las tareas completadas. El router está implementado, testeado y documentado.

Verificación:

- `npm run build` genera `dist/` sin errores.
- `npm test` ejecuta **8 archivos de tests** con **41 tests pasando**.
- CLI funcional: `npm run route -- --model glm-5.2 --query "refactoriza auth" --files 12 --size 200000`.

Próximos pasos sugeridos:

1. Integrar el router como dependencia o plugin en el flujo real de OpenCode.
2. Reemplazar `JsonHistoryStore` por SQLite si el volumen de ejecuciones crece.
3. Añadir métricas de calidad automáticas (por ejemplo, tasa de éxito del código generado).
4. Calibrar pesos de la función de coste con datos reales de producción.
