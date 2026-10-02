/**
 * Audio checks.
 *
 * Silence, loudness and true peak are read by *parsing ffmpeg's stderr
 * diagnostics*, because `silencedetect` and `ebur128` have no machine-readable
 * output mode. The parsers are pure functions so they can be tested against
 * captured ffmpeg output without invoking ffmpeg.
 */

import { runAudioFilter } from "../ffmpeg.mjs";
import { defect, formatDuration, formatTime } from "../defects.mjs";
import { buildSpeechIntervals } from "./avsync.mjs";

/**
 * Parse `silencedetect` diagnostics.
 *
 * Handles the two awkward cases ffmpeg actually produces:
 *   - a file that opens with silence, where `silence_start: 0` is emitted
 *   - a file that ends in silence, where `silence_end` never arrives and the
 *     silence must be closed at the end of the file
 *
 * @param {string} stderr
 * @param {number|null} duration
 * @returns {{start:number,end:number}[]}
 */
export function parseSilenceOutput(stderr, duration) {
  /** @type {{start:number,end:number}[]} */
  const intervals = [];
  let open = null;

  const re = /silence_(start|end):\s*(-?[\d.]+)(?:\s*\|\s*silence_duration:\s*(-?[\d.]+))?/g;
  let m;
  while ((m = re.exec(stderr)) !== null) {
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;

    if (m[1] === "start") {
      open = Math.max(0, value);
    } else {
      const start = open ?? 0;
      const end = Math.max(start, Number.isFinite(Number(m[3])) && m[3] !== undefined ? start + Number(m[3]) : value);
      intervals.push({ start, end });
      open = null;
    }
  }

  if (open !== null) {
    const end = Number.isFinite(duration) && duration !== null ? Math.max(open, duration) : open;
    intervals.push({ start: open, end });
  }

  return intervals;
}

/**
 * Parse the `ebur128` summary block.
 *
 * ebur128 also streams a *running* `I:` value on every progress line, and those
 * early values are meaningless — they are computed before the signal has ramped
 * up, so a track that opens quietly reports something absurd like -70 LUFS.
 * Only the final `Summary:` block is authoritative, so the search is scoped to
 * it. (True peak, by contrast, only ever appears as `Peak:` in the summary; the
 * progress lines call it `TPK:`.)
 *
 * @param {string} stderr
 * @returns {{integratedLufs:number|null,truePeakDbfs:number|null,loudnessRangeLu:number|null}}
 */
export function parseEbur128Output(stderr) {
  const summaryAt = stderr.lastIndexOf("Summary:");
  const scope = summaryAt >= 0 ? stderr.slice(summaryAt) : stderr;

  const pick = (re) => {
    const m = scope.match(re) ?? stderr.match(re);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  };

  return {
    integratedLufs: pick(/\bI:\s*(-?[\d.]+)\s*LUFS/i),
    truePeakDbfs: pick(/\bPeak:\s*(-?[\d.]+)\s*dBFS/i),
    loudnessRangeLu: pick(/\bLRA:\s*(-?[\d.]+)\s*LU/i),
  };
}

/**
 * @param {object} o
 * @param {string} o.input
 * @param {any} o.config
 * @param {import('../probe.mjs').MediaInfo} o.meta
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{defects:any[], metrics:any, speechIntervals:import('./avsync.mjs').Interval[]|null}>}
 */
export async function analyzeAudio({ input, config, meta }) {
  const defects = [];

  if (!meta.audio) {
    defects.push(
      defect({
        id: "no-audio-track",
        severity: "warn",
        title: "No audio track",
        message: "This file has no audio stream at all.",
        evidence: { audioCodec: null },
        hint:
          "Silent video is a hard sell on social platforms, and it makes every visual pause feel longer. " +
          "Add narration, music or sound effects — or confirm the silence is deliberate.",
      }),
    );
    return { defects, metrics: { hasAudio: false }, speechIntervals: null };
  }

  // One decode pass for both filters: silencedetect and ebur128 both report via
  // stderr, so they can share a single ffmpeg invocation.
  const stderr = await runAudioFilter(
    input,
    `silencedetect=noise=${config.audioSilenceThresholdDb}dB:d=${config.audioSilenceMinSeconds},ebur128=peak=true`,
  );
  const silenceIntervals = parseSilenceOutput(stderr, meta.duration);
  const loudness = parseEbur128Output(stderr);

  // ---- silence ------------------------------------------------------------
  if (meta.duration && silenceIntervals.length > 0) {
    const silentTotal = silenceIntervals.reduce((a, i) => a + (i.end - i.start), 0);
    const ratio = silentTotal / meta.duration;

    if (ratio > 0.98) {
      defects.push(
        defect({
          id: "silent-audio-track",
          severity: "error",
          title: "Audio track is effectively silent",
          message: `The audio stream is silent for ${(ratio * 100).toFixed(0)}% of the video.`,
          from: 0,
          to: meta.duration,
          evidence: { silentRatio: round(ratio, 4), thresholdDb: config.audioSilenceThresholdDb },
          hint:
            "An audio track that carries nothing is usually a failed TTS/music render. Check the audio source, " +
            "or drop the track so the file does not claim to have sound.",
        }),
      );
    } else {
      for (const interval of silenceIntervals) {
        const duration = interval.end - interval.start;
        if (duration < config.audioSilenceMinSeconds) continue;
        // Only worth flagging when it is a long, deliberate-feeling gap.
        if (duration < 3) continue;
        defects.push(
          defect({
            id: "audio-gap",
            severity: duration >= 6 ? "warn" : "info",
            title: "Gap in the audio",
            message: `Audio drops below ${config.audioSilenceThresholdDb}dB for ${formatDuration(duration)} at ${formatTime(interval.start)}.`,
            from: interval.start,
            to: interval.end,
            evidence: { durationSeconds: round(duration, 3), thresholdDb: config.audioSilenceThresholdDb },
            hint: "A long silent stretch under moving picture stalls the pace. Trim it or fill it with music.",
          }),
        );
      }
    }
  }

  // ---- loudness -----------------------------------------------------------
  const { integratedLufs, truePeakDbfs } = loudness;

  if (integratedLufs !== null) {
    if (integratedLufs < config.loudnessMinLufs) {
      defects.push(
        defect({
          id: "too-quiet",
          severity: "warn",
          title: "Audio is too quiet",
          message: `Integrated loudness is ${integratedLufs.toFixed(1)} LUFS; the target is about ${config.loudnessTargetLufs} LUFS.`,
          evidence: { integratedLufs, target: config.loudnessTargetLufs, floor: config.loudnessMinLufs },
          hint: `Normalise the mix to roughly ${config.loudnessTargetLufs} LUFS (EBU R128) so it is not drowned out on phone speakers.`,
        }),
      );
    } else if (integratedLufs > config.loudnessMaxLufs) {
      defects.push(
        defect({
          id: "too-loud",
          severity: "warn",
          title: "Audio is too loud",
          message: `Integrated loudness is ${integratedLufs.toFixed(1)} LUFS; the target is about ${config.loudnessTargetLufs} LUFS.`,
          evidence: { integratedLufs, target: config.loudnessTargetLufs, ceiling: config.loudnessMaxLufs },
          hint: `Platforms will turn this down anyway, and it risks distortion. Aim for ${config.loudnessTargetLufs} LUFS.`,
        }),
      );
    }
  }

  if (truePeakDbfs !== null && truePeakDbfs >= config.peakCeilingDbfs) {
    const clipping = truePeakDbfs >= -0.1;
    defects.push(
      defect({
        id: "audio-clipping",
        severity: clipping ? "error" : "warn",
        title: clipping ? "Audio is clipping" : "Audio true peak is too hot",
        message: `True peak reaches ${truePeakDbfs.toFixed(1)} dBFS; the ceiling is ${config.peakCeilingDbfs} dBFS.`,
        evidence: { truePeakDbfs, ceilingDbfs: config.peakCeilingDbfs },
        hint: "Pull the mix down or add a limiter. Clipped audio is audible distortion that no amount of picture quality fixes.",
      }),
    );
  }

  const speechIntervals = meta.duration ? buildSpeechIntervals(silenceIntervals, meta.duration) : null;

  return {
    defects,
    metrics: {
      hasAudio: true,
      integratedLufs,
      truePeakDbfs,
      loudnessRangeLu: loudness.loudnessRangeLu,
      silenceCount: silenceIntervals.length,
      silentRatio:
        meta.duration && silenceIntervals.length
          ? round(silenceIntervals.reduce((a, i) => a + (i.end - i.start), 0) / meta.duration, 4)
          : 0,
    },
    speechIntervals,
  };
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
