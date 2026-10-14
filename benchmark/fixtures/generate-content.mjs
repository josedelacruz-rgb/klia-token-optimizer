// Generador determinista del contenido voluminoso del fixture.
// Se ejecuta al preparar cada espacio de trabajo. Mismo seed => mismos bytes.
// Uso: node generate-content.mjs <directorio-destino>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// PRNG mulberry32 (determinista).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'el servicio modulo pedido cliente factura carrito inventario proceso flujo dato ' +
  'registro politica revision equipo interfaz contrato evento cola reintento ' +
  'latencia despliegue entorno configuracion metrica alerta umbral auditoria ' +
  'version compatibilidad migracion esquema indice cache sesion token usuario ' +
  'permiso rol validacion integridad consistencia operacion lote informe'
).split(' ');

function sentence(r) {
  const n = 8 + Math.floor(r() * 14);
  const w = [];
  for (let i = 0; i < n; i++) w.push(WORDS[Math.floor(r() * WORDS.length)]);
  const s = w.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

function paragraph(r) {
  const n = 4 + Math.floor(r() * 5);
  const s = [];
  for (let i = 0; i < n; i++) s.push(sentence(r));
  return s.join(' ');
}

// Hechos verificables repartidos por la documentacion (T4).
// Los valores esperados estan en benchmark/tasks/tasks.json (T4.expected).
const NEEDLES = {
  2: 'La version minima de Node.js soportada en produccion es la 22.4.',
  4: 'El puerto por defecto del servicio de pagos es el 7443.',
  5: 'La responsable del modulo de pagos es Marta Iglesias.',
  7: 'Las sesiones caducan tras 45 minutos de inactividad.',
  8: 'Los codigos de error reservados para el modulo de pagos son PAY-401, PAY-409 y PAY-503.',
};

// Distractores con valores parecidos pero explicitamente obsoletos.
const DISTRACTORS = {
  1: 'Nota historica (obsoleta, no aplicar): en 2023 el puerto de pagos era el 7000.',
  3: 'Nota historica (obsoleta, no aplicar): antes las sesiones caducaban a los 20 minutos.',
  6: 'Nota historica (obsoleta, no aplicar): la version minima de Node.js era la 18.0.',
};

export function generate(root) {
  const r = rng(20261013);

  // --- T4: documentacion de diseno amplia ---
  const docsDir = join(root, 'docs', 'diseno');
  mkdirSync(docsDir, { recursive: true });
  for (let d = 1; d <= 8; d++) {
    const parts = [`# Documento de diseno ${d}`, ''];
    for (let s = 1; s <= 6; s++) {
      parts.push(`## Seccion ${d}.${s}`, '');
      for (let p = 0; p < 4; p++) parts.push(paragraph(r), '');
      if (s === 4 && NEEDLES[d]) parts.push(NEEDLES[d], '');
      if (s === 2 && DISTRACTORS[d]) parts.push(DISTRACTORS[d], '');
    }
    writeFileSync(join(docsDir, `diseno-${String(d).padStart(2, '0')}.md`), parts.join('\n'));
  }

  // --- T2: salida de CI ruidosa con una causa raiz concreta ---
  const logDir = join(root, 'logs');
  mkdirSync(logDir, { recursive: true });
  const lines = [
    'Run actions/checkout@v4',
    'Runner: ubuntu-24.04 (linux x64)',
    '$ node --version',
    'v22.4.0',
    '$ npm ci',
  ];
  for (let i = 0; i < 180; i++) {
    lines.push(`npm http fetch GET 200 https://registry.npmjs.org/pkg-${Math.floor(r() * 9000)} ${Math.floor(r() * 400)}ms (cache hit)`);
  }
  lines.push('added 0 packages in 2s', '$ npm test', '> tienda-demo@1.0.0 test', '> node --test tests/');
  for (let i = 0; i < 40; i++) {
    lines.push(`(node:${2000 + i}) ExperimentalWarning: test runner option ${Math.floor(r() * 99)} is experimental`);
  }
  lines.push(
    'TAP version 13',
    '# Subtest: arranque del servicio',
    'not ok 1 - arranque del servicio',
    '  ---',
    '  error: "ENOENT: no such file or directory, open \'/home/runner/work/tienda-demo/src/config/defaults.json\'"',
    '  code: ENOENT',
    '  stack: |-',
    '    Object.openSync (node:fs:573:18)',
    '    readFileSync (node:fs:452:35)',
    '    loadDefaults (file:///home/runner/work/tienda-demo/src/config/loader.js:9:15)',
    '    startService (file:///home/runner/work/tienda-demo/src/server.js:4:3)',
    '  ...',
  );
  for (let i = 0; i < 60; i++) {
    lines.push(`# debug: gc pause ${Math.floor(r() * 30)}ms heap ${Math.floor(r() * 200)}MB`);
  }
  lines.push('# tests 14', '# pass 13', '# fail 1', 'Error: Process completed with exit code 1.');
  lines.push('Nota: en los portatiles de desarrollo (Windows y macOS) este test pasa correctamente.');
  writeFileSync(join(logDir, 'ci-output.log'), lines.join('\n') + '\n');
}

if (process.argv[2]) generate(process.argv[2]);
