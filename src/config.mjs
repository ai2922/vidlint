/**
 * Configuration surface: defaults, platform presets, and normalisation.
 *
 * Every threshold lives here so that a check never hard-codes a magic number,
 * and so users can tune behaviour from the CLI without editing source.
 */

/**
 * Safe-area presets, as a fraction of frame width/height.
 *
 * IMPORTANT — how much to trust these:
 *
 *   `remotion` is the only preset derived from a first-party source. Remotion's
 *   official layout rule says that for a 1080px-wide composition, key content
 *   should sit at least 80px from the sides and 100px from the top and bottom.
 *   Expressed against 1080x1920 that is 80/1080 = 0.074 and 100/1920 = 0.052.
 *
 *   The per-platform presets below are **community-reported approximations, not
 *   published platform specifications.** Neither TikTok, Meta nor Google
 *   publishes an official safe-area pixel table, and Remotion's own Social Safe
 *   Zones element warns that its measured regions are "a capture-calibrated
 *   reference, not a guarantee from either platform" because the live UI varies
 *   by device, app version, locale, caption length and account state.
 *
 *   Treat them as a starting point. Calibrate against a real device, then pass
 *   your own numbers via `--safe-area top,right,bottom,left`.
 */
export const PLATFORM_PRESETS = {
  none: { top: 0, right: 0, bottom: 0, left: 0 },
  /** First-party: Remotion's own 80px/100px rule at 1080x1920. */
  remotion: { top: 0.052, right: 0.074, bottom: 0.052, left: 0.074 },
  /** Broadcast-style title safe (10% inset all round). */
  "title-safe": { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
  /** Generic conservative vertical-video inset. */
  vertical: { top: 0.10, right: 0.06, bottom: 0.14, left: 0.06 },
  /** Community-reported, unverified. */
  tiktok: { top: 0.07, right: 0.13, bottom: 0.17, left: 0.04 },
  /** Community-reported, unverified. */
  reels: { top: 0.07, right: 0.13, bottom: 0.21, left: 0.04 },
  /** Community-reported, unverified. */
  shorts: { top: 0.06, right: 0.11, bottom: 0.16, left: 0.04 },
};

export const DEFAULT_CONFIG = {
  // ---- sampling -----------------------------------------------------------
  /** Time-resolution matters for blank/freeze/flash/pacing, not spatial detail. */
  temporalFps: 30,
  temporalWidth: 192,
  /** Spatial detail matters for edge clipping and safe-area, not time. */
  spatialFps: 2,
  spatialWidth: 720,
  /** Hard ceiling on sampled frames per pass, so a 3-hour file cannot OOM us. */
  maxSamples: 20000,

  // ---- blank frames -------------------------------------------------------
  /** A frame whose pixel standard deviation is below this is "uniform". */
  blankStdDev: 3.0,
  /** Uniform runs at least this long are errors; shorter ones are warnings. */
  blankErrorSeconds: 0.5,

  // ---- dead air / freeze --------------------------------------------------
  /** Mean absolute frame difference (0..1) below this counts as "not moving". */
  freezeMotion: 0.0015,
  /** Static runs at least this long are reported. */
  freezeWarnSeconds: 2.0,
  freezeErrorSeconds: 4.0,
  /** Below this we consider the frame "barely alive" for the dead-air ratio. */
  deadAirMotion: 0.004,

  // ---- pacing -------------------------------------------------------------
  /** Motion above this is treated as a hard cut / scene change. */
  sceneCutMotion: 0.08,

  // ---- layout (edge clipping / safe area) ---------------------------------
  /** Fraction of border-band pixels on a strong edge before we call it content. */
  edgeRatio: 0.06,
  /** Fraction of unsafe-area pixels on a strong edge before we call it content. */
  safeAreaRatio: 0.02,
  /**
   * A region must be at least this many times busier than the frame as a whole
   * before it counts as a distinct element. Without this guard, full-bleed
   * footage (a photo, video, or noisy gradient) trips every layout check on
   * every frame, which makes the tool useless on real content.
   */
  structureContrastFactor: 1.35,
  /** A violation must persist across this many sampled frames to be reported. */
  layoutMinFrames: 2,
  /**
   * Edge-clipping detection is a *pixel heuristic* and is therefore off by
   * default — busy full-bleed footage trips it. Enable with `--layout`.
   * Safe-area checking turns on automatically when a platform preset is given,
   * because then the user has explicitly asked about that region.
   */
  checkEdgeClipping: false,
  platform: "none",

  // ---- flash / strobe (WCAG 2.3.1) ---------------------------------------
  /** Opposing relative-luminance change that constitutes a flash. */
  flashDeltaL: 0.10,
  /** The darker of the two states must be below this. */
  flashDarkBelow: 0.80,
  /**
   * The changed area must cover at least this fraction of a 10-degree visual
   * field. WCAG states the threshold as "25% of any 10 degree visual field",
   * which measureFrame() approximates with a 3x3 grid of the frame.
   */
  flashAreaFraction: 0.25,
  /** More than this many flashes per second fails WCAG 2.3.1. */
  flashPerSecondLimit: 3,

  // ---- audio --------------------------------------------------------------
  audioSilenceThresholdDb: -50,
  audioSilenceMinSeconds: 1.0,
  /** Integrated loudness guidance for web delivery. */
  loudnessTargetLufs: -14,
  loudnessMinLufs: -30,
  loudnessMaxLufs: -9,
  /** True peak must stay below this to avoid inter-sample clipping. */
  peakCeilingDbfs: -1.0,

  // ---- container ----------------------------------------------------------
  minFps: 12,
  minDurationSeconds: 1.0,

  // ---- misc ---------------------------------------------------------------
  /** Emit info-level pacing detail as well as problems. */
  verbose: false,
};

/**
 * Merge user options over the defaults, resolving the platform preset into a
 * concrete safe area unless the user set one explicitly.
 *
 * @param {object} [options]
 */
export function resolveConfig(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };

  if (options.safeArea) {
    config.safeArea = options.safeArea;
  } else {
    config.safeArea = PLATFORM_PRESETS[config.platform] ?? PLATFORM_PRESETS.none;
  }

  config.temporalFps = clampNumber(config.temporalFps, 1, 240);
  config.spatialFps = clampNumber(config.spatialFps, 0.1, 240);
  config.temporalWidth = Math.round(clampNumber(config.temporalWidth, 32, 4096));
  config.spatialWidth = Math.round(clampNumber(config.spatialWidth, 64, 4096));

  return config;
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
