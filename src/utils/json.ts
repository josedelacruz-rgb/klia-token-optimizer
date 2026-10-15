import * as fs from 'fs';
import * as path from 'path';

/**
 * Garantiza que el directorio y el archivo JSON existan.
 *
 * Si el directorio no existe se crea (recursivo). Si el archivo no existe se
 * inicializa con un array vacio. Compartido por los stores de historial.
 */
export function ensureJsonFile(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify([], null, 2), 'utf-8');
  }
}

/**
 * Elimina el BOM (Byte Order Mark, U+FEFF) del inicio de un string.
 *
 * Algunos editores en Windows (notably PowerShell > Out-File, Notepad)
 * anaden un BOM UTF-8 (EF BB BF) al inicio de los archivos JSON.
 * JSON.parse falla con "Unexpected token '\uFEFF'" si el BOM esta presente.
 */
export function stripBom(text: string): string {
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
    return text.slice(1);
  }
  return text;
}

/**
 * Lee un archivo JSON de forma sincrona, eliminando BOM si existe.
 */
export function readJsonSync(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(stripBom(raw));
}

/**
 * Lee un archivo JSON de forma asincrona, eliminando BOM si existe.
 */
export async function readJsonAsync(filePath: string): Promise<unknown> {
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  return JSON.parse(stripBom(raw));
}
