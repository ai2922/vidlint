/**
 * The frame analyser.
 *
 * One pass over the greyscale frame stream produces, per frame:
 *
 *   mean / min / max / stdDev  -> exposure, blank detection
 *   motion                     -> dead air, pacing, scene changes
 *   edge energy per border     -> content clipped at the frame edge
 *   unsafe-area content boxes  -> platform UI / title-safe violations
 *
 * Everything downstream is a pure function of this accumulated series, which
 * keeps the checks easy to test without touching ffmpeg.
 */

const BORDER_KEYS = /** @type {const} */ (["top", "bottom", "left", "right"]);

/**
 * @typedef {object} FrameMetrics
 * @property {number} index
 * @property {number} time        seconds
 * @property {number} mean        0..255
 * @property {number} min
 * @property {number} max
 * @property {number} stdDev
 * @property {number} motion      0..1, mean abs difference vs previous frame
 * @property {{top:number,bottom:number,left:number,right:number}} edge  fraction of strong gradients in each border band
 */

/**
 * Analyse a greyscale frame and mutate a reusable metrics object.
 *
 * @param {Uint8Array} frame
 * @param {Uint8Array|null} prev
 * @param {number} width
 * @param {number} height
 * @returns {{ mean:number,min:number,max:number,stdDev:number,motion:number,edge:{top:number,bottom:number,left:number,right:number} }}
 */
export function measureFrame(frame, prev, width, height) {
  const n = width * height;

  let sum = 0;
  let sumSq = 0;
  let linearSum = 0;
  let min = 255;
  let max = 0;

  for (let i = 0; i < n; i++) {
    const v = frame[i];
    sum += v;
    sumSq += v * v;
    linearSum += LINEAR_LUT[v];
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const mean = sum / n;
  // Clamp at 0: floating point can push a zero-variance frame slightly negative.
  const variance = Math.max(0, sumSq / n - mean * mean);

  let motion = 0;
  let changed = 0;
  let flashArea = 0;

  if (prev) {
    // WCAG's flash *area* test is "25% of any 10-degree visual field", not 25%
    // of the whole frame. A 10-degree field is roughly a third of the frame in
    // each axis, so we bucket the diff into 3x3 cells and take the largest cell
    // fraction. Comparing against the whole frame instead would be ~9x too
    // strict and would miss real strobe effects confined to one region.
    const CELLS = 3;
    const cellChanged = new Int32Array(CELLS * CELLS);
    const cellTotal = new Int32Array(CELLS * CELLS);

    let diff = 0;
    let changedCount = 0;

    for (let y = 0; y < height; y++) {
      const cellRowBase = Math.min(CELLS - 1, ((y * CELLS) / height) | 0) * CELLS;
      const rowBase = y * width;
      for (let x = 0; x < width; x++) {
        const i = rowBase + x;
        const d = frame[i] - prev[i];
        const ad = d < 0 ? -d : d;
        diff += ad;

        const cell = cellRowBase + Math.min(CELLS - 1, ((x * CELLS) / width) | 0);
        cellTotal[cell]++;
        if (ad >= CHANGE_THRESHOLD) {
          changedCount++;
          cellChanged[cell]++;
        }
      }
    }

    motion = diff / n / 255;
    changed = changedCount / n;

    for (let c = 0; c < cellChanged.length; c++) {
      const fraction = cellTotal[c] > 0 ? cellChanged[c] / cellTotal[c] : 0;
      if (fraction > flashArea) flashArea = fraction;
    }
  }

  return {
    mean,
    min,
    max,
    stdDev: Math.sqrt(variance),
    linearMean: linearSum / n,
    motion,
    changed,
    flashArea,
    edge: measureBorders(frame, width, height),
  };
}

/** A gradient at least this steep counts as "structured content" (text, an edge). */
const GRADIENT_THRESHOLD = 24;

/**
 * A pixel must move at least this much (0..255) to count as "changed" between
 * two frames. Feeds the WCAG flash area calculation.
 */
const CHANGE_THRESHOLD = 26;

/**
 * sRGB -> linear relative luminance lookup.
 *
 * WCAG flash thresholds are defined against *relative luminance*, not the
 * gamma-encoded byte a decoder hands us. A 256-entry table turns that
 * conversion into an array index, which matters when we do it tens of millions
 * of times per file.
 */
const LINEAR_LUT = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR_LUT[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Fraction of pixels in each border band that sit on a strong edge.
 *
 * Text or a graphic clipped by the frame edge produces high-frequency structure
 * in the outermost pixels; a clean background does not.
 *
 * @param {Uint8Array} frame
 * @param {number} width
 * @param {number} height
 */
function measureBorders(frame, width, height) {
  const band = Math.max(2, Math.round(Math.min(width, height) * 0.02));
  const counts = { top: 0, bottom: 0, left: 0, right: 0 };
  const totals = { top: 0, bottom: 0, left: 0, right: 0 };

  const at = (x, y) => frame[y * width + x];

  for (let y = 0; y < height; y++) {
    const inTop = y < band;
    const inBottom = y >= height - band;
    for (let x = 0; x < width; x++) {
      const inLeft = x < band;
      const inRight = x >= width - band;
      if (!inTop && !inBottom && !inLeft && !inRight) continue;

      // Central difference, clamped at the edges.
      const x0 = x > 0 ? x - 1 : x;
      const x1 = x < width - 1 ? x + 1 : x;
      const y0 = y > 0 ? y - 1 : y;
      const y1 = y < height - 1 ? y + 1 : y;
      const gx = at(x1, y) - at(x0, y);
      const gy = at(x, y1) - at(x, y0);
      const strong = Math.abs(gx) >= GRADIENT_THRESHOLD || Math.abs(gy) >= GRADIENT_THRESHOLD;

      if (inTop) { totals.top++; if (strong) counts.top++; }
      if (inBottom) { totals.bottom++; if (strong) counts.bottom++; }
      if (inLeft) { totals.left++; if (strong) counts.left++; }
      if (inRight) { totals.right++; if (strong) counts.right++; }
    }
  }

  /** @type {any} */
  const out = {};
  for (const k of BORDER_KEYS) {
    out[k] = totals[k] === 0 ? 0 : counts[k] / totals[k];
  }
  return out;
}

/**
 * Scan a rectangular region and report the fraction of pixels sitting on a
 * strong edge, plus the bounding box of that structure.
 *
 * Used for safe-area violations: we only care that *something* with detail
 * lives inside the region, and where.
 *
 * @param {Uint8Array} frame
 * @param {number} width
 * @param {number} height
 * @param {{x:number,y:number,w:number,h:number}} region
 */
export function measureRegionStructure(frame, width, height, region) {
  const { x: rx, y: ry, w: rw, h: rh } = region;
  const xEnd = Math.min(width, rx + rw);
  const yEnd = Math.min(height, ry + rh);
  const xStart = Math.max(0, Math.min(rx, width - 1));
  const yStart = Math.max(0, Math.min(ry, height - 1));

  const at = (x, y) => frame[y * width + x];

  let strongCount = 0;
  let total = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      total++;
      const x0 = x > 0 ? x - 1 : x;
      const x1 = x < width - 1 ? x + 1 : x;
      const y0 = y > 0 ? y - 1 : y;
      const y1 = y < height - 1 ? y + 1 : y;
      const gx = at(x1, y) - at(x0, y);
      const gy = at(x, y1) - at(x, y0);
      if (Math.abs(gx) >= GRADIENT_THRESHOLD || Math.abs(gy) >= GRADIENT_THRESHOLD) {
        strongCount++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  return {
    total,
    strong: strongCount,
    ratio: total === 0 ? 0 : strongCount / total,
    box: strongCount === 0 ? null : { x: minX, y: minY, x2: maxX, y2: maxY },
  };
}

export { BORDER_KEYS };
