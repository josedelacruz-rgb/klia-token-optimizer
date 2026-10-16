// OpenCode plugin: reescribe automáticamente los comandos de bash/shell
// con el prefijo `rtk` para que la salida se comprima (tokens ahorrados).
//
// Soporta los comandos listados en AGENTS.md como "Cuando rtk actua automatico".
// Si rtk no está en PATH, la reescritura es un no-op (no rompe nada).
//
// Ubicación: .opencode/plugin/openrtk.js
// Para activar: añadir el plugin en opencode.json (o recargar OpenCode).

const PATH_RTK = 'rtk';

function isRtkAvailable() {
  try {
    require.resolve(PATH_RTK);
    return true;
  } catch {
    return false;
  }
}

// Conjunto de comandos base que rtk sabe comprimir.
// Se compara la primera palabra (token) del comando.
const RTK_PREFIXES = new Set([
  'git',
  'cargo',
  'gh',
  'docker',
  'kubectl',
  'curl',
  'pytest',
  'ruff',
  'pip',
  'go',
  'mix',
  'cat',
  'grep',
  'rg',
  'ls',
  'tree',
  'find',
  'vitest',
  'npm',
  'tsc',
  'eslint',
  'prettier',
  'playwright',
]);

function normalizeCommand(cmd) {
  return (cmd || '').trim();
}

module.exports = async ({ config, directory }) => {
  const projectRoot = path.resolve(directory || process.cwd());
  const rtkAvailable = isRtkAvailable();

  return {
    'tool.execute.before': async (input) => {
      const toolName = input.toolName;
      if (toolName !== 'bash' && toolName !== 'shell_execute') return;

      const args = input.args || {};
      let command = '';
      if (args.command) command = normalizeCommand(args.command);
      else if (args.query) command = normalizeCommand(args.query);

      if (!command) return;

      // Si ya viene con rtk, no vuelva a reescribir (previene doble aplicación)
      const lower = command.toLowerCase();
      if (lower.startsWith('rtk ')) return;

      // Tomar la primera palabra para comparar con los prefijos conocidos
      const firstWord = lower.split(/\s+/)[0];

      if (RTK_PREFIXES.has(firstWord) && rtkAvailable) {
        // Reescribir: git status -> rtk git status
        if (args.command) args.command = `rtk ${command}`;
        else if (args.query) args.query = `rtk ${command}`;
        // Opcional: trace silencioso
        if (process.env.KLIA_DEBUG) {
          console.log(`[openrtk] rewrote ${firstWord} command with rtk prefix`);
        }
      }
      // Si rtk no está disponible: hacer nada (comando original sigue corriendo)
    },

    'tool.execute.after': async (input, output) => {
      // No hace falta intervenir: la salida ya viene comprimida por rtk.
      // Si quieres trazar algo, puedes inspeccionar output.result.size aquí.
    },
  };
};