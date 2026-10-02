/**
 * Checks that reason about *time*: blank frames, dead air, flash risk, pacing.
 *
 * All of them are pure functions of the temporal sample series, so they can be
 * unit-tested with hand-written sample arrays and no ffmpeg.
 */

import { defect, findRuns, formatDuration, formatTime } from "../defects.mjs";
import { classifyFreezeAudio } from "./avsync.mjs";

/**
 * Frames that are essentially a single flat colour — nothing rendered.
 *
 * @param {import('../analyze.mjs').TemporalSample[]} samples
 * @param {any} config
 */
export function checkBlank(samples, config) {
  const defects = [];
  const fps = config.temporalFps;

  const runs = findRuns(samples, (s) => s.stdDev < config.blankStdDev);

  for (const run of runs) {
    const from = run.items[0].time;
    const to = run.items[run.items.length - 1].time + 1 / fps;
    const duration = to - from;
    const avgMean = run.items.reduce((a, s) => a + s.mean, 0) / run.items.length;
    const coverAll = run.items.length >= samples.length - 1;

    const tone =
      avgMean < 16 ? "black" : avgMean > 240 ? "white" : `flat grey (mean ${avgMean.toFixed(0)})`;

    defects.push(
      defect({
        id: "blank-frames",
        severity: coverAll ? "error" : duration >= config.blankErrorSeconds ? "error" : "warn",
        title: coverAll ? "Entire video is a flat colour" : "Blank frames",
        message: coverAll
          ? `Every sampled frame is ${tone}. Nothing is being rendered.`
          : `${formatDuration(duration)} of ${tone} frames at ${formatTime(from)}.`,
        from,
        to,
        evidence: {
          durationSeconds: round(duration, 3),
          meanLuma: round(avgMean, 2),
          stdDev: round(run.items.reduce((a, s) => a + s.stdDev, 0) / run.items.length, 3),
        },
        hint: coverAll
          ? "The composition is rendering an empty frame. Check that a scene is actually mounted for the whole duration and that assets resolved."
          : "A blank stretch usually means a scene rendered empty, an asset failed to load, or a <Sequence> has no content. Inspect this timestamp in the Studio.",
      }),
    );
  }

  return defects;
}

/**
 * Maximal stretches where the picture is visible but *not moving*.
 *
 * Blank runs are excluded so that a black gap is reported once, as blank.
 * Exported because the audio-visual join needs the same runs.
 *
 * @param {import('../analyze.mjs').TemporalSample[]} samples
 * @param {any} config
 * @returns {{from:number,to:number,duration:number,meanMotion:number}[]}
 */
export function findFreezeRuns(samples, config) {
  const fps = config.temporalFps;
  const runs = findRuns(
    samples,
    (s) =>
      s.index > 0 &&
      s.motion < config.freezeMotion &&
      // A blank frame is trivially "frozen"; let checkBlank own that defect.
      s.stdDev >= config.blankStdDev,
  );

  return runs.map((run) => {
    const from = run.items[0].time;
    const to = run.items[run.items.length - 1].time + 1 / fps;
    return {
      from,
      to,
      duration: to - from,
      meanMotion: run.items.reduce((a, s) => a + s.motion, 0) / run.items.length,
    };
  });
}

/**
 * Stretches where the picture is visible but *not moving*.
 *
 * The severity depends entirely on what the audio is doing — see avsync.mjs.
 * A frozen frame under continuous audio is a stalled render; the same frozen
 * frame in silence is just a held beat.
 *
 * @param {import('../analyze.mjs').TemporalSample[]} samples
 * @param {any} config
 * @param {import('./avsync.mjs').Interval[]|null} [speechIntervals]
 */
export function checkFreeze(samples, config, speechIntervals = null) {
  const defects = [];

  const runs = findFreezeRuns(samples, config);

  for (const run of runs) {
    const { from, to, duration, meanMotion } = run;
    if (duration < config.freezeWarnSeconds) continue;

    const audio = classifyFreezeAudio(run, speechIntervals);
    const evidence = {
      durationSeconds: round(duration, 3),
      meanMotion: round(meanMotion, 5),
      threshold: config.freezeMotion,
      audioDuringFreeze: audio.kind,
      audioOverlapFraction:
        audio.speechFraction === null ? null : round(audio.speechFraction, 3),
    };

    if (audio.kind === "speech" || audio.kind === "mixed") {
      const pct = Math.round((audio.speechFraction ?? 0) * 100);
      defects.push(
        defect({
          id: "frozen-with-audio",
          severity: "error",
          title: "Picture frozen while audio continues",
          message:
            `The frame does not change for ${formatDuration(duration)} ` +
            `(${formatTime(from)} to ${formatTime(to)}), while audio is playing for ${pct}% of that time.`,
          from,
          to,
          evidence,
          hint:
            "This is the signature of a stalled render or a missing animation, not a stylistic choice. " +
            "Either the voiceover/music is longer than the animated scene, or a scene stopped updating. " +
            "Extend the scene's animation to cover the full audio span, or trim the audio.",
        }),
      );
      continue;
    }

    if (audio.kind === "silence") {
      // A still beat with no audio underneath is usually intentional.
      defects.push(
        defect({
          id: "dead-air",
          severity: duration >= config.freezeErrorSeconds ? "warn" : "info",
          title: "Static shot in silence",
          message: `The frame holds for ${formatDuration(duration)} with no audio underneath (${formatTime(from)} to ${formatTime(to)}).`,
          from,
          to,
          evidence,
          hint:
            "A held shot in silence reads as a pause. Acceptable as a deliberate beat, but if it lasts more than a couple of seconds " +
            "add subtle motion or a sound cue so the viewer knows nothing has broken.",
        }),
      );
      continue;
    }

    defects.push(
      defect({
        id: "dead-air",
        severity: duration >= config.freezeErrorSeconds ? "error" : "warn",
        title: "Dead air (picture not moving)",
        message: `The frame does not change for ${formatDuration(duration)}, from ${formatTime(from)} to ${formatTime(to)}.`,
        from,
        to,
        evidence,
        hint:
          "Viewers read a static frame as a stall. Add motion — animate an element, push in slowly, or cut sooner. " +
          "If the scene is genuinely a still, hold it for under 2s or add a subtle scale/translate drift.",
      }),
    );
  }

  return defects;
}

/**
 * Photosensitivity risk, implementing the WCAG 2.3.1 *general flash* threshold:
 * a pair of opposing changes in relative luminance of >= 10%, where the darker
 * state is below 0.80, affecting >= 25% of the frame, at more than 3 per second.
 *
 * @param {import('../analyze.mjs').TemporalSample[]} samples
 * @param {any} config
 */
export function checkFlash(samples, config) {
  const flashes = detectFlashes(samples, config);
  if (flashes.length === 0) return [];

  const limit = config.flashPerSecondLimit;
  const peakRate = peakFlashesPerSecond(flashes);

  const worst = flashes.reduce((a, b) => (a.deltaL >= b.deltaL ? a : b));

  return [
    defect({
      id: "flash-risk",
      severity: peakRate > limit ? "error" : "warn",
      title: peakRate > limit ? "Fails WCAG 2.3.1 flash threshold" : "Possible flash sequence",
      message:
        `${flashes.length} opposing luminance change${flashes.length === 1 ? "" : "s"} detected, ` +
        `peaking at ${peakRate}/s (limit ${limit}/s). Largest swing ${(worst.deltaL * 100).toFixed(0)}% ` +
        `at ${formatTime(worst.from)}.`,
      from: flashes[0].from,
      to: flashes[flashes.length - 1].to,
      evidence: {
        flashCount: flashes.length,
        peakPerSecond: peakRate,
        limitPerSecond: limit,
        largestDeltaL: round(worst.deltaL, 4),
        events: flashes.slice(0, 20).map((f) => ({
          from: round(f.from, 3),
          to: round(f.to, 3),
          deltaL: round(f.deltaL, 4),
          areaFraction: round(f.area, 3),
        })),
      },
      hint:
        "Photosensitive viewers can be harmed by strobe effects. Reduce the number of opposing luminance changes per second, " +
        "narrow the luminance swing, or shrink the flashing area below 25% of the frame.",
    }),
  ];
}

/**
 * Peak number of flash events inside any one-second window.
 * @param {{from:number,to:number}[]} flashes
 */
export function peakFlashesPerSecond(flashes) {
  let peak = 0;
  for (let i = 0; i < flashes.length; i++) {
    let count = 1;
    for (let j = i + 1; j < flashes.length; j++) {
      if (flashes[j].to - flashes[i].from <= 1.0) count++;
      else break;
    }
    if (count > peak) peak = count;
  }
  return peak;
}

/**
 * Prominence-based peak detection over the relative-luminance series, then pair
 * opposing extrema into flashes.
 *
 * @param {import('../analyze.mjs').TemporalSample[]} samples
 * @param {any} config
 */
export function detectFlashes(samples, config) {
  const n = samples.length;
  if (n < 3) return [];

  const prominence = config.flashDeltaL;

  /** @type {{index:number,value:number,type:'max'|'min'}[]} */
  const extrema = [];
  let dir = 0;
  let extremeIdx = 0;
  let extremeVal = samples[0].linearMean;

  for (let i = 1; i < n; i++) {
    const v = samples[i].linearMean;
    if (dir === 0) {
      if (v - extremeVal >= prominence) dir = 1;
      else if (extremeVal - v >= prominence) dir = -1;
    } else if (dir === 1) {
      if (v > extremeVal) {
        extremeVal = v;
        extremeIdx = i;
      } else if (extremeVal - v >= prominence) {
        extrema.push({ index: extremeIdx, value: extremeVal, type: "max" });
        dir = -1;
        extremeVal = v;
        extremeIdx = i;
      }
    } else {
      if (v < extremeVal) {
        extremeVal = v;
        extremeIdx = i;
      } else if (v - extremeVal >= prominence) {
        extrema.push({ index: extremeIdx, value: extremeVal, type: "min" });
        dir = 1;
        extremeVal = v;
        extremeIdx = i;
      }
    }
  }

  /** @type {{from:number,to:number,deltaL:number,area:number}[]} */
  const flashes = [];

  for (let k = 0; k + 1 < extrema.length; k++) {
    const a = extrema[k];
    const b = extrema[k + 1];
    if (a.type === b.type) continue;

    const deltaL = Math.abs(a.value - b.value);
    const darker = Math.min(a.value, b.value);
    if (deltaL < config.flashDeltaL) continue;
    if (darker >= config.flashDarkBelow) continue;

    // The flash "area" is the largest share of a 10-degree visual field that
    // actually moved between the two states — see measureFrame().
    let area = 0;
    for (let i = a.index; i <= b.index && i < n; i++) {
      const candidate = samples[i].flashArea ?? samples[i].changed ?? 0;
      if (candidate > area) area = candidate;
    }
    if (area < config.flashAreaFraction) continue;

    flashes.push({
      from: samples[a.index].time,
      to: samples[b.index].time,
      deltaL,
      area,
    });
  }

  return flashes;
}

/**
 * Pacing and motion statistics. Mostly informational, but a video that is
 * almost entirely static is a real defect.
 *
 * @param {import('../analyze.mjs').TemporalSample[]} samples
 * @param {any} config
 * @param {number|null} duration
 */
export function checkPacing(samples, config, duration) {
  const defects = [];
  const fps = config.temporalFps;

  const moving = samples.filter((s) => s.index > 0);
  if (moving.length === 0) return { defects, metrics: {} };

  const deadFrames = moving.filter((s) => s.motion < config.deadAirMotion).length;
  const deadAirRatio = deadFrames / moving.length;

  const totalDuration = duration ?? samples[samples.length - 1].time + 1 / fps;

  // Scene cuts: motion spikes that are local maxima well above the threshold.
  let cuts = 0;
  for (let i = 1; i + 1 < samples.length; i++) {
    const m = samples[i].motion;
    if (m >= config.sceneCutMotion && m >= samples[i - 1].motion && m >= samples[i + 1].motion) {
      cuts++;
    }
  }

  const metrics = {
    deadAirRatio: round(deadAirRatio, 4),
    sceneCuts: cuts,
    cutsPerMinute: totalDuration > 0 ? round((cuts / totalDuration) * 60, 2) : 0,
    meanMotion: round(moving.reduce((a, s) => a + s.motion, 0) / moving.length, 5),
    peakMotion: round(moving.reduce((a, s) => Math.max(a, s.motion), 0), 5),
  };

  if (totalDuration >= 10 && deadAirRatio > 0.6) {
    defects.push(
      defect({
        id: "mostly-static",
        severity: "warn",
        title: "Video is mostly static",
        message:
          `${(deadAirRatio * 100).toFixed(0)}% of the running time has almost no movement ` +
          `across ${totalDuration.toFixed(1)}s.`,
        from: 0,
        to: totalDuration,
        evidence: metrics,
        hint:
          "Long stretches with no motion read as a broken render. Add continuous subtle motion (drift, parallax, animated background) " +
          "so every frame differs from the last.",
      }),
    );
  }

  if (totalDuration >= 20 && cuts === 0) {
    defects.push(
      defect({
        id: "no-cuts",
        severity: "info",
        title: "Single unbroken shot",
        message: `${totalDuration.toFixed(1)}s with no detected scene change.`,
        from: 0,
        to: totalDuration,
        evidence: metrics,
        hint: "Often intentional. If not, break the video into scenes or cutaways to hold attention.",
      }),
    );
  }

  return { defects, metrics };
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
