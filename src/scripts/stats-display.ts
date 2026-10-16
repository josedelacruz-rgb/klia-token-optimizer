/**
 * Presentacion profesional del reporte de estadisticas del router.
 *
 * 8 secciones con colores ANSI directos (sin dependencias externas):
 *   1. Header con branding
 *   2. Resumen ejecutivo (KPIs en cards)
 *   3. Salud del sistema
 *   4. Ranking de modelos (byModel)
 *   5. Matriz modelo x tarea (heatmap)
 *   6. Detalle por modelo+tarea (byModelTask)
 *   7. Ahorro global y veredicto
 *   8. Calibracion de confianza + recomendaciones
 *
 * Uso:
 *   npm run router -- stats [--model M] [--task T] [--real-only] [--no-color]
 */
import * as path from 'path';
import { RouterEventStore } from '../history/router-event-store';
import { buildStatsReport } from '../scorer/stats-report';
import { ALL_OPTIMIZERS, DEFAULT_ROUTER_OPTIONS } from '../types';
import type { Optimizer, TaskType } from '../types';
import type { RouterStatsReport, OptimizerCell, ModelTaskRow } from '../scorer/stats-report';
import { pad, fmt, fmtInt, fmtPct, fmtUsd } from './format';
import {
  bold,
  dim,
  red,
  green,
  yellow,
  blue,
  magenta,
  cyan,
  white,
  bRed,
  bGreen,
  bYellow,
  bBlue,
  bMagenta,
  bCyan,
  bWhite,
  bgGreen,
  bgYellow,
  bgRed,
  setColorEnabled,
} from './ansi';

// ============================================================================
// Codigos ANSI
// ============================================================================
// Los codigos y helpers de color viven en ./ansi.ts (estado centralizado).

// ============================================================================
// Utilidades
// ============================================================================
// Los formateadores puros (pad, fmt, fmtInt, fmtPct, fmtUsd) viven en
// ./format.ts y se importan arriba.

function colorBySavings(pct: number | null): string {
  if (pct === null) return dim('-');
  if (pct >= 15) return bGreen(`+${pct.toFixed(1)}%`);
  if (pct >= 5) return green(`+${pct.toFixed(1)}%`);
  if (pct > 0) return yellow(`+${pct.toFixed(1)}%`);
  if (pct === 0) return dim('0.0%');
  if (pct > -5) return yellow(`${pct.toFixed(1)}%`);
  if (pct > -15) return red(`${pct.toFixed(1)}%`);
  return bRed(`${pct.toFixed(1)}%`);
}

function verdictBadge(v: 'AHORRO' | 'PERDIDA' | 'NEUTRO', winner: boolean): string {
  if (winner) return bgGreen(bold(' GANADOR '));
  if (v === 'AHORRO') return bGreen(' AHORRO ');
  if (v === 'PERDIDA') return bRed(' PERDIDA ');
  return dim(' NEUTRO ');
}

function confidenceBadge(level: string): string {
  switch (level) {
    case 'Alto':
      return bgGreen(bold(' ALTO '));
    case 'Medio':
      return bgYellow(bold(' MEDIO '));
    case 'Bajo':
      return bgYellow(' BAJO ');
    case 'Insuficiente':
      return bgRed(bold(' INSUFICIENTE '));
    default:
      return level;
  }
}

function qualityColor(q: number): string {
  if (q >= 0.95) return bGreen(q.toFixed(3));
  if (q >= 0.9) return green(q.toFixed(3));
  if (q >= 0.8) return yellow(q.toFixed(3));
  return red(q.toFixed(3));
}

function failureRateColor(f: number): string {
  if (f === 0) return bGreen('0.000');
  if (f < 0.1) return yellow(f.toFixed(3));
  return bRed(f.toFixed(3));
}

function latencyColor(l: number): string {
  if (l < 30) return bGreen(l.toFixed(1) + 's');
  if (l < 90) return green(l.toFixed(1) + 's');
  if (l < 180) return yellow(l.toFixed(1) + 's');
  return bRed(l.toFixed(1) + 's');
}

function optimizerColor(opt: Optimizer): string {
  switch (opt) {
    case 'BASELINE':
      return dim(opt);
    case 'DCP':
      return cyan(opt);
    case 'RTK':
      return magenta(opt);
    case 'CONTEXT_MODE':
      return blue(opt);
    case 'REPOMIX':
      return yellow(opt);
    case 'SEMBLE':
      return green(opt);
    case 'SERENA':
      return bCyan(opt);
    default:
      return opt;
  }
}

function modelColor(model: string): string {
  if (model.includes('glm')) return cyan(model);
  if (model.includes('deepseek')) return magenta(model);
  if (model.includes('gpt')) return green(model);
  if (model.includes('claude')) return blue(model);
  return bWhite(model);
}

function familyColor(family: string): string {
  switch (family) {
    case 'glm':
      return cyan(family);
    case 'deepseek':
      return magenta(family);
    case 'gpt':
      return green(family);
    case 'claude':
      return blue(family);
    default:
      return bWhite(family);
  }
}

function taskTypeColor(t: string): string {
  switch (t) {
    case 'SMALL_CODE':
    case 'SMALL_C':
      return green(t);
    case 'TERMINAL':
      return yellow(t);
    case 'LARGE_CONTEXT':
    case 'LRG_CTX':
      return magenta(t);
    case 'REPOSITORY_SEARCH':
    case 'REP_SRCH':
      return blue(t);
    case 'MULTISTEP':
    case 'MULTI':
      return cyan(t);
    case 'REFACTOR':
      return red(t);
    case 'DEBUG':
      return bRed(t);
    default:
      return t;
  }
}

function line(char = '-', len = 80): string {
  return dim(char.repeat(len));
}

function title(text: string, color: (s: string) => string = bCyan): string {
  return bold(color(text));
}

// ============================================================================
// Seccion 1: Header con branding
// ============================================================================

function sectionHeader(): string {
  const bar = bCyan('='.repeat(80));
  const title1 = bold(bCyan('  klia-token-optimizer  '));
  const title2 = bold(bCyan('  Router Adaptativo de Optimizadores de Contexto  '));
  const bar2 = bCyan('='.repeat(80));
  return ['', bar, title1, title2, bar2, ''].join('\n');
}

// ============================================================================
// Seccion 2: Resumen ejecutivo (KPIs en cards)
// ============================================================================

function card(label: string, value: string, color: (s: string) => string): string {
  const width = 18;
  const line1 = color(bold(pad(label, width - 2, 'center')));
  const line2 = color(bold(pad(value, width - 2, 'center')));
  return [
    color('+') + color('-'.repeat(width - 2)) + color('+'),
    color('|') + line1 + color('|'),
    color('|') + line2 + color('|'),
    color('+') + color('-'.repeat(width - 2)) + color('+'),
  ].join('\n');
}

function section2Summary(report: RouterStatsReport): string {
  const s = report.summary;
  const out: string[] = [];
  out.push(title('  SECCION 1/8  -  RESUMEN EJECUTIVO', bCyan));
  out.push(line('=', 80));
  out.push('');

  // 8 cards en 2 filas de 4
  const cards: string[] = [];
  const realPct = s.totalExecutions > 0 ? (s.realCount / s.totalExecutions) * 100 : 0;

  cards.push(card('EJECUCIONES', bWhite(bold(String(s.totalExecutions))), bCyan));
  cards.push(card('REALES', bGreen(String(s.realCount)), bGreen));
  cards.push(card('SINTETICOS', dim(String(s.syntheticCount)), (t: string) => yellow(t)));
  cards.push(card('DECISIONES', bBlue(String(s.totalDecisions)), bBlue));

  cards.push(card('MODELOS', bMagenta(String(s.uniqueModels.length)), bMagenta));
  cards.push(card('OPTIMIZADORES', bYellow(String(ALL_OPTIMIZERS.length)), bYellow));
  cards.push(card('TIPOS TAREA', bCyan(String(s.uniqueTaskTypes.length)), bCyan));
  cards.push(card('CONFIANZA', confidenceBadge(s.confidenceLevel), (t: string) => t));

  // Renderizar en 2 filas de 4 cards
  for (let row = 0; row < 2; row++) {
    const slice = cards.slice(row * 4, row * 4 + 4);
    const lines: string[] = ['', '', '', ''];
    for (const c of slice) {
      const cLines = c.split('\n');
      for (let i = 0; i < 4; i++) {
        lines[i] = (lines[i] ?? '') + ' ' + cLines[i];
      }
    }
    out.push(...lines);
    out.push('');
  }

  // Datos adicionales
  out.push(
    dim('  Periodo: ') +
      bWhite(s.dateRange.from ?? '-') +
      dim(' -> ') +
      bWhite(s.dateRange.to ?? '-'),
  );
  out.push(dim('  Familias: ') + s.uniqueModelFamilies.map(familyColor).join(dim(', ')));
  out.push(
    dim('  Cobertura real: ') +
      (realPct >= 50
        ? bGreen(realPct.toFixed(1) + '%')
        : realPct >= 10
          ? bYellow(realPct.toFixed(1) + '%')
          : bRed(realPct.toFixed(1) + '%')),
  );
  out.push('');

  return out.join('\n');
}

// ============================================================================
// Seccion 3: Salud del sistema
// ============================================================================

function section3Health(report: RouterStatsReport): string {
  const s = report.summary;
  const out: string[] = [];
  out.push(title('  SECCION 2/8  -  SALUD DEL SISTEMA', bCyan));
  out.push(line('=', 80));
  out.push('');

  const coverage = s.totalDecisions > 0 ? (s.matchedDecisions / s.totalDecisions) * 100 : 0;
  const realModelsPct =
    s.uniqueModels.length > 0 ? (s.realModels / s.uniqueModels.length) * 100 : 0;
  const rangeHours =
    s.dateRange.from && s.dateRange.to
      ? (new Date(s.dateRange.to).getTime() - new Date(s.dateRange.from).getTime()) / 3_600_000
      : null;

  const health: Array<{
    metric: string;
    value: string;
    status: string;
    statusColor: (s: string) => string;
  }> = [
    {
      metric: 'Decisiones huerfanas',
      value: String(s.orphanDecisions),
      status: s.orphanDecisions === 0 ? 'OK' : s.orphanDecisions > 5 ? 'CRITICO' : 'WARN',
      statusColor: (st) => (st === 'OK' ? bGreen(st) : st === 'CRITICO' ? bRed(st) : bYellow(st)),
    },
    {
      metric: 'Decisiones emparejadas',
      value: `${s.matchedDecisions}/${s.totalDecisions}`,
      status: coverage >= 80 ? 'OK' : coverage >= 50 ? 'WARN' : 'CRITICO',
      statusColor: (st) => (st === 'OK' ? bGreen(st) : st === 'WARN' ? bYellow(st) : bRed(st)),
    },
    {
      metric: 'Cobertura de metricas',
      value: `${s.matchedDecisions}/${s.totalDecisions} (${coverage.toFixed(1)}%)`,
      status: coverage >= 80 ? 'OK' : coverage >= 50 ? 'WARN' : 'CRITICO',
      statusColor: (st) => (st === 'OK' ? bGreen(st) : st === 'WARN' ? bYellow(st) : bRed(st)),
    },
    {
      metric: 'Decisiones totales',
      value: String(s.totalDecisions),
      status: s.totalDecisions >= 10 ? 'OK' : 'WARN',
      statusColor: (st) => (st === 'OK' ? bGreen(st) : bYellow(st)),
    },
    {
      metric: 'Ejecuciones reales',
      value: String(s.realCount),
      status: s.realCount >= 10 ? 'OK' : s.realCount >= 3 ? 'WARN' : 'CRITICO',
      statusColor: (st) => (st === 'OK' ? bGreen(st) : st === 'WARN' ? bYellow(st) : bRed(st)),
    },
    {
      metric: 'Sinteticos vs reales',
      value: `${s.syntheticCount} sint / ${s.realCount} real`,
      status: s.realCount > 0 ? 'OK' : 'WARN',
      statusColor: (st) => (st === 'OK' ? bGreen(st) : bYellow(st)),
    },
    {
      metric: 'Modelos con datos reales',
      value: `${s.realModels}/${s.uniqueModels.length}`,
      status: realModelsPct >= 75 ? 'OK' : realModelsPct >= 25 ? 'WARN' : 'CRITICO',
      statusColor: (st) => (st === 'OK' ? bGreen(st) : st === 'WARN' ? bYellow(st) : bRed(st)),
    },
    {
      metric: 'Rango temporal',
      value: rangeHours !== null ? `~${rangeHours.toFixed(1)}h` : '-',
      status: 'OK',
      statusColor: (st) => bGreen(st),
    },
  ];

  out.push(`  ${pad('Metrica', 32)} ${pad('Valor', 28)} ${pad('Estado', 12)}`);
  out.push(`  ${line('-', 30)} ${line('-', 26)} ${line('-', 10)}`);
  for (const h of health) {
    out.push(`  ${pad(h.metric, 32)} ${pad(h.value, 28)} ${h.statusColor(pad(h.status, 12))}`);
  }
  out.push('');

  return out.join('\n');
}

// ============================================================================
// Seccion 4: Ranking de modelos (byModel)
// ============================================================================

function section4ByModel(report: RouterStatsReport): string {
  const out: string[] = [];
  out.push(title('  SECCION 3/8  -  RANKING DE MODELOS', bCyan));
  out.push(line('=', 80));
  out.push('');

  if (report.byModel.length === 0) {
    out.push(dim('  Sin datos por modelo.'));
    out.push('');
    return out.join('\n');
  }

  const header = `  ${pad('Modelo', 18)} ${pad('Familia', 10)} ${pad('Ejecuc.', 9)} ${pad('Tokens', 10)} ${pad('Latencia', 10)} ${pad('Calidad', 9)} ${pad('Fallos', 7)} ${pad('Mejor opt.', 12)} ${pad('Ahorro %', 10)}`;
  out.push(header);
  out.push(`  ${line('-', 95)}`);

  for (const m of report.byModel) {
    const row = [
      pad(modelColor(m.model), 18),
      pad(familyColor(m.modelFamily), 10),
      pad(fmtInt(m.executions), 9),
      pad(fmtInt(m.avgTokens), 10),
      pad(latencyColor(m.avgLatency), 10),
      pad(qualityColor(m.avgQuality), 9),
      pad(failureRateColor(m.failureRate), 7),
      pad(m.bestOptimizer ? optimizerColor(m.bestOptimizer) : dim('-'), 12),
      pad(colorBySavings(m.savingsVsBaselinePercent), 10),
    ].join(' ');
    out.push('  ' + row);
  }
  out.push('');

  return out.join('\n');
}

// ============================================================================
// Seccion 5: Matriz modelo x tarea (heatmap)
// ============================================================================

function section5Heatmap(report: RouterStatsReport): string {
  const out: string[] = [];
  out.push(title('  SECCION 4/8  -  MATRIZ MODELO x TAREA (HEATMAP DE AHORRO)', bCyan));
  out.push(line('=', 80));
  out.push('');

  if (report.byModelTask.length === 0) {
    out.push(dim('  Sin datos por combinacion modelo+tarea.'));
    out.push('');
    return out.join('\n');
  }

  const models = [...new Set(report.byModelTask.map((r) => r.model))].sort();
  const tasks: TaskType[] = [...new Set(report.byModelTask.map((r) => r.taskType))].sort();

  // Encontrar el mejor ahorro por combinacion (mayor savingsPercent con samples)
  const best = new Map<string, number | null>();
  for (const row of report.byModelTask) {
    const key = `${row.model}::${row.taskType}`;
    let bestSavings: number | null = null;
    for (const c of row.optimizers) {
      if (c.optimizer === 'BASELINE') continue;
      if (c.samples < 1) continue;
      if (c.savingsPercent !== null) {
        if (bestSavings === null || c.savingsPercent > bestSavings) {
          bestSavings = c.savingsPercent;
        }
      }
    }
    best.set(key, bestSavings);
  }

  // Encabezado de tareas (con abreviaturas para que quepan en la celda)
  const abbr: Record<string, string> = {
    SMALL_CODE: 'SMALL_C',
    TERMINAL: 'TERMINAL',
    LARGE_CONTEXT: 'LRG_CTX',
    REPOSITORY_SEARCH: 'REP_SRCH',
    MULTISTEP: 'MULTI',
    REFACTOR: 'REFACTOR',
    DEBUG: 'DEBUG',
    UNKNOWN: 'UNKNOWN',
  };
  const taskHeader = tasks.map((t) => pad(taskTypeColor(abbr[t]), 12)).join(' ');
  out.push(`  ${pad('Modelo \\ Tarea', 18)} ${taskHeader}`);
  out.push(`  ${line('-', 18)} ${line('-', tasks.length * 13 - 1)}`);

  for (const model of models) {
    const cells: string[] = [];
    for (const task of tasks) {
      const key = `${model}::${task}`;
      const savings = best.get(key);
      if (savings === null || savings === undefined) {
        cells.push(pad(dim('  -'), 12));
      } else {
        const txt = `${savings >= 0 ? '+' : ''}${savings.toFixed(0)}%`;
        let colored: string;
        if (savings >= 15) colored = bgGreen(bold(pad(txt, 12, 'center')));
        else if (savings >= 5) colored = bGreen(pad(txt, 12, 'center'));
        else if (savings > 0) colored = yellow(pad(txt, 12, 'center'));
        else if (savings === 0) colored = dim(pad('  0%', 12, 'center'));
        else if (savings > -10) colored = red(pad(txt, 12, 'center'));
        else colored = bgRed(bold(pad(txt, 12, 'center')));
        cells.push(colored);
      }
    }
    out.push(`  ${pad(modelColor(model), 18)} ${cells.join(' ')}`);
  }
  out.push('');

  // Leyenda
  out.push(
    dim('  Leyenda: ') +
      bgGreen(bold(' >=15% ')) +
      ' ' +
      bGreen(' 5-15% ') +
      ' ' +
      yellow(' 0-5% ') +
      ' ' +
      dim(' 0% ') +
      ' ' +
      red(' <0% ') +
      ' ' +
      bgRed(bold(' <-10% ')),
  );
  out.push('');

  return out.join('\n');
}

// ============================================================================
// Seccion 6: Detalle por modelo+tarea (byModelTask)
// ============================================================================

function renderCell(c: OptimizerCell): string[] {
  const opt = c.winner ? bgGreen(bold(pad(c.optimizer, 11))) : pad(optimizerColor(c.optimizer), 11);
  return [
    opt,
    pad(String(c.samples), 8),
    pad(fmtInt(c.avgTokens), 12),
    pad(latencyColor(c.avgLatency), 11),
    pad(qualityColor(c.avgQuality), 8),
    pad(colorBySavings(c.savingsPercent), 10),
    pad(fmtUsd(c.savingsUsd), 10),
    pad(verdictBadge(c.verdict, c.winner), 12),
  ];
}

function section6ByModelTask(report: RouterStatsReport): string {
  const out: string[] = [];
  out.push(title('  SECCION 5/8  -  DETALLE POR MODELO + TAREA', bCyan));
  out.push(line('=', 80));
  out.push('');

  if (report.byModelTask.length === 0) {
    out.push(dim('  Sin datos por combinacion modelo+tarea.'));
    out.push('');
    return out.join('\n');
  }

  const grouped = new Map<string, ModelTaskRow[]>();
  for (const row of report.byModelTask) {
    if (!grouped.has(row.model)) grouped.set(row.model, []);
    grouped.get(row.model)!.push(row);
  }

  for (const [model, rows] of grouped) {
    out.push(
      `  ${bold(modelColor(model))} ${dim('(familia: ' + familyColor(rows[0].modelFamily) + ')')}`,
    );
    out.push('');

    for (const row of rows) {
      const header = `    ${bold(taskTypeColor(row.taskType))} ${dim('| ' + row.totalSamples + ' muestras' + (row.baseline ? ' | baseline: ' + fmtInt(row.baseline.avgTokens) + ' tokens, ' + row.baseline.avgLatency + 's' : ' | sin baseline'))}`;
      out.push(header);

      const tableHeader = `      ${pad('Optimizador', 11)} ${pad('Muestras', 8)} ${pad('Tokens', 12)} ${pad('Latencia', 11)} ${pad('Calidad', 8)} ${pad('Ahorro %', 10)} ${pad('Ahorro $', 10)} ${pad('Veredicto', 12)}`;
      out.push(
        `      ${line('-', 11)} ${line('-', 8)} ${line('-', 12)} ${line('-', 11)} ${line('-', 8)} ${line('-', 10)} ${line('-', 10)} ${line('-', 12)}`,
      );

      for (const c of row.optimizers) {
        const parts = renderCell(c);
        out.push('      ' + parts.join(' '));
      }
      out.push('');
    }
  }

  return out.join('\n');
}

// ============================================================================
// Seccion 7: Ahorro global y veredicto
// ============================================================================

function section7GlobalSavings(report: RouterStatsReport): string {
  const out: string[] = [];
  out.push(title('  SECCION 6/8  -  AHORRO GLOBAL Y VEREDICTO', bCyan));
  out.push(line('=', 80));
  out.push('');

  const g = report.globalSavings;
  const savingsColor =
    g.weightedSavingsPercent >= 15
      ? bGreen
      : g.weightedSavingsPercent >= 5
        ? green
        : g.weightedSavingsPercent >= 0
          ? yellow
          : bRed;

  out.push(
    `  ${pad('Ahorro ponderado global', 32)} ${savingsColor(bold(pad(fmtPct(g.weightedSavingsPercent, true), 20)))}`,
  );
  out.push(
    `  ${pad('Tokens totales ahorrados', 32)} ${savingsColor(bold(pad(fmtInt(g.totalTokensSaved), 20)))}`,
  );
  out.push(
    `  ${pad('USD totales ahorrados', 32)} ${savingsColor(bold(pad(fmtUsd(g.totalUsdSaved), 20)))}`,
  );
  out.push('');
  out.push(`  ${line('-', 60)}`);
  out.push('');

  // Veredicto grande
  const verdictText = g.verdict;
  const verdictColor =
    g.weightedSavingsPercent >= 15
      ? bGreen
      : g.weightedSavingsPercent >= 5
        ? bYellow
        : g.weightedSavingsPercent >= 0
          ? bYellow
          : bRed;
  out.push('  ' + verdictColor(bold(verdictText)));
  out.push('');

  return out.join('\n');
}

// ============================================================================
// Seccion 8: Calibracion de confianza + recomendaciones
// ============================================================================

function section8Calibration(report: RouterStatsReport): string {
  const out: string[] = [];
  out.push(title('  SECCION 7/8  -  CALIBRACION DE CONFIANZA', bCyan));
  out.push(line('=', 80));
  out.push('');

  const cal = report.confidenceCalibration;
  const calColor =
    cal.calibrationScore >= 0.7 ? bGreen : cal.calibrationScore >= 0.4 ? bYellow : bRed;

  out.push(
    `  ${pad('Pares decision+ejecucion emparejados', 40)} ${bWhite(String(cal.pairsMatched))}`,
  );
  out.push(
    `  ${pad('Confianza media declarada', 40)} ${bBlue(cal.avgDeclaredConfidence.toFixed(3))}`,
  );
  out.push(`  ${pad('Calidad media real', 40)} ${qualityColor(cal.avgActualQuality)}`);
  out.push(
    `  ${pad('Tasa de fallo en alta confianza', 40)} ${failureRateColor(cal.failureRateHighConfidence)}`,
  );
  out.push(
    `  ${pad('Score de calibracion (0..1)', 40)} ${calColor(bold(cal.calibrationScore.toFixed(3)))}`,
  );
  out.push('');
  out.push(`  ${line('-', 60)}`);
  out.push('  ' + calColor(bold(cal.verdict)));
  out.push('');

  // Seccion 8/8: Recomendaciones accionables
  out.push(title('  SECCION 8/8  -  RECOMENDACIONES ACCIONABLES', bCyan));
  out.push(line('=', 80));
  out.push('');

  const recs: string[] = [];
  const s = report.summary;

  if (s.orphanDecisions > 0) {
    recs.push(
      bYellow('  ! ' + s.orphanDecisions + ' decisiones sin ejecucion asociada.') +
        ' ' +
        dim('Registrar el resultado con record_execution (MCP) o --record-execution (CLI).'),
    );
  }
  if (s.matchedDecisions === 0 && s.totalDecisions > 0) {
    recs.push(
      bRed('  ! Ninguna decision emparejada con ejecucion.') +
        ' ' +
        dim(
          'El router no puede aprender sin feedback. Usar --session-id al decidir y al registrar.',
        ),
    );
  }
  if (s.realCount < 10) {
    recs.push(
      bYellow('  ! Solo ' + s.realCount + ' ejecuciones reales.') +
        ' ' +
        dim(
          'Acumular al menos 10 por combinacion modelo+tarea+optimizador para tener estadisticas fiables.',
        ),
    );
  }
  if (s.syntheticCount > s.realCount * 10 && s.realCount > 0) {
    recs.push(
      bYellow(
        '  ! Proporcion sintetico/real muy alta (' + s.syntheticCount + '/' + s.realCount + ').',
      ) +
        ' ' +
        dim('Los datos sinteticos sirven para calibrar pero no miden valor real.'),
    );
  }
  if (s.uniqueModels.length > 0) {
    const realModels = report.byModel.filter((m) => m.executions > 0).length;
    if (realModels < s.uniqueModels.length) {
      recs.push(
        bYellow('  ! Solo ' + realModels + '/' + s.uniqueModels.length + ' modelos tienen datos.') +
          ' ' +
          dim('Probar el router con otros modelos para acumular evidencia.'),
      );
    }
  }
  // Recomendaciones por perdedores
  const losers = report.byModelTask.flatMap((row) =>
    row.optimizers.filter(
      (c) =>
        c.optimizer !== 'BASELINE' &&
        c.savingsPercent !== null &&
        c.savingsPercent < -5 &&
        c.samples >= 1,
    ),
  );
  if (losers.length > 0) {
    recs.push(
      bRed('  ! ' + losers.length + ' optimizadores empeoran frente a BASELINE.') +
        ' ' +
        dim('Revisar reglas en src/rules/base-rules.ts para las combinaciones afectadas.'),
    );
  }
  if (cal.calibrationScore > 0 && cal.calibrationScore < 0.4) {
    recs.push(
      bRed('  ! Confianza mal calibrada.') +
        ' ' +
        dim('El router sobreestima su certeza. Ajustar minConfidence en DEFAULT_ROUTER_OPTIONS.'),
    );
  }
  if (recs.length === 0) {
    recs.push(bGreen('  v Sistema saludable. Sin acciones criticas pendientes.'));
  }

  out.push(...recs);
  out.push('');
  out.push(bCyan('='.repeat(80)));
  out.push('');

  return out.join('\n');
}

// ============================================================================
// Mensaje cuando no hay datos
// ============================================================================

function renderEmptyReport(): string {
  const out: string[] = [];
  out.push('');
  out.push(bCyan('='.repeat(80)));
  out.push(bold(bCyan('  klia-token-optimizer  ')));
  out.push(bCyan('='.repeat(80)));
  out.push('');
  out.push(bYellow('  Aun no hay ejecuciones registradas.'));
  out.push('');
  out.push(dim('  El router esta usando las reglas base (V0).'));
  out.push(dim('  Ejecuta algunas tareas y registra los resultados con'));
  out.push(dim('  record_execution (MCP) o --record-execution (CLI)'));
  out.push(dim('  para acumular evidencia.'));
  out.push('');
  out.push(bCyan('='.repeat(80)));
  out.push('');
  return out.join('\n');
}

// ============================================================================
// API publica
// ============================================================================

export interface StatsDisplayOptions {
  model?: string;
  taskType?: TaskType;
  excludeSynthetic?: boolean;
  noColor?: boolean;
  eventsPath?: string;
}

export function renderStatsReport(opts: StatsDisplayOptions = {}): string {
  setColorEnabled(!opts.noColor);

  const eventsPath = opts.eventsPath ?? path.join(process.cwd(), '.router-history', 'events.json');
  const store = new RouterEventStore(eventsPath);
  let events = store.list();

  if (events.length === 0) {
    return renderEmptyReport();
  }

  if (opts.model) {
    events = events.filter((e) => e.model === opts.model);
  }
  if (opts.taskType) {
    events = events.filter((e) => e.taskType === opts.taskType);
  }
  if (opts.excludeSynthetic) {
    events = events.filter((e) => !e.synthetic);
  }

  if (events.length === 0) {
    return renderEmptyReport();
  }

  const report = buildStatsReport(events, DEFAULT_ROUTER_OPTIONS);

  if (report.summary.totalExecutions === 0 && report.summary.totalDecisions === 0) {
    return renderEmptyReport();
  }

  const sections: string[] = [];
  sections.push(sectionHeader());
  sections.push(section2Summary(report));
  sections.push(section3Health(report));
  sections.push(section4ByModel(report));
  sections.push(section5Heatmap(report));
  sections.push(section6ByModelTask(report));
  sections.push(section7GlobalSavings(report));
  sections.push(section8Calibration(report));

  return sections.join('\n');
}

// ============================================================================
// CLI entry point
// ============================================================================

export async function runStatsCli(argv: string[]): Promise<void> {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Uso: router stats [opciones]

Muestra un informe profesional del estado del router adaptativo con 8 secciones:
  1. Header con branding
  2. Resumen ejecutivo (KPIs)
  3. Salud del sistema
  4. Ranking de modelos
  5. Matriz modelo x tarea (heatmap)
  6. Detalle por modelo+tarea
  7. Ahorro global y veredicto
  8. Calibracion de confianza + recomendaciones

Opciones:
  --model <modelo>       Filtrar por modelo (ej: glm-5.2)
  --task <taskType>       Filtrar por tipo de tarea (SMALL_CODE, TERMINAL, ...)
  --real-only             Excluir datos sinteticos (solo ejecuciones reales)
  --no-color              Desactivar colores ANSI
  --events <path>        Ruta al events.json (default: .router-history/events.json)
  --help, -h              Mostrar esta ayuda

Ejemplos:
  router stats
  router stats --model glm-5.2
  router stats --task REFACTOR --real-only
  router stats --no-color
`);
    return;
  }

  const opts: StatsDisplayOptions = {};

  const modelFlag = args.indexOf('--model');
  if (modelFlag !== -1 && args[modelFlag + 1]) opts.model = args[modelFlag + 1];

  const taskFlag = args.indexOf('--task');
  if (taskFlag !== -1 && args[taskFlag + 1]) opts.taskType = args[taskFlag + 1] as TaskType;

  if (args.includes('--real-only')) opts.excludeSynthetic = true;
  if (args.includes('--no-color')) opts.noColor = true;

  const eventsFlag = args.indexOf('--events');
  if (eventsFlag !== -1 && args[eventsFlag + 1]) opts.eventsPath = args[eventsFlag + 1];

  const output = renderStatsReport(opts);
  console.log(output);
}

// Ejecutar si es el entry point
if (require.main === module) {
  runStatsCli(process.argv).catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
}
