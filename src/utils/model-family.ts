/**
 * Normaliza el identificador de modelo a minúsculas.
 *
 * KLIA acepta modelos con casing mixto (GLM-5.2, glm-5.2, Deepseek-v4).
 * Para evitar entradas duplicadas en el histórico, se normaliza al guardar
 * y al consultar. La familia se extrae en minúsculas de todos modos.
 *
 * Ejemplos:
 *   GLM-5.2               -> glm-5.2
 *   Deepseek-v4-pro       -> deepseek-v4-pro
 *   Cosmos3-Super-Reasoner-> cosmos3-super-reasoner
 */
export function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}

/**
 * Extrae la familia de un modelo a partir de su identificador.
 *
 * Familias conocidas en KLIA (orden por especificidad, mas especifico primero):
 *   - glm          GLM-5.2, glm-5.3-flash
 *   - deepseek      deepseek-v4-pro, deepseek-v4.1-flash
 *   - kimi          kimi-k2.6, kimi-k2.7-code
 *   - qwen          qwen3.8-27b, Qwen3-Embedding-8B
 *   - mistral       mistral-large-3, mistral-medium, magistral-small, ministral-3-14b
 *   - nemotron      nemotron-3-nano, nemotron-3-super, nemotron-3-ultra
 *   - minimax       minimax-m2.7-chat, minimax-m3
 *   - gemma         gemma4, gemma4-demo
 *   - devstral      devstral-small, devstral-medium
 *   - cosmos        Cosmos3-Super-Reasoner
 *   - ami           ami-chat-v1, ami-embeddings-v1
 *   - codestral     codestral-latest (familia Mistral, pero con nombre propio)
 *   - llama         fallback (no existe en KLIA, pero se mantiene por compat)
 *
 * Ejemplos:
 *   GLM-5.2               -> glm
 *   deepseek-v4-pro       -> deepseek
 *   kimi-k2.7-code         -> kimi
 *   Nemotron-3-Nano-Omni   -> nemotron
 *   Cosmos3-Super-Reasoner-> cosmos
 *   ami-chat-v1            -> ami
 */
export function extractModelFamily(model: string): string {
  const normalized = model.toLowerCase();

  // Ordenadas por especificidad: las mas largas primero para evitar matches parciales.
  const knownFamilies = [
    'deepseek',
    'nemotron',
    'devstral',
    'codestral',
    'minimax',
    'ministral',
    'magistral',
    'mistral',
    'cosmos',
    'gemma',
    'kimi',
    'qwen',
    'glm',
    'ami',
    'llama',
  ];

  for (const family of knownFamilies) {
    if (normalized.includes(family)) {
      return family;
    }
  }

  // Fallback: primer segmento antes de un guión, punto o espacio.
  const match = normalized.match(/^[a-z]+/);
  return match?.[0] ?? 'unknown';
}

/**
 * Filtra modelos que no son de chat (embeddings, imagen, moderacion).
 * KLIA expone todos los modelos en /v1/models, pero el router solo
 * debe enrutar modelos de chat.
 */
export function isChatModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  // Excluir embeddings, imagen, moderacion, flux
  const excludePatterns = [
    'embedding',
    'moderation',
    'flux',
    'qwen-image',
  ];
  for (const pattern of excludePatterns) {
    if (lower.includes(pattern)) {
      return false;
    }
  }
  return true;
}
