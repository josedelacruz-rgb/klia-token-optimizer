# Router Learning — Validacion del aprendizaje adaptativo

## Evidencia (Fase A3 + G)

- **A3**: con historico sintetico inyectado, el router pasa a V2 (basado en coste observado).
- **G (train/test split)**: 2/2 V2 en test.

## Train/test split

- Train: T1_SMALL_CODE, T2_TERMINAL, T3_LARGE_CONTEXT, T4_REPOSITORY_SEARCH
- Test:  T5_MULTISTEP, T6_REFACTOR
- Decisiones en test: [
  {
    "id": "T5_MULTISTEP",
    "esperado": "DCP",
    "obtenido": "DCP",
    "version": "V2"
  },
  {
    "id": "T6_REFACTOR",
    "esperado": "RTK",
    "obtenido": "RTK",
    "version": "V2"
  }
]

## Limitaciones

- Un cambio de recomendacion no es sinonimo de mejora.
- El router aprende segun computeEventCost que penaliza fallos y calidad baja.
- Si la calidad es unknown o hardcodeada, la senal de aprendizaje es ruido.
- Con datos sinteticos (no marcados como synthetic), el router aprende de mentiras.
