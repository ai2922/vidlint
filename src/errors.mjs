/**
 * Typed error used throughout vidlint so callers (and agents) can react to the
 * *kind* of failure: a missing binary needs a different fix than a bad codec.
 */

export class VidlintError extends Error {
  /**
   * @param {string} message
   * @param {string} code machine-readable, e.g. `FFMPEG_MISSING`, `PROBE_FAILED`
   * @param {{ hint?: string, cause?: unknown }} [extra]
   */
  constructor(message, code, extra = {}) {
    super(message);
    this.name = "VidlintError";
    this.code = code;
    this.hint = extra.hint;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}

/**
 * Wrap a spawn failure into something a user can act on.
 * @param {NodeJS.ErrnoException} err
 * @param {string} binary
 */
export function binaryMissingError(err, binary) {
  if (err && err.code === "ENOENT") {
    return new VidlintError(
      `Could not find \`${binary}\` on your PATH.`,
      "FFMPEG_MISSING",
      {
        hint:
          `vidlint shells out to ffmpeg/ffprobe and bundles no binary of its own.\n` +
          `  Install it, or point vidlint at an existing build with the environment\n` +
          `  variables VIDLINT_FFMPEG and VIDLINT_FFPROBE.\n` +
          `    Windows : winget install Gyan.FFmpeg\n` +
          `    macOS   : brew install ffmpeg\n` +
          `    Debian  : sudo apt install ffmpeg`,
        cause: err,
      },
    );
  }
  return new VidlintError(
    `Failed to spawn \`${binary}\`: ${err && err.message}`,
    "FFMPEG_SPAWN_FAILED",
    { cause: err },
  );
}
