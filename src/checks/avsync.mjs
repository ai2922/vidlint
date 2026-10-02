/**
 * The audio-visual join.
 *
 * This is the rule set that makes vidlint more than a pile of ffmpeg detectors.
 *
 * A frozen picture means two completely different things depending on what the
 * audio is doing at that moment:
 *
 *   picture frozen + audio talking  -> the render stalled. The viewer sees a
 *                                      dead frame while narration keeps going.
 *                                      Always a bug. Reported as `error`.
 *   picture frozen + silence        -> a deliberate held beat. Often fine.
 *                                      Reported as `info`.
 *
 * `freezedetect` and `silencedetect` each see half of this. Correlating them is
 * the whole point.
 */

/**
 * @typedef {{start:number,end:number}} Interval
 */

/**
 * Complement of the silent intervals within `[0, duration]` — i.e. when there
 * is actually something to hear.
 *
 * @param {Interval[]} silenceIntervals
 * @param {number} duration
 * @returns {Interval[]}
 */
export function buildSpeechIntervals(silenceIntervals, duration) {
  if (!(duration > 0)) return [];
  const sorted = [...silenceIntervals]
    .map((i) => ({ start: Math.max(0, i.start), end: Math.min(duration, i.end) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);

  /** @type {Interval[]} */
  const speech = [];
  let cursor = 0;

  for (const s of sorted) {
    if (s.start > cursor) speech.push({ start: cursor, end: s.start });
    if (s.end > cursor) cursor = s.end;
  }
  if (cursor < duration) speech.push({ start: cursor, end: duration });

  return speech;
}

/**
 * Seconds of `run` covered by `intervals`.
 *
 * @param {Interval} run
 * @param {Interval[]} intervals
 */
export function totalOverlap(run, intervals) {
  let total = 0;
  for (const i of intervals) {
    const start = Math.max(run.start, i.start);
    const end = Math.min(run.end, i.end);
    if (end > start) total += end - start;
  }
  return total;
}

/**
 * @typedef {object} FreezeAudioContext
 * @property {'speech'|'mixed'|'silence'|'unknown'} kind
 * @property {number|null} speechFraction 0..1, null when audio was unavailable
 */

/**
 * Decide what was happening on the audio track during a frozen picture.
 *
 * @param {{from:number,to:number,duration:number}} run
 * @param {Interval[]|null} speechIntervals null when there is no audio at all
 * @returns {FreezeAudioContext}
 */
export function classifyFreezeAudio(run, speechIntervals) {
  if (!speechIntervals) return { kind: "unknown", speechFraction: null };

  const overlap = totalOverlap({ start: run.from, end: run.to }, speechIntervals);
  const fraction = run.duration > 0 ? overlap / run.duration : 0;

  if (fraction >= 0.5) return { kind: "speech", speechFraction: fraction };
  if (fraction > 0.05) return { kind: "mixed", speechFraction: fraction };
  return { kind: "silence", speechFraction: fraction };
}
