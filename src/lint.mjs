/**
 * The orchestrator: take a file, run every check, return one report.
 *
 * Order matters in exactly one place — the audio analysis runs before the
 * temporal checks, because the freeze/dead-air classification needs to know
 * when there was sound.
 */

import { collectSpatial, collectTemporal } from "./analyze.mjs";
import { analyzeAudio } from "./checks/audio.mjs";
import { checkEdgeClipping, checkSafeArea } from "./checks/layout.mjs";
import { checkMeta } from "./checks/meta.mjs";
import { checkBlank, checkFlash, checkFreeze, checkPacing, findFreezeRuns } from "./checks/temporal.mjs";
import { resolveConfig } from "./config.mjs";
import { countBySeverity, sortDefects } from "./defects.mjs";
import { probeMedia } from "./probe.mjs";
import { VidlintError } from "./errors.mjs";

export const SCHEMA_VERSION = "1.0";
export const TOOL_NAME = "vidlint";
export const TOOL_VERSION = "0.1.0";

/**
 * @typedef {object} LintOptions
 * @property {string} [platform]        safe-area preset, e.g. `reels`
 * @property {{top:number,right:number,bottom:number,left:number}} [safeArea] explicit insets, overriding the preset
 * @property {number} [temporalFps]
 * @property {number} [spatialFps]      set to 0 to skip layout checks
 * @property {number} [spatialWidth]
 * @property {number} [temporalWidth]
 * @property {AbortSignal} [signal]
 * @property {(stage:string, detail?:any)=>void} [onProgress]
 */

/**
 * Analyse a video file and return a defect report.
 *
 * @param {string} input path to a video file
 * @param {LintOptions} [options]
 */
export async function lint(input, options = {}) {
  const config = resolveConfig(options);
  const started = Date.now();
  const progress = options.onProgress ?? (() => {});

  progress("probe");
  const meta = await probeMedia(input);

  const displaySize = meta.video && meta.video.displayWidth > 0
    ? { width: meta.video.displayWidth, height: meta.video.displayHeight }
    : { width: 1920, height: 1080 };

  /** @type {any[]} */
  const defects = [];
  /** @type {any} */
  const metrics = {};

  // Container problems are cheap and independent of everything else.
  defects.push(...checkMeta(meta, config));

  // ---- audio (also yields the speech timeline the freeze check needs) ------
  progress("audio");
  let speechIntervals = null;
  try {
    const audio = await analyzeAudio({ input, config, meta });
    defects.push(...audio.defects);
    metrics.audio = audio.metrics;
    speechIntervals = audio.speechIntervals;
  } catch (err) {
    if (!(err instanceof VidlintError) || err.code !== "FFMPEG_FAILED") throw err;
    metrics.audio = { error: String(err.message) };
  }

  // ---- temporal -----------------------------------------------------------
  if (meta.video) {
    progress("frames");
    const temporal = await collectTemporal({ input, config, displaySize, signal: options.signal });

    defects.push(...checkBlank(temporal, config));
    defects.push(...checkFreeze(temporal, config, speechIntervals));
    defects.push(...checkFlash(temporal, config));

    const pacing = checkPacing(temporal, config, meta.duration);
    defects.push(...pacing.defects);

    const freezeRuns = findFreezeRuns(temporal, config);
    metrics.temporal = {
      framesSampled: temporal.length,
      samplingFps: config.temporalFps,
      ...pacing.metrics,
      longestStaticSeconds: freezeRuns.length
        ? round(freezeRuns.reduce((a, r) => Math.max(a, r.duration), 0), 3)
        : 0,
    };

    // ---- spatial ----------------------------------------------------------
    // The layout pass is the only heuristic part of vidlint, so it does not run
    // unless it has been asked for. Skipping it also makes the default run
    // meaningfully faster: one decode pass instead of two.
    const hasSafeArea = Object.values(config.safeArea ?? {}).some((v) => v > 0);
    const wantLayout = config.checkEdgeClipping || hasSafeArea;

    if (wantLayout && config.spatialFps > 0) {
      progress("layout");
      const spatial = await collectSpatial({ input, config, displaySize, signal: options.signal });

      if (config.checkEdgeClipping) {
        defects.push(...checkEdgeClipping(spatial.samples, config));
      }
      if (hasSafeArea) {
        defects.push(
          ...checkSafeArea(
            spatial.samples,
            config,
            { width: spatial.width, height: spatial.height },
            displaySize,
          ),
        );
      }

      metrics.layout = {
        framesSampled: spatial.samples.length,
        analysisSize: { width: spatial.width, height: spatial.height },
        peakEdgeRatio: peakBySide(spatial.samples, "edgeRatio"),
        peakSafeRatio: peakBySide(spatial.samples, "safeRatio"),
      };
    } else {
      metrics.layout = { skipped: true, reason: "layout checks are opt-in (see --layout / --platform)" };
    }
  }

  // ---- assemble -----------------------------------------------------------
  const ordered = sortDefects(defects).map(addFingerprint);
  const counts = countBySeverity(ordered);

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    input,
    media: {
      formatName: meta.formatName,
      durationSeconds: meta.duration === null ? null : round(meta.duration, 3),
      sizeBytes: meta.sizeBytes,
      bitrate: meta.bitrate,
      video: meta.video
        ? {
            codec: meta.video.codec,
            width: meta.video.displayWidth,
            height: meta.video.displayHeight,
            fps: meta.video.fps === null ? null : round(meta.video.fps, 3),
            rotation: meta.video.rotation,
          }
        : null,
      audio: meta.audio
        ? { codec: meta.audio.codec, sampleRate: meta.audio.sampleRate, channels: meta.audio.channels }
        : null,
    },
    config: {
      platform: config.platform,
      safeArea: config.safeArea,
      thresholds: {
        blankStdDev: config.blankStdDev,
        freezeMotion: config.freezeMotion,
        freezeWarnSeconds: config.freezeWarnSeconds,
        flashPerSecondLimit: config.flashPerSecondLimit,
        audioSilenceThresholdDb: config.audioSilenceThresholdDb,
        loudnessTargetLufs: config.loudnessTargetLufs,
        edgeRatio: config.edgeRatio,
        safeAreaRatio: config.safeAreaRatio,
      },
    },
    summary: {
      total: ordered.length,
      errors: counts.error,
      warnings: counts.warn,
      infos: counts.info,
      /** True when there are no error-severity defects. */
      passed: counts.error === 0,
    },
    metrics,
    timing: { analysisMs: Date.now() - started },
    defects: ordered,
  };
}

/**
 * A stable identity for a defect so an agent can tell "the same problem, still
 * there" from "a new problem" across runs.
 *
 * @param {any} d
 */
function addFingerprint(d) {
  const side = d.evidence?.side ?? "";
  const at = d.from === null ? "" : round(d.from, 1);
  return { ...d, fingerprint: `${d.id}${side ? `:${side}` : ""}@${at}` };
}

/**
 * @param {any[]} samples
 * @param {string} key
 */
function peakBySide(samples, key) {
  /** @type {any} */
  const peaks = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const s of samples) {
    for (const side of Object.keys(peaks)) {
      const v = s[key]?.[side] ?? 0;
      if (v > peaks[side]) peaks[side] = round(v, 4);
    }
  }
  return peaks;
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
