# ERR-7: fechas desplazadas un mes

Reportado por QA. Reproducible siempre.

```
$ node -e "import('./src/utils/dates.js').then(m => console.log(m.toIsoDay(m.parseSpanishDate('15/03/2026'))))"
2026-04-15
```

Resultado esperado: `2026-03-15`.

Con `31/01/2026` el resultado es `2026-03-03`.

Se pide: corregir el defecto en el codigo fuente sin cambiar la firma de las funciones
y manteniendo los tests existentes en verde.
