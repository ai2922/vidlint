/**
 * ffmpeg / ffprobe plumbing.
 *
 * vidlint deliberately bundles **no** binary and **no** image-decoding
 * dependency. Everything is derived from:
 *
 *   1. `ffprobe` -> container + stream metadata (JSON)
 *   2. `ffmpeg -f rawvideo -pix_fmt gray` -> a stream of downscaled greyscale
 *      frames on stdout, which we analyse as plain `Uint8Array`s
 *   3. `ffmpeg` audio filters whose *stderr diagnostics* we parse
 *
 * That keeps install size at ~0 and makes the tool work identically on any
 * machine that already has ffmpeg.
 */

import { spawn } from "node:child_process";
import { binaryMissingError, VidlintError } from "./errors.mjs";

/** Resolve a binary from an override env var, else the PATH name. */
function resolveBinary(envVar, fallback) {
  const override = process.env[envVar];
  return override && override.trim() ? override.trim() : fallback;
}

export const ffmpegPath = () => resolveBinary("VIDLINT_FFMPEG", "ffmpeg");
export const ffprobePath = () => resolveBinary("VIDLINT_FFPROBE", "ffprobe");

/**
 * Run a command to completion, capturing stdout and stderr as strings.
 * @param {string} command
 * @param {string[]} args
 * @param {{ stderrLimit?: number }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
export function runCapture(command, args, opts = {}) {
  const stderrLimit = opts.stderrLimit ?? 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(binaryMissingError(err, command));
      return;
    }

    const out = [];
    const err = [];
    let errLen = 0;

    child.on("error", (e) => reject(binaryMissingError(e, command)));
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => {
      if (errLen < stderrLimit) {
        err.push(d);
        errLen += d.length;
      }
    });
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code: code ?? 0,
      });
    });
  });
}

/**
 * Like `runCapture`, but keeps stdout as raw bytes — needed for piping PNGs
 * out of ffmpeg.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<{ stdout: Buffer, stderr: string, code: number }>}
 */
export function runCaptureBuffer(command, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(binaryMissingError(err, command));
      return;
    }

    const out = [];
    let stderr = "";

    child.on("error", (e) => reject(binaryMissingError(e, command)));
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 256 * 1024) stderr = stderr.slice(-256 * 1024);
    });
    child.on("close", (code) => {
      resolve({ stdout: Buffer.concat(out), stderr, code: code ?? 0 });
    });
  });
}

/**
 * Probe a media file.
 * @param {string} input
 */
export async function probeJson(input) {
  const { stdout, stderr, code } = await runCapture(ffprobePath(), [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    input,
  ]);

  if (code !== 0) {
    throw new VidlintError(
      `ffprobe could not read \`${input}\`.\n${stderr.trim() || `exit code ${code}`}`,
      "PROBE_FAILED",
      { hint: "Check that the path exists and the file is a readable media container." },
    );
  }

  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new VidlintError(
      `ffprobe returned output that is not valid JSON.`,
      "PROBE_UNPARSEABLE",
      { cause: err },
    );
  }
}

/**
 * Stream downscaled greyscale frames out of ffmpeg.
 *
 * Calls `onFrame(buffer, index)` once per frame with a `Uint8Array` of exactly
 * `width * height` bytes. Resolves with the number of frames delivered.
 *
 * @param {object} o
 * @param {string} o.input
 * @param {number} o.width
 * @param {number} o.height
 * @param {number} o.fps           sampling rate, NOT source fps
 * @param {(frame: Uint8Array, index: number) => void} o.onFrame
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<number>}
 */
export function streamGrayFrames({ input, width, height, fps, onFrame, signal }) {
  const frameSize = width * height;
  const args = [
    "-v", "error",
    "-nostdin",
    "-i", input,
    // fps= resamples to a fixed analysis rate so thresholds are time-based and
    // independent of the source frame rate.
    "-vf", `fps=${fps},scale=${width}:${height},setsar=1,format=gray`,
    "-f", "rawvideo",
    "-pix_fmt", "gray",
    "-",
  ];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(binaryMissingError(err, ffmpegPath()));
      return;
    }

    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    };

    const onAbort = () => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      fail(new VidlintError("Analysis aborted.", "ABORTED"));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (e) => fail(binaryMissingError(e, ffmpegPath())));

    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });

    let pending = Buffer.alloc(0);
    let index = 0;

    (async () => {
      try {
        for await (const chunk of child.stdout) {
          // Fast path: nothing buffered and the chunk is a whole number of frames.
          if (pending.length === 0 && chunk.length % frameSize === 0) {
            for (let off = 0; off < chunk.length; off += frameSize) {
              onFrame(chunk.subarray(off, off + frameSize), index++);
            }
            continue;
          }
          pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
          while (pending.length >= frameSize) {
            onFrame(pending.subarray(0, frameSize), index++);
            pending = pending.subarray(frameSize);
          }
        }

        if (pending.length > 0) {
          // ffmpeg emits whole frames; a partial tail means the stream died.
          if (pending.length > frameSize / 2) {
            onFrame(pending, index++);
          }
        }

        const code = await new Promise((r) => child.on("close", r));
        if (signal) signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;

        if (index === 0) {
          reject(new VidlintError(
            `No video frames could be decoded from \`${input}\`.`,
            "NO_FRAMES",
            {
              hint:
                (stderr.trim() ? `ffmpeg said:\n${stderr.trim()}\n\n` : "") +
                "The file may be audio-only, corrupt, or use a codec this ffmpeg build lacks.",
            },
          ));
          return;
        }
        if (code !== 0 && index < 2) {
          reject(new VidlintError(
            `ffmpeg exited with code ${code}.\n${stderr.trim()}`,
            "FFMPEG_FAILED",
          ));
          return;
        }
        resolve(index);
      } catch (err) {
        fail(err);
      }
    })();
  });
}

/**
 * Run an audio filter chain and return its raw stderr diagnostics.
 * Several ffmpeg filters (silencedetect, ebur128, astats) only *report* through
 * stderr, so parsing that text is the supported way to read their results.
 *
 * @param {string} input
 * @param {string} filterChain
 */
export async function runAudioFilter(input, filterChain) {
  const { stderr } = await runCapture(ffmpegPath(), [
    "-v", "info",
    "-nostdin",
    "-i", input,
    "-vn",
    "-af", filterChain,
    "-f", "null",
    "-",
  ]);
  return stderr;
}
