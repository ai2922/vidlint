/**
 * The defect model — the contract between vidlint and whatever consumes it.
 *
 * A defect is deliberately *actionable*: it names a time range, carries the
 * measurements that triggered it, and suggests a fix. That shape is what lets
 * an agent loop on the report instead of guessing.
 */

/** @typedef {'error'|'warn'|'info'} Severity */

export const SEVERITY_RANK = { error: 0, warn: 1, info: 2 };

/**
 * @param {object} o
 * @param {string} o.id        stable machine id, e.g. `dead-air`
 * @param {Severity} o.severity
 * @param {string} o.title     short human label
 * @param {string} o.message   what was actually observed, with numbers
 * @param {number|null} [o.from] seconds
 * @param {number|null} [o.to]   seconds
 * @param {object} [o.evidence]
 * @param {string} [o.hint]    how to fix it
 */
export function defect(o) {
  return {
    id: o.id,
    severity: o.severity,
    title: o.title,
    message: o.message,
    from: o.from ?? null,
    to: o.to ?? null,
    evidence: o.evidence ?? {},
    hint: o.hint ?? null,
  };
}

/** `0:03.40` */
export function formatTime(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "--:--";
  const sign = seconds < 0 ? "-" : "";
  const s = Math.abs(seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${sign}${m}:${rest.toFixed(2).padStart(5, "0")}`;
}

/** `1.25s` */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "?";
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  return `${seconds.toFixed(2)}s`;
}

/**
 * Find maximal runs of consecutive items matching `predicate`.
 *
 * @template T
 * @param {T[]} items
 * @param {(item: T, index: number) => boolean} predicate
 * @returns {{startIndex:number,endIndex:number,items:T[]}[]}
 */
export function findRuns(items, predicate) {
  /** @type {{startIndex:number,endIndex:number,items:T[]}[]} */
  const runs = [];
  let current = null;
  for (let i = 0; i < items.length; i++) {
    if (predicate(items[i], i)) {
      if (!current) current = { startIndex: i, endIndex: i, items: [items[i]] };
      else {
        current.endIndex = i;
        current.items.push(items[i]);
      }
    } else if (current) {
      runs.push(current);
      current = null;
    }
  }
  if (current) runs.push(current);
  return runs;
}

/**
 * Sort worst-first, then by time.
 * @param {ReturnType<typeof defect>[]} defects
 */
export function sortDefects(defects) {
  return [...defects].sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    const at = a.from ?? -1;
    const bt = b.from ?? -1;
    if (at !== bt) return at - bt;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Count defects per severity.
 * @param {ReturnType<typeof defect>[]} defects
 */
export function countBySeverity(defects) {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const d of defects) counts[d.severity] = (counts[d.severity] ?? 0) + 1;
  return counts;
}
