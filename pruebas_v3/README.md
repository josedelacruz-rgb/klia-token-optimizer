# pruebas_v3 — Protocolo de Validación Experimental y Ahorro Real de Tokens

Este directorio contiene la suite de pruebas **v3** diseñada específicamente para responder a las objeciones metodológicas del benchmark anterior.

## ¿Qué corrige esta versión frente a v2?

| Aspecto | Versión anterior (v2) | Versión real (v3) |
| :--- | :--- | :--- |
| **Generación de datos** | Línea base sintética y variación aleatoria estocástica (`Math.random()`) | **Medición real y determinista** sobre archivos reales del repositorio y comandos de terminal |
| **Tokens** | Simulación artificial de ahorro | **Tokens medidos** en el contenido que realmente entra/sale al LLM |
| **Condición BASELINE** | Generada con fórmulas teóricas | Lectura real completa que haría un agente tradicional sin herramientas de optimización |
| **Condición OPTIMIZADO** | Valores multiplicados por porcentajes fijos | Filtrado efectivo mediante herramientas (`RTK`, `SEMBLE`, `REPOMIX`) |
| **Repetibilidad** | 1 única ejecución con simulación | **Muestreo estadístico ($N \ge 5$)** con cálculo de medias y varianzas |
| **Contaminación de datos** | Guardaba datos en las bases principales | Directorio aislado `pruebas_v3/data/` para no alterar el historial del router en producción |

---

## Estructura de carpetas

```text
pruebas_v3/
├── escenarios/
│   └── tareas.json           # Definición de tareas reales representativas (Terminal, Búsqueda, Código, Refactor)
├── resultados/               # Destino donde se guardarán los informes y datos raw una vez ejecutado
│   ├── reporte-v3.md         # Informe ejecutivo generado en Markdown con tablas comparativas
│   └── resultados-v3.json    # Todas las métricas y registros detallados
├── data/                     # Historial de telemetría y eventos aislado para pruebas
├── run-benchmark-v3.ts       # Script orquestador principal
└── README.md                 # Esta documentación
```

---

## Cómo ejecutar el benchmark (cuando decidas lanzarlo)

El script **no ha sido ejecutado** y está listo para cuando quieras probarlo.

### Ejecución estándar (5 repeticiones por tarea):
```bash
npx tsx pruebas_v3/run-benchmark-v3.ts
```

### Opciones configurables:
- Cambiar el número de repeticiones (por ejemplo, 3 o 10):
  ```bash
  npx tsx pruebas_v3/run-benchmark-v3.ts --repetitions 10
  ```
- Evaluar con otro modelo específico:
  ```bash
  npx tsx pruebas_v3/run-benchmark-v3.ts --model deepseek-v4-pro
  ```
