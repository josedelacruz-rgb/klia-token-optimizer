#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { buildContextFromQuery, buildRecord, createAdaptiveRouter } from '../index';
import { discoverModels, detectKliaApiKey } from '../klia-discovery';
import type { TaskType } from '../types';

/**
 * Genera registros BASELINE iniciales para cada modelo y tipo de tarea.
 *
 * A diferencia de la version anterior, NO usa matrices de costes sinteticos.
 * Solo crea registros BASELINE para que el router arranque en V0/V1 y aprenda
 * con ejecuciones reales via record_execution.
 *
 * Si hay KLIA_API_KEY disponible, descubre los modelos dinamicamente desde la API.
 * Si no, usa el snapshot estatico.
 */

const TASK_CONFIG: Record<
  string,
  {
    query: string;
    fileCount: number;
    contextSizeBytes: number;
    taskType: TaskType;
  }
> = {
  small: {
    query: 'corrige un typo en index.ts',
    fileCount: 1,
    contextSizeBytes: 5000,
    taskType: 'SMALL_CODE',
  },
  terminal: {
    query: 'ejecuta npm test y analiza los errores',
    fileCount: 5,
    contextSizeBytes: 80000,
    taskType: 'TERMINAL',
  },
  large: {
    query: 'revisa toda la documentacion del proyecto',
    fileCount: 3,
    contextSizeBytes: 2 * 1024 * 1024,
    taskType: 'LARGE_CONTEXT',
  },
  search: {
    query: 'encuentra todas las llamadas a login en el repo',
    fileCount: 25,
    contextSizeBytes: 300000,
    taskType: 'REPOSITORY_SEARCH',
  },
  multistep: {
    query: 'planifica migracion en 5 pasos',
    fileCount: 8,
    contextSizeBytes: 200000,
    taskType: 'MULTISTEP',
  },
  refactor: {
    query: 'refactoriza el modulo de autenticacion',
    fileCount: 12,
    contextSizeBytes: 250000,
    taskType: 'REFACTOR',
  },
};

const BASELINE_TOKENS: Record<string, number> = {
  small: 3000,
  terminal: 8000,
  large: 25000,
  search: 15000,
  multistep: 12000,
  refactor: 14000,
};

const BASELINE_LATENCY: Record<string, number> = {
  small: 20,
  terminal: 60,
  large: 180,
  search: 120,
  multistep: 100,
  refactor: 110,
};

interface CalibrationOptions {
  historyPath: string;
  repetitions: number;
  models?: string[];
  tasks?: string[];
  apiKey?: string;
}

export async function runCalibration(options: CalibrationOptions) {
  const router = createAdaptiveRouter({
    historyPath: options.historyPath,
    enableExploration: false,
  });

  let models: string[];

  if (options.models && options.models.length > 0) {
    // Modelos pasados por linea de comandos
    models = options.models;
    console.log(`Usando ${models.length} modelos proporcionados manualmente`);
  } else {
    // Descubrimiento dinamico desde la API de KLIA
    const apiKey = options.apiKey ?? detectKliaApiKey() ?? undefined;
    console.log('Descubriendo modelos desde KLIA...');
    const result = await discoverModels(apiKey);

    if (result.source === 'api') {
      console.log(`API de KLIA: ${result.models.length} modelos de chat descubiertos`);
    } else {
      console.log(`Usando snapshot estatico: ${result.models.length} modelos`);
      if (result.error) {
        console.log(`Razon: ${result.error}`);
      }
    }

    models = result.models.map((m) => m.id);
  }

  const tasks = (options.tasks ?? Object.keys(TASK_CONFIG)) as string[];
  const repetitions = options.repetitions;

  let added = 0;

  for (const model of models) {
    for (const taskKey of tasks) {
      const config = TASK_CONFIG[taskKey];
      if (!config) continue;

      const ctx = buildContextFromQuery(model, config.query, {
        fileCount: config.fileCount,
        contextSizeBytes: config.contextSizeBytes,
        isMultistep: config.taskType === 'MULTISTEP',
        isRefactor: config.taskType === 'REFACTOR',
        isRepositorySearch: config.taskType === 'REPOSITORY_SEARCH',
        hasTerminalCommands: config.taskType === 'TERMINAL',
        toolCallsExpected:
          config.taskType === 'TERMINAL' || config.taskType === 'MULTISTEP'
            ? 'high'
            : config.taskType === 'LARGE_CONTEXT'
              ? 'medium'
              : 'low',
      });

      // Generar solo registros BASELINE
      const baseTokens = BASELINE_TOKENS[taskKey];
      const baseLatency = BASELINE_LATENCY[taskKey];

      for (let i = 0; i < repetitions; i++) {
        const tokens = Math.round(baseTokens * (0.95 + Math.random() * 0.1));
        const latency = Math.round(baseLatency * (0.9 + Math.random() * 0.2));

        const record = buildRecord(ctx, 'BASELINE', {
          tokens,
          latencySeconds: latency,
          toolingCost: 0,
          quality: 0.95 + Math.random() * 0.04,
          failed: false,
        });
        await router.recordExecution(record);
        added++;
      }

      console.log(`Calibrado ${model}/${config.taskType}: ${repetitions} registros BASELINE`);
    }
  }

  console.log(`\nTotal de registros anadidos: ${added}`);
  console.log(`Historico guardado en: ${options.historyPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const historyPathFlag = args.indexOf('--history');
  const repetitionsFlag = args.indexOf('--repetitions');
  const modelsFlag = args.indexOf('--models');
  const tasksFlag = args.indexOf('--tasks');
  const apiKeyFlag = args.indexOf('--api-key');

  const historyPath =
    historyPathFlag !== -1
      ? args[historyPathFlag + 1]
      : path.join(process.cwd(), '.router-history', 'history.json');

  const repetitions = repetitionsFlag !== -1 ? parseInt(args[repetitionsFlag + 1], 10) : 3;

  const models = modelsFlag !== -1 ? args[modelsFlag + 1].split(',') : undefined;
  const tasks = tasksFlag !== -1 ? args[tasksFlag + 1].split(',') : undefined;
  const apiKey = apiKeyFlag !== -1 ? args[apiKeyFlag + 1] : undefined;

  // Si el historico existe, lo borramos para empezar desde cero.
  if (fs.existsSync(historyPath)) {
    fs.rmSync(historyPath);
    console.log(`Historico anterior eliminado: ${historyPath}`);
  }

  await runCalibration({ historyPath, repetitions, models, tasks, apiKey });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
