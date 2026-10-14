import { defineConfig } from 'vitest/config';

// Excluye del descubrimiento de tests los artefactos del benchmark:
//  - results/ y .isolation/: copias de fixtures generadas en cada ejecucion.
//  - tasks/: fixtures de tarea, que usan `node:test` (no vitest).
// El resto del descubrimiento por defecto de vitest se mantiene intacto.
export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'pruebas_v2/results/**',
      'pruebas_v2/.isolation/**',
      'pruebas_v2/tasks/**',
    ],
  },
});
