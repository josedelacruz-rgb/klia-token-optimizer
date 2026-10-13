/**
 * Tabla de pricing por modelo/familia.
 *
 * Precios en USD por 1 millón de tokens.
 * Fuentes: pricing público de cada proveedor (aproximado, septiembre 2026).
 *
 * Si un modelo no está en la tabla, se usa el pricing de su familia.
 * Si la familia no existe, se usa el pricing de fallback.
 */

export interface ModelPricing {
  /** USD por 1M tokens de entrada. */
  inputPerMillion: number;
  /** USD por 1M tokens de salida. */
  outputPerMillion: number;
}

/** Pricing por familia de modelo. */
const FAMILY_PRICING: Record<string, ModelPricing> = {
  glm: { inputPerMillion: 0.5, outputPerMillion: 1.5 },
  deepseek: { inputPerMillion: 0.27, outputPerMillion: 1.1 },
  kimi: { inputPerMillion: 0.6, outputPerMillion: 2.4 },
  qwen: { inputPerMillion: 0.5, outputPerMillion: 1.5 },
  mistral: { inputPerMillion: 2.0, outputPerMillion: 6.0 },
  magistral: { inputPerMillion: 2.0, outputPerMillion: 6.0 },
  ministral: { inputPerMillion: 0.3, outputPerMillion: 0.9 },
  minimax: { inputPerMillion: 0.8, outputPerMillion: 2.4 },
  nemotron: { inputPerMillion: 0.4, outputPerMillion: 1.2 },
  gemma: { inputPerMillion: 0.2, outputPerMillion: 0.6 },
  devstral: { inputPerMillion: 0.4, outputPerMillion: 1.2 },
  cosmos: { inputPerMillion: 1.0, outputPerMillion: 3.0 },
  ami: { inputPerMillion: 0.3, outputPerMillion: 0.9 },
  codestral: { inputPerMillion: 0.5, outputPerMillion: 1.5 },
  llama: { inputPerMillion: 0.4, outputPerMillion: 1.2 },
  claude: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  gpt: { inputPerMillion: 2.5, outputPerMillion: 10.0 },
};

/** Pricing por modelo exacto (sobreescribe al de familia). */
const MODEL_PRICING: Record<string, ModelPricing> = {
  'glm-5.2': { inputPerMillion: 0.5, outputPerMillion: 1.5 },
  'glm-5.3-flash': { inputPerMillion: 0.2, outputPerMillion: 0.6 },
  'deepseek-v4-pro': { inputPerMillion: 0.27, outputPerMillion: 1.1 },
  'deepseek-v4-flash-demo': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  'deepseek-v4.1-flash': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  'kimi-k2.6': { inputPerMillion: 0.6, outputPerMillion: 2.4 },
  'kimi-k2.7-code': { inputPerMillion: 0.8, outputPerMillion: 3.2 },
  'mistral-large-3': { inputPerMillion: 2.0, outputPerMillion: 6.0 },
  'mistral-medium': { inputPerMillion: 0.9, outputPerMillion: 2.7 },
  'minimax-m3': { inputPerMillion: 0.8, outputPerMillion: 2.4 },
  'gemma4': { inputPerMillion: 0.2, outputPerMillion: 0.6 },
};

/** Pricing de fallback si no se encuentra el modelo ni la familia. */
const FALLBACK_PRICING: ModelPricing = {
  inputPerMillion: 1.0,
  outputPerMillion: 3.0,
};

/**
 * Obtiene el pricing de un modelo.
 *
 * Orden de prioridad:
 *   1. Modelo exacto (normalizado a minúsculas).
 *   2. Familia del modelo.
 *   3. Fallback genérico.
 */
export function getPricing(model: string, family?: string): ModelPricing {
  const normalized = model.trim().toLowerCase();
  if (MODEL_PRICING[normalized]) return MODEL_PRICING[normalized];
  if (family && FAMILY_PRICING[family]) return FAMILY_PRICING[family];
  return FALLBACK_PRICING;
}

/**
 * Calcula el coste en USD de una ejecución.
 *
 * @param inputTokens Tokens de entrada (prompt).
 * @param outputTokens Tokens de salida (completion).
 * @param model Modelo utilizado.
 * @param family Familia del modelo (opcional).
 * @returns Coste en USD.
 */
export function computeCostUsd(
  inputTokens: number,
  outputTokens: number,
  model: string,
  family?: string,
): number {
  const pricing = getPricing(model, family);
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}
