/**
 * Unit tests for the pure parts of vidlint.
 *
 * These deliberately do not touch ffmpeg: every parser and check is a pure
 * function so it can be exercised against hand-written input. The end-to-end
 * behaviour against real video lives in e2e.test.mjs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSpeechIntervals, classifyFreezeAudio, totalOverlap } from "../src/checks/avsync.mjs";
import { parseEbur128Output, parseSilenceOutput } from "../src/checks/audio.mjs";
import {
  checkBlank,
  checkFlash,
  checkFreeze,
  detectFlashes,
  findFreezeRuns,
  peakFlashesPerSecond,
} from "../src/checks/temporal.mjs";
import { resolveConfig } from "../src/config.mjs";
import { countBySeverity, findRuns, formatTime, sortDefects } from "../src/defects.mjs";

const FPS = 30;

/**
 * Build a temporal sample series from a compact spec.
 * @param {object[]} frames
 */
function samples(frames) {
  return frames.map((f, i) => ({
    index: i,
    time: i / FPS,
    mean: f.mean ?? 128,
    min: f.min ?? 0,
    max: f.max ?? 255,
    stdDev: f.stdDev ?? 40,
    linearMean: f.linearMean ?? 0.2,
    motion: f.motion ?? 0.02,
    changed: f.changed ?? 0.5,
    flashArea: f.flashArea ?? f.changed ?? 0.5,
    edge: { top: 0, bottom: 0, left: 0, right: 0 },
  }));
}

/** n copies of a frame spec. */
function repeat(n, frame) {
  return Array.from({ length: n }, () => ({ ...frame }));
}

// ---------------------------------------------------------------------------
// findRuns
// ---------------------------------------------------------------------------

test("findRuns groups maximal consecutive matches", () => {
  const runs = findRuns([1, 1, 0, 1, 1, 1, 0], (n) => n === 1);
  assert.equal(runs.length, 2);
  assert.deepEqual(
    runs.map((r) => [r.startIndex, r.endIndex]),
    [[0, 1], [3, 5]],
  );
});

test("findRuns returns nothing when nothing matches", () => {
  assert.deepEqual(findRuns([0, 0, 0], (n) => n === 1), []);
});

// ---------------------------------------------------------------------------
// blank frames
// ---------------------------------------------------------------------------

test("checkBlank reports a sustained flat run as an error", () => {
  const s = samples([
    ...repeat(10, { stdDev: 40 }),
    ...repeat(20, { stdDev: 0.5, mean: 0 }),
    ...repeat(10, { stdDev: 40 }),
  ]);
  const defects = checkBlank(s, resolveConfig());

  assert.equal(defects.length, 1);
  assert.equal(defects[0].id, "blank-frames");
  assert.equal(defects[0].severity, "error");
  assert.match(defects[0].message, /black/);
});

test("checkBlank names a white run as white, not black", () => {
  const s = samples(repeat(30, { stdDev: 0.4, mean: 252 }));
  const defects = checkBlank(s, resolveConfig());
  assert.equal(defects.length, 1);
  assert.match(defects[0].message, /white/);
});

test("checkBlank stays quiet on normal frames", () => {
  assert.deepEqual(checkBlank(samples(repeat(30, { stdDev: 40 })), resolveConfig()), []);
});

// ---------------------------------------------------------------------------
// freeze / dead air
// ---------------------------------------------------------------------------

test("findFreezeRuns excludes the first sample, which has no predecessor", () => {
  const s = samples([
    { motion: 0 },
    ...repeat(60, { motion: 0.0001 }),
  ]);
  const runs = findFreezeRuns(s, resolveConfig());
  assert.equal(runs.length, 1);
  // 60 frozen samples at 30fps == 2s, not 61 samples.
  assert.ok(Math.abs(runs[0].duration - 2) < 0.05, `duration was ${runs[0].duration}`);
});

test("a blank frame is not also reported as dead air", () => {
  const s = samples([{ motion: 0.02 }, ...repeat(90, { motion: 0, stdDev: 0.5 })]);
  const config = resolveConfig();
  assert.equal(checkFreeze(s, config).length, 0, "blank run should not be dead air");
  assert.equal(checkBlank(s, config).length, 1);
});

// ---------------------------------------------------------------------------
// the audio-visual join: the headline rule
// ---------------------------------------------------------------------------

test("a freeze under continuous audio is an error", () => {
  const s = samples([{ motion: 0.02 }, ...repeat(120, { motion: 0.0001 })]);
  const config = resolveConfig();
  // The whole clip has sound.
  const speech = buildSpeechIntervals([], 4);

  const defects = checkFreeze(s, config, speech);
  assert.equal(defects.length, 1);
  assert.equal(defects[0].id, "frozen-with-audio");
  assert.equal(defects[0].severity, "error");
  assert.equal(defects[0].evidence.audioDuringFreeze, "speech");
});

test("the same freeze in silence is downgraded to informational", () => {
  const s = samples([{ motion: 0.02 }, ...repeat(90, { motion: 0.0001 })]);
  const config = resolveConfig();
  // Everything is silent.
  const speech = buildSpeechIntervals([{ start: 0, end: 4 }], 4);
  assert.deepEqual(speech, []);

  const defects = checkFreeze(s, config, speech);
  assert.equal(defects.length, 1);
  assert.equal(defects[0].id, "dead-air");
  assert.equal(defects[0].severity, "info");
  assert.equal(defects[0].evidence.audioDuringFreeze, "silence");
});

test("byte-identical freezes are graded purely by what the audio was doing", () => {
  const s = samples([{ motion: 0.02 }, ...repeat(90, { motion: 0.0001 })]);
  const config = resolveConfig();

  const withSpeech = checkFreeze(s, config, buildSpeechIntervals([], 4))[0];
  const withSilence = checkFreeze(s, config, buildSpeechIntervals([{ start: 0, end: 4 }], 4))[0];

  assert.equal(withSpeech.severity, "error");
  assert.equal(withSilence.severity, "info");
  assert.notEqual(withSpeech.id, withSilence.id);
});

test("without audio information the freeze falls back to duration-based severity", () => {
  const s = samples([{ motion: 0.02 }, ...repeat(150, { motion: 0.0001 })]);
  const defects = checkFreeze(s, resolveConfig(), null);
  assert.equal(defects[0].severity, "error");
  assert.equal(defects[0].evidence.audioDuringFreeze, "unknown");
});

test("buildSpeechIntervals complements silence within the duration", () => {
  const speech = buildSpeechIntervals(
    [
      { start: 1, end: 2 },
      { start: 4, end: 5 },
    ],
    6,
  );
  assert.deepEqual(speech, [
    { start: 0, end: 1 },
    { start: 2, end: 4 },
    { start: 5, end: 6 },
  ]);
});

test("buildSpeechIntervals merges overlapping silence", () => {
  const speech = buildSpeechIntervals(
    [
      { start: 1, end: 3 },
      { start: 2, end: 4 },
    ],
    5,
  );
  assert.deepEqual(speech, [
    { start: 0, end: 1 },
    { start: 4, end: 5 },
  ]);
});

test("totalOverlap sums only the intersecting time", () => {
  const overlap = totalOverlap({ start: 1, end: 5 }, [
    { start: 0, end: 2 },
    { start: 4, end: 9 },
  ]);
  assert.equal(overlap, 2);
});

test("classifyFreezeAudio marks a partial overlap as mixed", () => {
  const result = classifyFreezeAudio({ from: 0, to: 4, duration: 4 }, [{ start: 0, end: 1 }]);
  assert.equal(result.kind, "mixed");
  assert.equal(result.speechFraction, 0.25);
});

// ---------------------------------------------------------------------------
// flash detection (WCAG 2.3.1)
// ---------------------------------------------------------------------------

test("detectFlashes pairs opposing luminance transitions", () => {
  // WCAG counts a flash as a PAIR of opposing transitions, so
  // dark -> bright -> dark -> bright -> dark is exactly two flashes.
  const seq = [];
  for (let i = 0; i < 5; i++) {
    const v = i % 2 === 0 ? 0.05 : 0.95;
    for (let k = 0; k < 5; k++) seq.push({ linearMean: v, changed: 1, flashArea: 1 });
  }
  const flashes = detectFlashes(samples(seq), resolveConfig());
  assert.equal(flashes.length, 2, "four transitions make two flashes");
  assert.ok(flashes[0].deltaL > 0.5);
});

test("a slow fade never counts as a flash", () => {
  // 60 frames ramping up then down: opposing, but each step is tiny and the
  // prominence never reaches the threshold in one transition.
  const seq = [];
  for (let i = 0; i < 30; i++) seq.push({ linearMean: i / 30 * 0.5, changed: 0.5 });
  for (let i = 0; i < 30; i++) seq.push({ linearMean: 0.5 - (i / 30) * 0.5, changed: 0.5 });

  const flashes = detectFlashes(samples(seq), resolveConfig());
  assert.ok(flashes.length <= 1, `a fade produced ${flashes.length} flashes`);
});

test("a large swing that is too small in area is not a flash", () => {
  const seq = [];
  for (let i = 0; i < 4; i++) {
    const v = i % 2 === 0 ? 0.05 : 0.95;
    for (let k = 0; k < 5; k++) seq.push({ linearMean: v, changed: 0.01, flashArea: 0.01 });
  }
  assert.deepEqual(detectFlashes(samples(seq), resolveConfig()), []);
});

test("a swing between two already-bright states is not a flash", () => {
  // Both states are above the 0.80 "darker image" ceiling.
  const seq = [];
  for (let i = 0; i < 4; i++) {
    const v = i % 2 === 0 ? 0.85 : 1.0;
    for (let k = 0; k < 5; k++) seq.push({ linearMean: v, changed: 1, flashArea: 1 });
  }
  assert.deepEqual(detectFlashes(samples(seq), resolveConfig()), []);
});

test("checkFlash escalates to an error past three flashes per second", () => {
  const seq = [];
  for (let i = 0; i < 10; i++) {
    const v = i % 2 === 0 ? 0.05 : 0.95;
    for (let k = 0; k < 3; k++) seq.push({ linearMean: v, changed: 1, flashArea: 1 });
  }
  const defects = checkFlash(samples(seq), resolveConfig());

  assert.equal(defects.length, 1);
  assert.equal(defects[0].id, "flash-risk");
  assert.equal(defects[0].severity, "error");
  assert.match(defects[0].title, /WCAG 2\.3\.1/);
});

test("checkFlash detects a roughly 4 Hz strobe", () => {
  // A half-cycle every 4 samples at 30fps is about 3.75 full flashes per second.
  const seq = [];
  for (let i = 0; i < 60; i++) {
    const bright = Math.floor(i / 4) % 2 === 1;
    seq.push({ linearMean: bright ? 0.95 : 0.05, changed: 1, flashArea: 1 });
  }
  const defects = checkFlash(samples(seq), resolveConfig());

  assert.equal(defects.length, 1);
  assert.equal(defects[0].severity, "error");
  assert.ok(
    defects[0].evidence.peakPerSecond > 3,
    `expected a peak above 3/s, got ${defects[0].evidence.peakPerSecond}`,
  );
});

test("peakFlashesPerSecond counts events inside a one-second window", () => {
  const flashes = [
    { from: 0.0, to: 0.1 },
    { from: 0.2, to: 0.3 },
    { from: 0.4, to: 0.5 },
    { from: 0.6, to: 0.7 },
    { from: 2.0, to: 2.1 },
  ];
  assert.equal(peakFlashesPerSecond(flashes), 4);
});

// ---------------------------------------------------------------------------
// ffmpeg output parsers
// ---------------------------------------------------------------------------

test("parseSilenceOutput reads ordinary start/end pairs", () => {
  const stderr = [
    "[silencedetect @ 0x1] silence_start: 1.5",
    "[silencedetect @ 0x1] silence_end: 3.25 | silence_duration: 1.75",
  ].join("\n");
  assert.deepEqual(parseSilenceOutput(stderr, 10), [{ start: 1.5, end: 3.25 }]);
});

test("parseSilenceOutput closes an unterminated silence at the end of the file", () => {
  const stderr = "[silencedetect @ 0x1] silence_start: 8.0";
  assert.deepEqual(parseSilenceOutput(stderr, 10), [{ start: 8, end: 10 }]);
});

test("parseSilenceOutput handles a file that opens with silence", () => {
  const stderr = [
    "[silencedetect @ 0x1] silence_start: 0",
    "[silencedetect @ 0x1] silence_end: 2 | silence_duration: 2",
  ].join("\n");
  assert.deepEqual(parseSilenceOutput(stderr, 10), [{ start: 0, end: 2 }]);
});

test("parseEbur128Output reads the Summary block, not the streaming progress lines", () => {
  // This is the regression that mattered: ebur128 streams a running `I:` value,
  // and those early values are computed before the signal ramps up.
  const stderr = [
    "[Parsed_ebur128_0 @ 0x1] t: 0.1  M: -120.7  S: -120.7  I: -70.0 LUFS  LRA: 0.0 LU  FTPK: -120.0 dBFS  TPK: -120.0 dBFS",
    "[Parsed_ebur128_0 @ 0x1] t: 5.0  M: -12.0  S: -12.0  I: -13.9 LUFS  LRA: 1.5 LU  FTPK: -7.0 dBFS  TPK: -6.9 dBFS",
    "[Parsed_ebur128_0 @ 0x1] Summary:",
    "    I:         -13.8 LUFS",
    "    LRA:         1.9 LU",
    "  True peak:",
    "    Peak:       -6.9 dBFS",
  ].join("\n");

  const result = parseEbur128Output(stderr);
  assert.equal(result.integratedLufs, -13.8, "must read the summary, not the first streamed value");
  assert.equal(result.truePeakDbfs, -6.9);
  assert.equal(result.loudnessRangeLu, 1.9);
});

test("parseEbur128Output tolerates missing sections", () => {
  const result = parseEbur128Output("[Parsed_ebur128_0 @ 0x1] Summary:\n    I:  -20.0 LUFS");
  assert.equal(result.integratedLufs, -20);
  assert.equal(result.truePeakDbfs, null);
});

// ---------------------------------------------------------------------------
// config + report helpers
// ---------------------------------------------------------------------------

test("resolveConfig resolves a platform preset into concrete insets", () => {
  const config = resolveConfig({ platform: "reels" });
  assert.ok(config.safeArea.bottom > 0);
  assert.equal(config.safeArea.left, 0.04);
});

test("an explicit safe area overrides the platform preset", () => {
  const config = resolveConfig({
    platform: "reels",
    safeArea: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
  });
  assert.equal(config.safeArea.bottom, 0.1);
});

test("layout checks are opt-in by default", () => {
  const config = resolveConfig();
  assert.equal(config.checkEdgeClipping, false);
  assert.equal(config.platform, "none");
});

test("sortDefects puts errors first, then orders by time", () => {
  const sorted = sortDefects([
    { id: "a", severity: "info", from: 5 },
    { id: "b", severity: "error", from: 9 },
    { id: "c", severity: "error", from: 2 },
    { id: "d", severity: "warn", from: 1 },
  ]);
  assert.deepEqual(sorted.map((d) => d.id), ["c", "b", "d", "a"]);
});

test("countBySeverity tallies each level", () => {
  const counts = countBySeverity([
    { severity: "error" },
    { severity: "error" },
    { severity: "warn" },
    { severity: "info" },
  ]);
  assert.deepEqual(counts, { error: 2, warn: 1, info: 1 });
});

test("formatTime renders minutes and hundredths", () => {
  assert.equal(formatTime(3.4), "0:03.40");
  assert.equal(formatTime(75), "1:15.00");
  assert.equal(formatTime(null), "--:--");
});
