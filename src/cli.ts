#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import {
  buildContextFromQuery,
  buildRecord,
  createAdaptiveRouter,
} from './index';
import { readJsonSync } from './utils/json';
import type { ExecutionRecord } from './types';

const args = process.argv.slice(2);

function printHelp() {
  console.log(`Uso:
  route --model <modelo> --query "<texto de la tarea>" [--files N] [--size N] [--history path] [--explore]
  route --record <json-file> [--history path]
  route --help

Ejemplos:
  route --model glm-5.2 --query "refactoriza el módulo de autenticación" --files 12 --size 180000
  route --model deepseek-v4 --query "ejecuta npm test y corrige los errores" --files 5 --size 50000
  route --model glm-5.2 --query "planifica migración" --history .router-history/benchmark.json
`);
}

async function main() {
  if (args.includes('--help') || args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const historyFlag = args.indexOf('--history');
  const historyPath =
    historyFlag !== -1
      ? args[historyFlag + 1]
      : path.join(process.cwd(), '.router-history', 'history.json');

  const historyDir = path.dirname(historyPath);
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }

  const explorationFlag = args.indexOf('--explore');
  const enableExploration = explorationFlag !== -1 ? true : false;
  const router = createAdaptiveRouter({ historyPath, enableExploration });

  if (args[0] === '--record') {
    const filePath = args[1];
    if (!filePath) {
      console.error('Falta el archivo JSON a registrar.');
      process.exit(1);
    }
    const record = readJsonSync(filePath) as ExecutionRecord;
    await router.recordExecution(record);
    console.log('Registro guardado.');
    return;
  }

  const modelIndex = args.indexOf('--model');
  const queryIndex = args.indexOf('--query');
  const filesIndex = args.indexOf('--files');
  const sizeIndex = args.indexOf('--size');

  if (modelIndex === -1 || queryIndex === -1) {
    console.error('Faltan --model o --query.');
    printHelp();
    process.exit(1);
  }

  const model = args[modelIndex + 1];
  const query = args[queryIndex + 1];
  const fileCount = filesIndex !== -1 ? parseInt(args[filesIndex + 1], 10) : 0;
  const contextSizeBytes = sizeIndex !== -1 ? parseInt(args[sizeIndex + 1], 10) : 0;

  const ctx = buildContextFromQuery(model, query, {
    fileCount,
    contextSizeBytes,
  });

  const decision = await router.route(ctx);
  console.log(JSON.stringify(decision, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
