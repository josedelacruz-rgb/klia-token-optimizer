# Limitations — Limitaciones de la suite rapida

## Metricas NO MEDIBLES en este script

| Metrica | Razon | Como medirla |
|---|---|---|
| **Tokens reales de entrada al LLM** | Requiere sesion OpenCode con el modelo facturando | Capturar `info.tokens.input` de cada mensaje |
| **Tokens reales de salida del LLM** | Requiere sesion OpenCode | Capturar `info.tokens.output` |
| **Tokens en cache** | NO IMPLEMENTADO en el schema v2 | Anadir `cacheTokens` al schema + capturar del proveedor |
| **Tokens de razonamiento** | NO IMPLEMENTADO en el schema v2 | Anadir al schema si el proveedor lo informa |
| **Calidad real** | El plugin hardcodea 0.95; no evalua el resultado | Tests automatizados o evaluador externo |
| **Coste real del proveedor** | El script usa tabla pricing estimada | Capturar `info.cost` de cada mensaje OpenCode |
| **DCP (MULTISTEP)** | Requiere sesion interactiva con diff entre turnos | Sesion OpenCode real, comparar tokens turno a turno |

## Tokenizador

- Este script usa `gpt-tokenizer` (cl100k_base, GPT-4).
- NO es el tokenizer exacto de glm-5.2 (familia GLM).
- Los conteos son estimaciones; para medicion definitiva, usar el del modelo.

## Repeticiones

- Solo 3 repeticiones por condicion. Variabilidad no caracterizada.
- Para significancia estadistica: 10+ repeticiones.

## Defectos del proyecto documentados

- **D1**: plugin hardcodea `--quality 0.95`.
- **D2**: `calibrate.ts` inyecta datos sinteticos sin marca `synthetic: true`.
- **D3**: CLI `--record-execution` no deduplica por sessionId.
- **D4**: `RouterEventStore.add()` no es atomico (read->push->write).
- **D5**: `JsonHistoryStore.read()` sin try/catch en JSON.parse.

