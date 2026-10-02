/**
 * Layout checks driven by the spatial pass: content running into the frame
 * edge, and content sitting where a platform will draw its own UI on top.
 *
 * Both are *heuristic*. They detect structure (high-contrast detail) in regions
 * where structure is suspicious. They deliberately do not claim to identify
 * text — they point at a region and a timecode so a human or an agent can look.
 */

import { defect, findRuns, formatDuration, formatTime } from "../defects.mjs";

const SIDE_LABELS = {
  top: "top",
  bottom: "bottom",
  left: "left",
  right: "right",
};

/**
 * Structure sitting in the outermost sliver of the frame — the classic shape of
 * text or a graphic that has been clipped by the composition bounds.
 *
 * @param {import('../analyze.mjs').SpatialSample[]} samples
 * @param {any} config
 */
export function checkEdgeClipping(samples, config) {
  const defects = [];

  for (const side of /** @type {const} */ (["top", "bottom", "left", "right"])) {
    const runs = findRuns(
      samples,
      (s) =>
        s.edgeRatio[side] > config.edgeRatio &&
        // Only meaningful when the edge is busier than the frame's own baseline;
        // otherwise this is just full-bleed texture reaching the border.
        s.edgeRatio[side] > (s.structureRatio ?? 0) * config.structureContrastFactor,
    );
    for (const run of runs) {
      if (run.items.length < config.layoutMinFrames) continue;

      const from = run.items[0].time;
      const to = run.items[run.items.length - 1].time + 1 / config.spatialFps;
      const peak = run.items.reduce((a, s) => Math.max(a, s.edgeRatio[side]), 0);

      defects.push(
        defect({
          id: "edge-clipping",
          severity: "info",
          title: `Content at the ${SIDE_LABELS[side]} edge`,
          message:
            `${(peak * 100).toFixed(1)}% of the ${SIDE_LABELS[side]} border contains high-contrast detail ` +
            `from ${formatTime(from)} to ${formatTime(to)}. It may be clipped.`,
          from,
          to,
          evidence: {
            side,
            peakRatio: round(peak, 4),
            threshold: config.edgeRatio,
            durationSeconds: round(to - from, 3),
          },
          hint:
            "Open this timestamp and check nothing is cut off. Text or graphics that reach the very edge of the frame " +
            "are usually a sizing bug; keep important content inside the safe area.",
        }),
      );
    }
  }

  return defects;
}

/**
 * Structure inside the region a platform covers with its own UI.
 *
 * Unlike edge clipping this is not really a heuristic about intent: if content
 * is in the bottom 17% of a Reel, the platform *will* draw over it.
 *
 * @param {import('../analyze.mjs').SpatialSample[]} samples
 * @param {any} config
 * @param {{width:number,height:number}} frameSize analysis-frame size
 * @param {{width:number,height:number}} displaySize real composition size
 */
export function checkSafeArea(samples, config, frameSize, displaySize) {
  const defects = [];

  const active = Object.entries(config.safeArea ?? {}).filter(([, v]) => v > 0);
  if (active.length === 0) return defects;

  const platformLabel = config.platform && config.platform !== "none" ? config.platform : "custom";

  for (const side of /** @type {const} */ (["top", "bottom", "left", "right"])) {
    if (!(config.safeArea[side] > 0)) continue;

    const runs = findRuns(
      samples,
      (s) =>
        s.safeRatio[side] > config.safeAreaRatio &&
        // Same guard as edge clipping: a full-bleed background under the UI is
        // normal and expected. A distinct element there is the problem.
        s.safeRatio[side] > (s.structureRatio ?? 0) * config.structureContrastFactor,
    );
    for (const run of runs) {
      if (run.items.length < config.layoutMinFrames) continue;

      const from = run.items[0].time;
      const to = run.items[run.items.length - 1].time + 1 / config.spatialFps;
      const peak = run.items.reduce((a, s) => Math.max(a, s.safeRatio[side]), 0);

      // Report the offending region in real composition pixels, which is what
      // a person needs in order to go and fix the layout.
      const box = run.items.map((s) => s.safeBoxes[side]).find(Boolean) ?? null;
      const scaleX = frameSize.width > 0 ? displaySize.width / frameSize.width : 1;
      const scaleY = frameSize.height > 0 ? displaySize.height / frameSize.height : 1;
      const compositionBox = box
        ? {
            x: Math.round(box.x * scaleX),
            y: Math.round(box.y * scaleY),
            width: Math.round((box.x2 - box.x) * scaleX),
            height: Math.round((box.y2 - box.y) * scaleY),
          }
        : null;

      defects.push(
        defect({
          id: "safe-area",
          severity: "warn",
          title: `Content under the ${platformLabel} ${SIDE_LABELS[side]} overlay`,
          message:
            `Detail appears in the ${SIDE_LABELS[side]} ${(config.safeArea[side] * 100).toFixed(0)}% of the frame ` +
            `(${formatTime(from)} to ${formatTime(to)}), which the ${platformLabel} UI covers.`,
          from,
          to,
          evidence: {
            side,
            platform: platformLabel,
            insetFraction: config.safeArea[side],
            peakRatio: round(peak, 4),
            threshold: config.safeAreaRatio,
            compositionBox,
          },
          hint:
            "Move this content inside the safe area. Platform chrome (captions, buttons, the progress bar) is drawn on top of your video " +
            "and will hide it. Note that safe areas are not formally published by the platforms — treat the preset as a starting point and verify on a real device.",
        }),
      );
    }
  }

  return defects;
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
