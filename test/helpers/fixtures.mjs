/**
 * Deterministic test fixtures, generated with ffmpeg.
 *
 * These are not committed as binaries - they are rebuilt on demand so the test
 * suite stays reproducible and the repository stays small.
 *
 * `bad.mp4` deliberately plants one instance of each headline defect:
 *
 *   0.0 -  2.0s   moving test pattern                     clean
 *   2.0 -  6.0s   a frozen still WITH audio playing        -> frozen-with-audio
 *   6.0 -  7.0s   black frame, silent                      -> blank-frames
 *   7.0 - 10.0s   moving pattern with a bright box parked
 *                 in the bottom safe-area band             -> safe-area
 *
 * `good.mp4` is continuous full-bleed motion with correctly levelled audio and
 * should come back with no defects at all.
 *
 * `clean-bg.mp4` is the realistic "generated composition" case: a flat
 * background, one animated element, and a single high-contrast banner inside
 * the bottom safe-area band. It is the fair test for the safe-area heuristic,
 * because `testsrc2` is a pathologically busy full-bleed pattern that trips the
 * heuristic on every border.
 *
 * CONCURRENCY: Node's test runner executes test files in parallel, so several
 * processes call `ensureFixtures()` on the same directory at once. Two things
 * make that safe:
 *
 *   1. Each build happens in its own `mkdtempSync` working directory, so no two
 *      processes ever share a scratch path.
 *   2. A finished fixture is published with `renameSync`, which is atomic
 *      within a filesystem. A reader therefore either sees no file or a
 *      complete one - never a half-written video.
 *
 * Without this, a concurrent run produced a truncated `bad.mp4`, which silently
 * reported zero defects instead of failing loudly.
 *
 * NOTE: source files in this repository are deliberately ASCII-only. Editing
 * them with PowerShell's Set-Content round-trips them through the ANSI codepage
 * and silently corrupts multi-byte characters.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const W = 640;
const H = 360;
const FPS = 30;

function ffmpeg(args, label) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", "-nostdin", ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `fixture step "${label}" failed (exit ${result.status}):\n${result.stderr || ""}`,
    );
  }
}

/** Common encoder settings, identical across every fixture. */
function encodeArgs() {
  return [
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-r", String(FPS),
    "-c:a", "aac",
    "-ar", "44100",
    "-ac", "1",
    "-b:a", "128k",
  ];
}

/** Encode a lavfi-driven segment with parameters identical across all segments. */
function segment(outPath, args) {
  ffmpeg([...args, ...encodeArgs(), outPath], outPath);
}

function concat(listPath, outPath) {
  ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath], "concat");
}

/**
 * Build `dest` unless it already exists, publishing it atomically.
 *
 * @param {string} dest          final fixture path
 * @param {(tmpPath: string, workDir: string) => void} build
 */
function publishIfMissing(dest, build) {
  if (existsSync(dest)) return;

  mkdirSync(dirname(dest), { recursive: true });
  const work = mkdtempSync(join(dirname(dest), ".build-"));

  try {
    const tmp = join(work, basename(dest));
    build(tmp, work);
    if (!existsSync(tmp)) return;

    try {
      renameSync(tmp, dest);
    } catch (err) {
      // Another process published this fixture first. On Windows rename refuses
      // to clobber, which is exactly the outcome we want anyway.
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === "EEXIST" || code === "EPERM" || code === "ENOTEMPTY" || code === "EACCES") return;
      throw err;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Generate the fixtures into `dir` if they are not already present.
 * Safe to call concurrently from several processes.
 *
 * @param {string} dir
 * @returns {{good:string, bad:string, clean:string}}
 */
export function ensureFixtures(dir) {
  const good = join(dir, "good.mp4");
  const bad = join(dir, "bad.mp4");
  const clean = join(dir, "clean-bg.mp4");

  mkdirSync(dir, { recursive: true });

  publishIfMissing(good, (tmp) => buildGood(tmp));
  publishIfMissing(bad, (tmp, work) => buildBad(tmp, work));
  publishIfMissing(clean, (tmp) => buildCleanBackground(tmp));

  return { good, bad, clean };
}

function buildGood(out) {
  ffmpeg(
    [
      "-f", "lavfi", "-i", `testsrc2=size=${W}x${H}:rate=${FPS}:duration=6`,
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=6",
      "-af", "volume=8dB",
      ...encodeArgs(),
      "-shortest",
      out,
    ],
    "good",
  );
}

function buildBad(out, work) {
  // A textured still to freeze on - it must be non-uniform so the blank check
  // does not claim it, which is exactly the case the audio join classifies.
  const still = join(work, "still.png");
  ffmpeg(
    ["-f", "lavfi", "-i", `testsrc2=size=${W}x${H}:rate=${FPS}:duration=1`, "-frames:v", "1", still],
    "still",
  );

  // 1. moving, 2s
  segment(join(work, "s1.mp4"), [
    "-f", "lavfi", "-i", `testsrc2=size=${W}x${H}:rate=${FPS}:duration=2`,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2",
    "-af", "volume=8dB",
  ]);

  // 2. FROZEN picture for 4s while audio keeps playing.
  segment(join(work, "s2.mp4"), [
    "-loop", "1", "-i", still,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=4",
    "-af", "volume=8dB",
    "-t", "4",
  ]);

  // 3. black and silent, 1s.
  segment(join(work, "s3.mp4"), [
    "-f", "lavfi", "-i", `color=c=black:size=${W}x${H}:rate=${FPS}:duration=1`,
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
    "-t", "1",
  ]);

  // 4. moving, 3s, with a bright box parked in the bottom safe-area band.
  //    Uses drawbox rather than drawtext so the fixture needs no system font.
  segment(join(work, "s4.mp4"), [
    "-f", "lavfi", "-i", `testsrc2=size=${W}x${H}:rate=${FPS}:duration=3`,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=3",
    "-af", "volume=8dB",
    "-vf", `drawbox=x=180:y=${H - 46}:w=280:h=30:color=white@1.0:t=fill`,
  ]);

  // The concat demuxer resolves `file '...'` relative to the list file, so the
  // list must sit beside the segments.
  const list = join(work, "list.txt");
  writeFileSync(
    list,
    ["s1.mp4", "s2.mp4", "s3.mp4", "s4.mp4"].map((f) => `file '${f}'`).join("\n") + "\n",
    "utf8",
  );

  concat(list, out);
}

/**
 * A realistic composed-video case: flat background, one animated element, and a
 * single high-contrast banner sitting inside the bottom safe-area band.
 */
function buildCleanBackground(out) {
  // NOTE: ffmpeg 9's `drawbox` does not re-evaluate its x/y expressions per
  // frame, so a moving drawbox renders a perfectly static video. `overlay`
  // does honour `t`, so the animated element is composited with overlay and
  // only the static banner uses drawbox.
  const filter = [
    "overlay=x='200+90*sin(2*PI*t/1.5)':y='110+40*cos(2*PI*t/1.5)'",
    "drawbox=x=180:y=318:w=280:h=28:color=white@1.0:t=fill",
  ].join(",");

  ffmpeg(
    [
      "-f", "lavfi", "-i", `color=c=0x0f1115:size=${W}x${H}:rate=${FPS}:duration=6`,
      "-f", "lavfi", "-i", `color=c=0x2f6fed:size=130x90:rate=${FPS}:duration=6`,
      "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=44100:duration=6",
      "-filter_complex", `[0:v][1:v]${filter}[v]`,
      "-map", "[v]",
      "-map", "2:a",
      "-af", "volume=8dB",
      ...encodeArgs(),
      "-shortest",
      out,
    ],
    "clean-bg",
  );
}

// Allow `node test/helpers/fixtures.mjs [dir]` for manual regeneration.
if (process.argv[1] && process.argv[1].endsWith("fixtures.mjs")) {
  const dir = process.argv[2] ?? ".fixtures";
  const { good, bad, clean } = ensureFixtures(dir);
  const size = (p) => `${(readFileSync(p).length / 1024).toFixed(0)} kB`;
  console.log(`good.mp4     -> ${good} (${size(good)})`);
  console.log(`bad.mp4      -> ${bad} (${size(bad)})`);
  console.log(`clean-bg.mp4 -> ${clean} (${size(clean)})`);
}
