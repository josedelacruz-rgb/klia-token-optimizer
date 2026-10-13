<div align="center">

<img src="docs/assets/Banner.png" alt="Klia Token Optimizer — optimización inteligente para OpenCode" width="100%" />

# Klia Token Optimizer

### Menos tokens. Más eficiencia. Optimización inteligente para OpenCode.

[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?logo=node.js&logoColor=white)](https://nodejs.org/)[![Tests](https://img.shields.io/badge/Tests-Vitest-6e9f18?logo=vitest)](https://vitest.dev/)[![MCP](https://img.shields.io/badge/Integración-MCP-0a9e6a?logo=modelcontextprotocol&logoColor=white)

**Klia Token Optimizer es una capa inteligente de optimización para OpenCode que coordina estrategias especializadas para reducir el consumo de tokens de contexto, automatizar tareas de configuración y mejorar la eficiencia de los agentes de IA.**

**Una instalación. Múltiples estrategias. Ahorro medible.**

</div>

---

## Ahorro de tokens: hasta un 88,9 % en la suite evaluada

Klia Token Optimizer busca reducir el consumo innecesario de contexto en OpenCode mediante la selección de estrategias adaptadas a cada tipo de tarea.

En la suite de pruebas registrada por el proyecto, se reportó un ahorro agregado del **88,9 % en tokens de contexto**, equivalente a **45.111 tokens menos sobre una referencia de 50.718 tokens**.

La suite se ejecutó en **4,82 minutos**, con los siguientes resultados: **8 PASS, 0 FAIL y 2 HALLAZGO**.

### Resultados de la comparativa

<img src="docs/assets/Tablaresultados.png" alt="Klia Token Optimizer — optimización inteligente para OpenCode" width="100%" />

**Ahorro total reportado: 45.111 tokens (88,9 %).**

Los resultados muestran el potencial de seleccionar una estrategia específica para cada tarea, en lugar de activar todas las herramientas indiscriminadamente.

### ¿Qué significan estos resultados?

- **98,8 % menos tokens de contexto** en la prueba de terminal con RTK.
- **99,7 % menos tokens de contexto** en la prueba de contexto amplio con Semble.
- **99,1 % menos tokens de contexto** en la prueba de búsqueda de repositorios con Context Mode.
- **Selección inteligente:** el router puede mantener el baseline cuando una estrategia alternativa no demuestra una mejora.
- **Evaluación transparente:** las pruebas permiten identificar resultados positivos, neutros y pendientes de validación.

> **Nota:** los porcentajes corresponden a las mediciones registradas en las tareas evaluadas. El 88,9 % es el ahorro agregado reportado por la suite; la tarea MULTISTEP continúa con resultado N/A. El ahorro real puede variar según el modelo, la tarea, el contexto y la configuración. Reducir tokens de contexto no implica necesariamente una reducción equivalente del coste total de API.

## Instalación automatizada: un solo comando para empezar

¿Por qué perder tiempo instalando y configurando manualmente cada herramienta?

Klia incluye un instalador PowerShell diseñado para automatizar la preparación del entorno y la instalación y configuración de los componentes contemplados por el script.

En lugar de empezar desde cero con cada optimizador, puedes iniciar el proceso con un único comando.

### 1. Ejecuta el instalador

Abre PowerShell en el directorio del proyecto y ejecuta:

```powershell
powershell -ExecutionPolicy Bypass -File install_klia_token_optimizer.ps1
```

### 2. Selecciona el perfil adecuado

El proyecto documenta opciones para utilizar un perfil mínimo o simular las operaciones antes de aplicarlas:

```powershell
.\install_klia_token_optimizer.ps1 -StackProfile minimo
.\install_klia_token_optimizer.ps1 -DryRun
```

### 3. Utiliza el router y mide los resultados

Una vez completada la instalación, podrás utilizar el router para seleccionar estrategias, ejecutar tareas y registrar métricas.

El alcance de la instalación automática depende de las operaciones implementadas por el script. Las dependencias externas, los requisitos previos y las herramientas que necesiten autenticación deben cumplir sus respectivas instrucciones.

## ¿Qué es Klia Token Optimizer?

No todas las tareas de programación necesitan el mismo contexto ni se benefician de la misma herramienta.

Una búsqueda en un repositorio, una operación de terminal, una refactorización y una tarea multipaso presentan necesidades diferentes. Aplicar siempre el mismo optimizador puede introducir complejidad innecesaria e incluso aumentar el consumo.

Klia aborda este problema mediante una capa de decisión que analiza el tipo de tarea, considera las estrategias candidatas y utiliza el historial de ejecuciones para orientar futuras selecciones.

El objetivo es **reducir el consumo evitable de tokens sin perder de vista la calidad, la fiabilidad, la latencia y el coste total**.

## Principales ventajas

<img src="docs/assets/klia-token-optimizer-banner.png" alt="Klia Token Optimizer — optimización inteligente para OpenCode" width="100%" />

<table>
<tr>
<td width="50%" valign="top">

### Selección según la tarea

El router identifica el tipo de trabajo y propone una estrategia candidata en lugar de aplicar siempre el mismo optimizador.

</td>
<td width="50%" valign="top">

### Ahorro medible

Compara los resultados frente al baseline para identificar reducciones reales, pérdidas o resultados neutros.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Instalación simplificada

El instalador automatiza las operaciones de preparación y configuración que contempla el proyecto.

</td>
<td width="50%" valign="top">

### Decisiones orientadas por datos

Las ejecuciones registradas permiten estudiar qué estrategias funcionan mejor según el modelo y la tarea.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Equilibrio entre ahorro y calidad

La evaluación considera tokens, latencia, coste, fallos y calidad, no solamente el volumen de contexto.

</td>
<td width="50%" valign="top">

### Fallback conservador

Cuando no existe evidencia suficiente, el router puede recurrir a `BASELINE` en lugar de asumir que una estrategia no validada es superior.

</td>
</tr>
</table>

## Seis estrategias coordinadas

Klia contempla seis estrategias para responder a diferentes necesidades de optimización.

| Estrategia     | Cuándo puede resultar útil                                             |
| -------------- | ---------------------------------------------------------------------- |
| `BASELINE`     | Referencia de comparación o alternativa conservadora.                  |
| `DCP`          | Poda o compresión selectiva del contexto.                              |
| `RTK`          | Reducción del ruido en salidas de terminal, comandos y logs.           |
| `CONTEXT_MODE` | Trabajo con contextos amplios y recuperación selectiva de información. |
| `REPOMIX`      | Preparación de una vista empaquetada del repositorio.                  |
| `SEMBLE`       | Búsqueda semántica para localizar código relevante.                    |

La selección depende de las reglas del router, el modelo, el tipo de tarea y los datos disponibles. Utilizar más herramientas simultáneamente no garantiza un mayor ahorro: la coordinación y la evaluación son esenciales.

## Cómo funciona

<img src="docs/assets/comofunciona.png" alt="Arquitectura y funcionamiento de Klia Token Optimizer" width="100%" />

### Un ciclo de optimización basado en datos

1. **Clasifica:** analiza señales de la tarea, como la consulta, el número de archivos y el tamaño del contexto.
2. **Evalúa:** considera los optimizadores candidatos y la evidencia disponible para el modelo y la tarea.
3. **Selecciona:** propone una estrategia o utiliza `BASELINE` cuando corresponde.
4. **Registra:** almacena las métricas disponibles de la ejecución.
5. **Compara:** identifica dónde hay ahorro, pérdida o ausencia de mejora.
6. **Mejora las decisiones:** utiliza el historial para orientar futuras selecciones.

El router contempla cuatro versiones de decisión: desde reglas base (V0), pasando por adaptación con historial (V1–V2), hasta exploración controlada (V3).

## Mide lo que importa

Klia no se limita a contar tokens. Permite evaluar distintas dimensiones del rendimiento.

| Métrica                    | Objetivo                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| Tokens de entrada y salida | Medir el consumo cuando ambas métricas están disponibles.                                     |
| Tokens de contexto         | Comparar el volumen de contexto registrado frente al baseline.                                |
| Ahorro relativo            | Calcular la diferencia entre la referencia y la estrategia optimizada.                        |
| Latencia                   | Medir el tiempo de ejecución.                                                                 |
| Coste                      | Evaluar el coste registrado o estimado y los costes de herramientas cuando estén disponibles. |
| Calidad y fiabilidad       | Identificar fallos, reintentos y posibles pérdidas de calidad.                                |
| Trazabilidad               | Registrar el modelo, la tarea, la estrategia y el motivo de selección.                        |

Para demostrar una mejora real, compara ejecuciones con el mismo modelo, tareas equivalentes, el mismo repositorio y criterios de calidad comparables.

## Ejemplo: consultar una decisión

```bash
npm run router -- --model glm-5.2 --query "refactoriza auth" --files 12 --size 250000
```

La salida incluye el optimizador seleccionado, el tipo de tarea, la versión del router, la confianza y el motivo de la decisión.

### Registrar una ejecución

Después de ejecutar la tarea, registra las métricas reales:

```bash
npm run router -- --record-id <RECORD_ID> --tokens 9500 --latency 88 --quality 0.98
```

### Consultar estadísticas

```bash
npm run router -- stats --model glm-5.2 --real-only
```

Los valores del ejemplo son ilustrativos. Las conclusiones sobre el ahorro deben basarse en registros reales y comparables.

## Integración MCP

El servidor MCP permite integrar las capacidades del router en flujos de trabajo compatibles.

| Herramienta        | Función                                           |
| ------------------ | ------------------------------------------------- |
| `route_task`       | Recomendar una estrategia para una tarea.         |
| `record_execution` | Registrar el resultado de una ejecución.          |
| `get_router_stats` | Consultar estadísticas y comparativas.            |
| `migrate_history`  | Migrar el historial al esquema de eventos actual. |

## ¿Por qué elegir Klia Token Optimizer?

Muchas soluciones se centran en una técnica específica: reducir el contexto, filtrar salidas, indexar código o enrutar modelos.

Klia propone un enfoque de coordinación: **reunir varias estrategias en una misma capa de decisión y utilizar resultados registrados para orientar la selección**.

Esto permite:

- Simplificar la preparación del entorno mediante el instalador.
- Adaptar la estrategia al tipo de tarea.
- Comparar optimizadores frente a una referencia.
- Identificar cuándo una herramienta aporta valor y cuándo no.
- Tomar decisiones respaldadas por métricas en lugar de suposiciones.
- Evaluar el ahorro junto con la calidad, la latencia y el coste.

El objetivo no es reducir tokens a cualquier precio, sino mejorar la eficiencia del flujo de trabajo con IA.

## Estado del proyecto

- Router adaptativo con versiones V0–V3.
- Seis estrategias contempladas por las reglas del router.
- Registro de ejecuciones e informes por modelo y tarea.
- Servidor MCP y CLI.
- Tests automatizados disponibles en el repositorio.
- Instalador PowerShell con perfiles y modo de simulación documentados.
- Suite de evaluación con comparativa entre baseline y optimización.

## Requisitos

- Windows para utilizar el instalador PowerShell.
- Node.js `>= 22.5`.
- npm.
- `uv` para las herramientas que lo requieran.
- Dependencias y credenciales adicionales según los componentes seleccionados.

Consulta las instrucciones del instalador para verificar los requisitos específicos de tu entorno.

## Desarrollo

```bash
npm install
npm run build
npm test
```

## Documentación

- [Guía de uso de OpenCode](./OPENCODE_USAGE.md)
- [Detalles del instalador](./instaladores/install.md)
- [Convenciones del proyecto](./AGENTS.md)
- [Comparativa baseline vs. optimizado](./pruebas/resultados/comparativa-baseline-vs-optimizado.md)

## Licencia

Licencia ISC. Consulta [`package.json`](./package.json).

---

<div align="center">

**Klia Token Optimizer**

### Instala. Optimiza. Mide. Mejora.

*Menos contexto innecesario. Más control sobre el consumo de IA.*

</div>
