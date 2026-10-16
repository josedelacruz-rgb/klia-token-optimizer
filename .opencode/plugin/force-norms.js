// OpenCode plugin: fuerza la aplicación de normas de router y compresión
// cada vez que opencode inicia. Se ejecuta antes de que el usuario envíe cualquier
// herramienta y garantiza que las reglas por defecto están presentes.
//
// Funciones:
// - Asegura que opencode.json tenga los plugins requeridos.
// - Corrige la regla SMALL_CODE → SEMBLE en base-rules.ts (si estuviera revertido).
// - Exporta la constante KLIA_FORCE_NORMS=1 para que el router la lea.

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const OPencode_JSON = path.join(PROJECT_ROOT, 'opencode.json');
const BASE_RULES_TS = path.join(PROJECT_ROOT, 'src', 'rules', 'base-rules.ts');

function ensurePluginInJson(pluginPath) {
  const absPlugin = path.resolve(PROJECT_ROOT, pluginPath);
  if (!fs.existsSync(absPlugin)) return false;
  const schema = JSON.parse(fs.readFileSync(OPencode_JSON, 'utf8'));
  const already = schema.plugin?.includes(absPlugin);
  if (!already) {
    schema.plugin = (schema.plugin || []).concat(absPlugin);
    fs.writeFileSync(OPencode_JSON, JSON.stringify(schema, null, 2));
  }
  return true;
}

function ensureSmallCodeRule() {
  // Busca la línea "SMALL_CODE:" y asegura que sea ['SEMBLE']
  let content = fs.readFileSync(BASE_RULES_TS, 'utf8');
  const oldLine = "SMALL_CODE: ['BASELINE']";
  const newLine = "SMALL_CODE: ['SEMBLE']";
  if (content.includes(oldLine) && !content.includes(newLine)) {
    content = content.replace(oldLine, newLine);
    fs.writeFileSync(BASE_RULES_TS, content);
    return true;
  }
  return false;
}

module.exports = async ({ config, directory }) => {
  // Ejecutar una sola vez al cargar el plugin
  const normsApplied = ensureSmallCodeRule();
  ensurePluginInJson('./.opencode/plugin/openrtk.js');
  ensurePluginInJson('./.opencode/plugin/klia-auto-record.js');

  if (normsApplied || process.env.KLIA_DEBUG) {
    console.log('[force-norms] Normas aplicadas: SMALL_CODE→SEMBLE, plugins asegurados');
  }

  // Exportar bandera para que el router o cualquier otro módulo pueda consultarla
  // (usamos un archivo de señal simple)
  const signalPath = path.join(PROJECT_ROOT, 'data', 'force-norms.signal');
  fs.writeFileSync(signalPath, '1', 'utf8');
};