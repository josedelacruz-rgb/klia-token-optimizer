#!/usr/bin/env node
/**
 * CLI legacy. Se mantiene solo por compatibilidad: delega en router-cli.ts,
 * que es el CLI unificado (`npm run router`).
 *
 * Historicamente exponía `--record <archivo.json>`; ese flujo se cubre ahora
 * con `--record-execution` de router-cli.ts.
 */
import { runRouterCli } from './router-cli';

console.warn('Aviso: `route` (cli.ts) es legacy; se delega en router-cli.ts (`npm run router`).');

runRouterCli(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
