/** @type {Readonly<Record<string, number>>} */
const UNITS = { ns: 0.000001, us: 0.001, µs: 0.001, μs: 0.001, ms: 1, s: 1000, m: 60000, h: 3600000 };

/**
 * Ollama keep_alive in milliseconds: a number is seconds, negative durations mean forever.
 * A string needs Go duration units, compounds allowed: Ollama's API parses it with time.ParseDuration,
 * which refuses a bare "600". Returns undefined for invalid values.
 * @param {unknown} value
 * @returns {number | undefined}
 */
export function parseKeepAlive(value) {
  let ms;
  if (typeof value === 'number') ms = value * 1000;
  else if (typeof value === 'string') {
    const parts = value.replace(/^[+-]/, '').match(/(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h)/g);
    if (!parts || parts.join('') !== value.replace(/^[+-]/, '')) return undefined;
    ms = parts.reduce((total, part) => {
      const unit = part.replace(/^[\d.]+/, '');
      return total + Number.parseFloat(part) * UNITS[unit];
    }, 0);
    if (value.startsWith('-')) ms = -ms;
  } else return undefined;
  if (!Number.isFinite(ms)) return undefined;
  return ms < 0 ? Infinity : ms || 0;
}
