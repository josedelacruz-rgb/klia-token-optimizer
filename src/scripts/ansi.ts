/**
 * Helpers de color ANSI con estado centralizado.
 *
 * Se aislan aqui para que la presentacion (stats-display) no mantenga estado
 * global mutable: el flag `colorEnabled` se controla con `setColorEnabled`.
 */

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  // Colores de texto
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  // Colores brillantes
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
  // Fondos
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
  bgBrightGreen: '\x1b[102m',
  bgBrightYellow: '\x1b[103m',
  bgBrightRed: '\x1b[101m',
};

let colorEnabled = true;

/** Activa o desactiva los codigos ANSI globalmente. */
export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

function wrap(code: string, text: string): string {
  return colorEnabled ? `${code}${text}${C.reset}` : text;
}

// Helpers de color
export const bold = (t: string) => wrap(C.bold, t);
export const dim = (t: string) => wrap(C.dim, t);
export const red = (t: string) => wrap(C.red, t);
export const green = (t: string) => wrap(C.green, t);
export const yellow = (t: string) => wrap(C.yellow, t);
export const blue = (t: string) => wrap(C.blue, t);
export const magenta = (t: string) => wrap(C.magenta, t);
export const cyan = (t: string) => wrap(C.cyan, t);
export const white = (t: string) => wrap(C.white, t);
export const bRed = (t: string) => wrap(C.brightRed, t);
export const bGreen = (t: string) => wrap(C.brightGreen, t);
export const bYellow = (t: string) => wrap(C.brightYellow, t);
export const bBlue = (t: string) => wrap(C.brightBlue, t);
export const bMagenta = (t: string) => wrap(C.brightMagenta, t);
export const bCyan = (t: string) => wrap(C.brightCyan, t);
export const bWhite = (t: string) => wrap(C.brightWhite, t);
export const bgGreen = (t: string) => wrap(C.bgGreen, t);
export const bgYellow = (t: string) => wrap(C.bgYellow, t);
export const bgRed = (t: string) => wrap(C.bgRed, t);
