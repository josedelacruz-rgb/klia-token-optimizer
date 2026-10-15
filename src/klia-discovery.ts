import * as fs from 'fs';
import * as path from 'path';
import { extractModelFamily, isChatModel } from './utils/model-family';
import { stripBom } from './utils/json';

/**
 * Descubrimiento dinamico de modelos desde la API de KLIA.
 *
 * Orden de resolucion:
 *   1. KLIA_API_KEY en variables de entorno (empieza por "key-")
 *   2. provider.klia.options.apiKey en opencode.jsonc
 *   3. Snapshot estatico (SNAPSHOT_MODELS) como fallback
 */

const KLIA_API_BASE = 'https://api.klia.tech/v1';
const KLIA_MODELS_ENDPOINT = `${KLIA_API_BASE}/models`;

/**
 * Snapshot estatico de modelos de KLIA (copia de seguridad).
 * Se actualiza manualmente cuando se publica una nueva version del script.
 * Si la API responde, esta lista se ignora.
 */
export const SNAPSHOT_MODELS: string[] = [
  'GLM-5.2',
  'glm-5.3-flash',
  'deepseek-v4-pro',
  'deepseek-v4.1-flash',
  'deepseek-v4-flash-demo',
  'kimi-k2.6',
  'kimi-k2.7-code',
  'qwen3.8-27b',
  'mistral-large-3',
  'mistral-medium',
  'magistral-small',
  'ministral-3-14b',
  'nemotron-3-nano',
  'nemotron-3-nano-demo',
  'nemotron-3-super',
  'nemotron-3-ultra',
  'Nemotron-3-Nano-Omni',
  'minimax-m2.7-chat',
  'minimax-m3',
  'gemma4',
  'gemma4-demo',
  'devstral-small',
  'devstral-medium',
  'codestral-latest',
  'Cosmos3-Super-Reasoner',
  'ami-chat-v1',
];

export interface DiscoveredModel {
  id: string;
  family: string;
}

export interface DiscoveryResult {
  models: DiscoveredModel[];
  source: 'api' | 'snapshot';
  error?: string;
}

/**
 * Detecta la API key de KLIA en este orden:
 *   1. Variable de entorno KLIA_API_KEY (debe empezar por "key-")
 *   2. Variable de entorno OPENAI_API_KEY si empieza por "key-"
 *   3. provider.klia.options.apiKey en opencode.jsonc
 */
export function detectKliaApiKey(): string | null {
  // 1. KLIA_API_KEY en entorno
  const kliaKey = process.env.KLIA_API_KEY;
  if (kliaKey && kliaKey.startsWith('key-')) {
    return kliaKey;
  }

  // 2. OPENAI_API_KEY si empieza por key- (KLIA la replica como OPENAI_API_KEY)
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey && openaiKey.startsWith('key-')) {
    return openaiKey;
  }

  // 3. Leer opencode.jsonc
  const opencodePath = findOpencodeConfig();
  if (opencodePath) {
    try {
      const raw = fs.readFileSync(opencodePath, 'utf-8');
      // opencode.jsonc admite comentarios, hay que limpiarlos antes de parsear.
      // Tambien se elimina BOM por si el editor lo anadio.
      const cleaned = stripJsonComments(stripBom(raw));
      const config = JSON.parse(cleaned);
      const kliaApiKey = config?.provider?.klia?.options?.apiKey;
      if (typeof kliaApiKey === 'string' && kliaApiKey.startsWith('key-')) {
        return kliaApiKey;
      }
    } catch {
      // Ignorar errores de parseo y seguir
    }
  }

  return null;
}

/**
 * Busca el archivo de configuracion de OpenCode en ubicaciones estandar.
 */
function findOpencodeConfig(): string | null {
  // USERPROFILE (Windows) y HOME (Unix) pueden apuntar al mismo directorio;
  // se deduplican para no comprobar la misma ruta dos veces.
  const baseDirs = [
    ...new Set([process.env.USERPROFILE, process.env.HOME].filter(Boolean)),
  ] as string[];
  const candidates = baseDirs.flatMap((base) => [
    path.join(base, '.config', 'opencode', 'opencode.jsonc'),
    path.join(base, '.config', 'opencode', 'opencode.json'),
  ]);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Continuar
    }
  }
  return null;
}

/**
 * Elimina comentarios JSONC (// y bloque) de un string.
 * Implementacion minimalista para opencode.jsonc.
 */
function stripJsonComments(input: string): string {
  let result = '';
  let i = 0;
  let inString = false;

  while (i < input.length) {
    const char = input[i];
    const next = input[i + 1];

    if (inString) {
      if (char === '\\' && next !== undefined) {
        result += char + next;
        i += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      result += char;
      i++;
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      i++;
      continue;
    }

    if (char === '/' && next === '/') {
      // Comentario de linea: saltar hasta fin de linea
      i += 2;
      while (i < input.length && input[i] !== '\n') {
        i++;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      // Comentario de bloque: saltar hasta */
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
        i++;
      }
      i += 2;
      continue;
    }

    result += char;
    i++;
  }

  return result;
}

/**
 * Consulta la API de KLIA para descubrir los modelos disponibles.
 * Devuelve solo modelos de chat (filtra embeddings, imagen, etc.).
 */
export async function discoverModelsFromApi(apiKey?: string): Promise<DiscoveredModel[]> {
  const key = apiKey ?? detectKliaApiKey();
  if (!key) {
    throw new Error('No se encontro KLIA_API_KEY');
  }

  // Usar fetch nativo (Node 18+) con timeout para no colgar el servidor MCP
  // si la API de KLIA no responde.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(KLIA_MODELS_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`API KLIA respondio ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { data?: Array<{ id: string }> };
    if (!data.data || !Array.isArray(data.data)) {
      throw new Error('Respuesta de API KLIA no contiene array data');
    }

    // Filtrar solo modelos de chat
    return data.data
      .map((m) => m.id)
      .filter((id) => isChatModel(id))
      .map((id) => ({
        id,
        family: extractModelFamily(id),
      }));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Descubrimiento de modelos con fallback a snapshot.
 *
 * 1. Intenta la API de KLIA si hay API key.
 * 2. Si falla, usa el snapshot estatico.
 */
export async function discoverModels(apiKey?: string): Promise<DiscoveryResult> {
  try {
    const models = await discoverModelsFromApi(apiKey);
    if (models.length > 0) {
      return { models, source: 'api' };
    }
    return {
      models: SNAPSHOT_MODELS.map((id) => ({ id, family: extractModelFamily(id) })),
      source: 'snapshot',
      error: 'API devolvio 0 modelos',
    };
  } catch (err) {
    return {
      models: SNAPSHOT_MODELS.map((id) => ({ id, family: extractModelFamily(id) })),
      source: 'snapshot',
      error: (err as Error).message,
    };
  }
}
