/**
 * Frame collection.
 *
 * Two passes over the same file, each tuned for what it needs:
 *
 *   temporal — high frame rate, tiny resolution. Feeds blank / freeze / flash /
 *              pacing, which are all about *time*.
 *   spatial  — low frame rate, higher resolution. Feeds edge clipping and
 *              safe-area, which are all about *where things are*.
 *
 * Neither pass keeps decoded pixels around: only scalars survive. A 10-minute
 * 4K file therefore costs a few MB of heap, not gigabytes.
 */

import { streamGrayFrames } from "./ffmpeg.mjs";
import { measureFrame, measureRegionStructure } from "./frames.mjs";

/** Thickness of the outermost band used for edge-clipping detection. */
const EDGE_BAND_FRACTION = 0.015;

/**
 * Scale a source size down to `targetWidth`, preserving aspect ratio, with a
 * floor so that absurdly wide or short inputs still produce a usable raster.
 *
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} targetWidth
 */
export function fitWidth(srcW, srcH, targetWidth) {
  const width = Math.max(16, Math.round(targetWidth));
  const safeSrcW = srcW > 0 ? srcW : 16;
  const safeSrcH = srcH > 0 ? srcH : 9;
  const height = Math.max(2, Math.round((safeSrcH / safeSrcW) * width));
  return { width, height };
}

/**
 * @typedef {object} TemporalSample
 * @property {number} index
 * @property {number} time
 * @property {number} mean
 * @property {number} min
 * @property {number} max
 * @property {number} stdDev
 * @property {number} linearMean
 * @property {number} motion
 * @property {number} changed
 * @property {number} flashArea
 * @property {{top:number,bottom:number,left:number,right:number}} edge
 */

/**
 * @param {object} o
 * @param {string} o.input
 * @param {{temporalFps:number,temporalWidth:number,maxSamples:number}} o.config
 * @param {{width:number,height:number}} o.displaySize
 * @param {AbortSignal} [o.signal]
 * @param {(done:number)=>void} [o.onProgress]
 * @returns {Promise<TemporalSample[]>}
 */
export async function collectTemporal({ input, config, displaySize, signal, onProgress }) {
  const { width, height } = fitWidth(displaySize.width, displaySize.height, config.temporalWidth);
  const samples = [];
  let prev = null;

  await streamGrayFrames({
    input,
    width,
    height,
    fps: config.temporalFps,
    signal,
    onFrame(frame, index) {
      if (samples.length >= config.maxSamples) return;
      const m = measureFrame(frame, prev, width, height);
      samples.push({
        index,
        time: index / config.temporalFps,
        mean: m.mean,
        min: m.min,
        max: m.max,
        stdDev: m.stdDev,
        linearMean: m.linearMean,
        motion: m.motion,
        changed: m.changed,
        flashArea: m.flashArea,
        edge: m.edge,
      });
      prev = frame;
      if (onProgress && index % 60 === 0) onProgress(samples.length);
    },
  });

  return samples;
}

/**
 * @typedef {object} SpatialSample
 * @property {number} index
 * @property {number} time
 * @property {{top:number,bottom:number,left:number,right:number}} edgeRatio
 * @property {{top:number,bottom:number,left:number,right:number}} safeRatio
 * @property {number} structureRatio  gradient density of the whole frame
 * @property {Record<string,{x:number,y:number,x2:number,y2:number}|null>} safeBoxes
 */

/**
 * @param {object} o
 * @param {string} o.input
 * @param {any} o.config
 * @param {{width:number,height:number}} o.displaySize
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{samples: SpatialSample[], width:number, height:number, regions: any}>}
 */
export async function collectSpatial({ input, config, displaySize, signal }) {
  const { width, height } = fitWidth(displaySize.width, displaySize.height, config.spatialWidth);

  const edgeRegions = edgeBands(width, height);
  const safeRegions = unsafeRegions(width, height, config.safeArea);
  const checkSafeArea = Object.values(safeRegions).some((r) => r.w > 0 && r.h > 0);

  const samples = [];

  await streamGrayFrames({
    input,
    width,
    height,
    fps: config.spatialFps,
    signal,
    onFrame(frame, index) {
      if (samples.length >= config.maxSamples) return;

      /** @type {any} */
      const edgeRatio = {};
      for (const [key, region] of Object.entries(edgeRegions)) {
        edgeRatio[key] = region.w > 0 && region.h > 0
          ? measureRegionStructure(frame, width, height, region).ratio
          : 0;
      }

      /** @type {any} */
      const safeRatio = {};
      /** @type {any} */
      const safeBoxes = {};

      // How textured is the frame as a whole? Layout findings are only
      // meaningful when a region is busier than the frame's own baseline —
      // otherwise full-bleed footage would trip every border on every frame.
      const structureRatio = measureRegionStructure(frame, width, height, {
        x: 0,
        y: 0,
        w: width,
        h: height,
      }).ratio;

      for (const [key, region] of Object.entries(safeRegions)) {
        if (!checkSafeArea || region.w <= 0 || region.h <= 0) {
          safeRatio[key] = 0;
          safeBoxes[key] = null;
          continue;
        }
        const r = measureRegionStructure(frame, width, height, region);
        safeRatio[key] = r.ratio;
        safeBoxes[key] = r.box;
      }

      samples.push({ index, time: index / config.spatialFps, edgeRatio, safeRatio, structureRatio, safeBoxes });
    },
  });

  return { samples, width, height, regions: { edge: edgeRegions, safe: safeRegions } };
}

/**
 * The outermost band on each side — used to spot content running into (and
 * possibly off) the edge of the frame.
 *
 * @param {number} width
 * @param {number} height
 */
export function edgeBands(width, height) {
  const band = Math.max(2, Math.round(Math.min(width, height) * EDGE_BAND_FRACTION));
  return {
    top: { x: 0, y: 0, w: width, h: Math.min(band, height) },
    bottom: { x: 0, y: Math.max(0, height - band), w: width, h: Math.min(band, height) },
    left: { x: 0, y: band, w: Math.min(band, width), h: Math.max(0, height - band * 2) },
    right: { x: Math.max(0, width - band), y: band, w: Math.min(band, width), h: Math.max(0, height - band * 2) },
  };
}

/**
 * The four border bands that lie *outside* the safe area — i.e. exactly where a
 * platform draws its own UI on top of your video.
 *
 * @param {number} width
 * @param {number} height
 * @param {{top:number,right:number,bottom:number,left:number}} safeArea fractions
 */
export function unsafeRegions(width, height, safeArea) {
  const top = Math.round(height * (safeArea.top ?? 0));
  const bottom = Math.round(height * (safeArea.bottom ?? 0));
  const left = Math.round(width * (safeArea.left ?? 0));
  const right = Math.round(width * (safeArea.right ?? 0));
  const middleH = Math.max(0, height - top - bottom);

  return {
    top: { x: 0, y: 0, w: width, h: top },
    bottom: { x: 0, y: height - bottom, w: width, h: bottom },
    left: { x: 0, y: top, w: left, h: middleH },
    right: { x: width - right, y: top, w: right, h: middleH },
  };
}
