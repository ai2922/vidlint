/**
 * Visual artefacts: still extraction and contact sheets.
 *
 * A defect report that names a timestamp is useful; one that also *shows* the
 * frame is what actually lets a human (or a vision model) confirm the finding.
 * Both are produced by ffmpeg, so no image library is needed.
 */

import { ffmpegPath, runCaptureBuffer } from "./ffmpeg.mjs";
import { VidlintError } from "./errors.mjs";

/**
 * Extract a single frame as a PNG buffer.
 *
 * Seeks with `-ss` *before* `-i`, which lets ffmpeg jump to the nearest
 * keyframe instead of decoding the whole file.
 *
 * @param {string} input
 * @param {number} time seconds
 * @param {number} width output width, aspect preserved
 * @returns {Promise<Buffer|null>}
 */
export async function extractFramePng(input, time, width = 480) {
  const { stdout, code } = await runCaptureBuffer(ffmpegPath(), [
    "-v", "error",
    "-nostdin",
    "-ss", Math.max(0, time).toFixed(3),
    "-i", input,
    "-frames:v", "1",
    "-vf", `scale=${Math.round(width)}:-2`,
    "-f", "image2pipe",
    "-vcodec", "png",
    "-",
  ]);

  if (code !== 0 || stdout.length === 0) return null;
  return stdout;
}

/**
 * Pick a spread of timestamps that both covers the timeline and lands on the
 * interesting moments.
 *
 * @param {number} duration
 * @param {{from:number|null}[]} defects
 * @param {number} max
 */
export function selectSampleTimes(duration, defects, max = 12) {
  /** @type {number[]} */
  const times = [];

  for (const d of defects) {
    if (d.from !== null && d.from !== undefined) times.push(d.from);
  }

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 1;
  // Always include the head and tail, plus an even spread.
  for (let i = 0; i < max; i++) {
    times.push((safeDuration * i) / Math.max(1, max - 1));
  }

  const sorted = [...new Set(times.map((t) => Math.max(0, Math.min(safeDuration, t))))].sort(
    (a, b) => a - b,
  );

  if (sorted.length <= max) return sorted;

  // Keep the earliest samples (which correlate with defect onsets) and thin the
  // even spread so the total stays within budget.
  const picked = [];
  const stride = sorted.length / max;
  for (let i = 0; i < max; i++) picked.push(sorted[Math.floor(i * stride)]);
  return [...new Set(picked)];
}

/**
 * Build a contact sheet of `columns x rows` stills across the video.
 *
 * @param {object} o
 * @param {string} o.input
 * @param {string} o.outputPath
 * @param {number} o.duration
 * @param {number} [o.columns]
 * @param {number} [o.rows]
 * @param {number} [o.thumbWidth]
 */
export async function buildContactSheet({
  input,
  outputPath,
  duration,
  columns = 4,
  rows = 4,
  thumbWidth = 320,
}) {
  const count = columns * rows;
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 1;
  const fps = count / safeDuration;

  const { code, stderr } = await runCaptureBuffer(ffmpegPath(), [
    "-v", "error",
    "-y",
    "-nostdin",
    "-i", input,
    "-vf", `fps=${fps.toFixed(6)},scale=${thumbWidth}:-2,tile=${columns}x${rows}`,
    "-frames:v", "1",
    outputPath,
  ]);

  if (code !== 0) {
    throw new VidlintError(
      `Could not build the contact sheet.\n${stderr.trim()}`,
      "CONTACT_SHEET_FAILED",
    );
  }

  return { outputPath, columns, rows, count };
}
