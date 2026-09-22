/** Epoch-millisecond formatting helpers (all absolute labels are UTC). */

export function msToIso(ms: number, withMs = true): string {
  const d = new Date(ms);
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  const base = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
    + `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  return withMs ? `${base}.${p(d.getUTCMilliseconds(), 3)}Z` : `${base}Z`;
}

/** Value suitable for <input type="datetime-local" step=".001">. */
export function msToLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function localInputToMs(value: string): number {
  return new Date(value).getTime();
}

export function fmtRelative(ms: number, originMs: number): string {
  const delta = ms - originMs;
  const sign = delta < 0 ? "-" : "+";
  const abs = Math.abs(delta);
  const s = abs / 1000;
  if (abs < 1000) return `${sign}${abs} ms`;
  return `${sign}${s.toFixed(2)} s`;
}

/** "nice" tick step (ms) near the requested magnitude, 1/2/5 sequence. */
export function niceStep(rawMs: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(rawMs)));
  const n = rawMs / pow;
  let f: number;
  if (n < 1.5) f = 1;
  else if (n < 3.5) f = 2;
  else if (n < 7.5) f = 5;
  else f = 10;
  return f * pow;
}
