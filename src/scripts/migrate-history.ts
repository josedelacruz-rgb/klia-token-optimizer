#!/usr/bin/env node
/**
 * Migra .router-history/history.json (v1 ExecutionRecord) a
 * .router-history/events.json (v2 RouterEvent).
 *
 * Marca como synthetic=true los registros que parezcan del benchmark o CLI.
 * Idempotente: si events.json ya está migrado, no hace nada.
 */
import * as fs from 'fs';
import * as path from 'path';
import { migrateMcpMetric, migrateV1ToV2 } from '../history/migrate';
import { RouterEventStore } from '../history/router-event-store';
import { readJsonSync } from '../utils/json';
import type { McpUsageMetricLike, RouterEvent } from '../types';

async function main() {
  const historyPath = path.resolve(process.cwd(), '.router-history', 'history.json');
  const eventsPath = path.resolve(process.cwd(), '.router-history', 'events.json');
  const metricsPath = path.resolve(process.cwd(), '.router-history', 'mcp-metrics.json');

  if (!fs.existsSync(historyPath)) {
    console.error(`No se encontro ${historyPath}`);
    process.exit(1);
  }

  // Si events.json ya tiene eventos v2, no hacer nada.
  const eventStore = new RouterEventStore(eventsPath);
  const existing = eventStore.list();
  if (existing.length > 0 && existing[0].schemaVersion === 2) {
    console.log(`events.json ya esta migrado (${existing.length} eventos). Nada que hacer.`);
    process.exit(0);
  }

  // Leer history.json (ExecutionRecord v1).
  const records = readJsonSync(historyPath) as Parameters<typeof migrateV1ToV2>[0];
  console.log(`Registros v1 en history.json: ${records.length}`);

  // Migrar a v2 con deteccion automatica de sinteticos.
  const recordEvents = migrateV1ToV2(records, { source: 'mcp' });

  // Migrar tambien las metricas MCP v1 (decisiones y ejecuciones) si existen,
  // para no perder las decisiones registradas en mcp-metrics.json.
  let metricEvents: RouterEvent[] = [];
  if (fs.existsSync(metricsPath)) {
    const metrics = readJsonSync(metricsPath) as McpUsageMetricLike[];
    metricEvents = metrics.map((m) => migrateMcpMetric(m, 'mcp'));
    console.log(`Metricas MCP v1 migradas: ${metricEvents.length}`);
  }

  const events = [...recordEvents, ...metricEvents];
  const synthetic = events.filter((e) => e.synthetic).length;
  const real = events.filter((e) => !e.synthetic).length;

  // Escribir events.json directamente (sobrescribe si existia).
  fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2), 'utf-8');

  console.log(`Eventos v2 escritos en events.json: ${events.length}`);
  console.log(`  Sinteticos detectados: ${synthetic}`);
  console.log(`  Reales: ${real}`);
  console.log('');
  console.log('Ahora puedes llamar a get_router_stats (format=v2) para ver el reporte enriquecido.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
