import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { withFileLock } from '../../src/utils/file-lock';

describe('withFileLock', () => {
  it('serializa escrituras concurrentes en el mismo archivo', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klia-lock-test-'));
    const file = path.join(tmpDir, 'store.json');
    fs.writeFileSync(file, '0', 'utf-8');

    const tasks = Array.from({ length: 10 }, () =>
      withFileLock(file, async () => {
        const value = parseInt(fs.readFileSync(file, 'utf-8'), 10);
        await new Promise((resolve) => setTimeout(resolve, 5));
        fs.writeFileSync(file, String(value + 1), 'utf-8');
      }),
    );

    await Promise.all(tasks);

    const final = parseInt(fs.readFileSync(file, 'utf-8'), 10);
    expect(final).toBe(10);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('libera el lock incluso si la funcion lanza error', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klia-lock-test-'));
    const file = path.join(tmpDir, 'store.json');

    await expect(
      withFileLock(file, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(fs.existsSync(`${file}.lock`)).toBe(false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
