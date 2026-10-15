import * as fs from 'fs';

/**
 * Logger simple en formato NDJSON (una linea JSON por entrada).
 *
 * Se usa append en lugar de read-modify-write: el enfoque anterior no era
 * atomico (podia corromper el archivo con llamadas concurrentes) y cargaba
 * todo el historial en memoria en cada escritura.
 */
export interface Logger {
  log(level: string, message: string, meta?: Record<string, unknown>): void;
}

export function createLogger(logPath: string): Logger {
  return {
    log(level: string, message: string, meta?: Record<string, unknown>) {
      const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        meta,
      };
      try {
        fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
      } catch (err) {
        console.error('[klia-token-optimizer log error]', err);
      }
    },
  };
}
