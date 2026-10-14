// Utilidades de fechas.

/**
 * Convierte "DD/MM/YYYY" en un objeto Date (UTC, medianoche).
 */
export function parseSpanishDate(text) {
  const [day, month, year] = text.split('/').map(Number);
  return new Date(Date.UTC(year, month, day));
}

/**
 * Devuelve "YYYY-MM-DD" para un Date en UTC.
 */
export function toIsoDay(date) {
  return date.toISOString().slice(0, 10);
}
