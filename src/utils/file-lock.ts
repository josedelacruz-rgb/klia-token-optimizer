import * as fs from 'fs';
import * as path from 'path';

export interface FileLockOptions {
  retries?: number;
  retryDelayMs?: number;
  staleMs?: number;
}

/**
 * Mutex inter-proceso simple basado en un archivo lock.
 *
 * Usa fs.openSync con O_EXCL para crear el lock atomico. Si el lock es antiguo
 * (stale), se elimina automaticamente para evitar bloqueos permanentes tras
 * un crash del proceso.
 */
export class FileLock {
  private lockPath: string;
  private options: Required<FileLockOptions>;
  private fd: number | null = null;

  constructor(filePath: string, opts: FileLockOptions = {}) {
    this.lockPath = `${filePath}.lock`;
    this.options = {
      retries: opts.retries ?? 100,
      retryDelayMs: opts.retryDelayMs ?? 50,
      // 30s: suficientemente alto para no robar el lock de un escritor lento
      // legitimo, y suficientemente bajo para recuperarse de un crash.
      staleMs: opts.staleMs ?? 30_000,
    };
  }

  async acquire(): Promise<void> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < this.options.retries; attempt++) {
      this.removeStaleLock();
      try {
        this.fd = fs.openSync(this.lockPath, 'wx');
        fs.writeSync(this.fd, `${Date.now()}\n`, undefined, 'utf-8');
        return;
      } catch (err) {
        lastError = err as Error;
        await delay(this.options.retryDelayMs);
      }
    }
    throw new Error(`No se pudo adquirir el lock ${this.lockPath}: ${lastError?.message}`);
  }

  release(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignorar
      }
      this.fd = null;
    }
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      // ignorar si ya no existe
    }
  }

  private removeStaleLock(): void {
    try {
      const stat = fs.statSync(this.lockPath);
      if (Date.now() - stat.mtimeMs > this.options.staleMs) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // no existe u otro error: no hacer nada
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ejecuta una funcion dentro de un lock inter-proceso.
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  opts?: FileLockOptions,
): Promise<T> {
  const lock = new FileLock(filePath, opts);
  await lock.acquire();
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
