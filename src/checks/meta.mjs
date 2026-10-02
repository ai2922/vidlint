/**
 * Container and stream sanity checks — the things that are wrong before a
 * single frame is even looked at.
 */

import { defect } from "../defects.mjs";

/**
 * @param {import('../probe.mjs').MediaInfo} meta
 * @param {any} config
 */
export function checkMeta(meta, config) {
  const defects = [];
  const v = meta.video;

  if (!v) {
    defects.push(
      defect({
        id: "no-video-stream",
        severity: "error",
        title: "No video stream",
        message: `\`${meta.input}\` contains no decodable video stream.`,
        evidence: { formatName: meta.formatName, audio: meta.audio?.codec ?? null },
        hint: "This looks like an audio-only or mislabelled file. Re-export the video.",
      }),
    );
    return defects;
  }

  if (v.displayWidth <= 0 || v.displayHeight <= 0) {
    defects.push(
      defect({
        id: "invalid-dimensions",
        severity: "error",
        title: "Invalid frame dimensions",
        message: `Reported size is ${v.width}x${v.height}.`,
        evidence: { width: v.width, height: v.height },
        hint: "The container metadata is malformed. Re-mux or re-export the file.",
      }),
    );
  }

  if (v.fps !== null && v.fps > 0 && v.fps < config.minFps) {
    defects.push(
      defect({
        id: "low-frame-rate",
        severity: "warn",
        title: "Low frame rate",
        message: `The video runs at ${v.fps.toFixed(2)} fps, below the ${config.minFps} fps floor.`,
        evidence: { fps: round(v.fps, 3), floor: config.minFps },
        hint: "Motion at this rate reads as a slideshow. Render at 30 or 60 fps.",
      }),
    );
  }

  if (meta.duration !== null && meta.duration > 0 && meta.duration < config.minDurationSeconds) {
    defects.push(
      defect({
        id: "very-short",
        severity: "warn",
        title: "Very short video",
        message: `Total duration is ${meta.duration.toFixed(2)}s.`,
        evidence: { durationSeconds: round(meta.duration, 3), floor: config.minDurationSeconds },
        hint: "If this was meant to be longer, the composition's durationInFrames is likely wrong.",
      }),
    );
  }

  if (v.rotation) {
    defects.push(
      defect({
        id: "rotation-metadata",
        severity: "warn",
        title: "Video relies on rotation metadata",
        message: `The stream is stored as ${v.width}x${v.height} with a ${v.rotation}° rotation flag, displaying as ${v.displayWidth}x${v.displayHeight}.`,
        evidence: {
          storedWidth: v.width,
          storedHeight: v.height,
          rotation: v.rotation,
          displayWidth: v.displayWidth,
          displayHeight: v.displayHeight,
        },
        hint:
          "Some players, encoders and platform uploaders ignore the rotation flag and show the video sideways. " +
          "Bake the rotation into the pixels instead.",
      }),
    );
  }

  // Bits per pixel per frame: a crude but effective proxy for compression damage.
  if (meta.bitrate && v.fps && v.displayWidth > 0 && v.displayHeight > 0) {
    const bpp = meta.bitrate / (v.displayWidth * v.displayHeight * v.fps);
    if (bpp < 0.02) {
      defects.push(
        defect({
          id: "over-compressed",
          severity: "warn",
          title: "Heavily compressed",
          message: `Bitrate works out to ${bpp.toFixed(4)} bits per pixel per frame; banding and blocking are likely.`,
          evidence: { bitsPerPixel: round(bpp, 5), bitrate: meta.bitrate, fps: round(v.fps, 3) },
          hint: "Raise the render bitrate or CRF quality. Text edges suffer first.",
        }),
      );
    }
  }

  if (v.codec && /^(?:h264|hevc|vp9|av1|vp8|mpeg4)$/i.test(v.codec) === false) {
    defects.push(
      defect({
        id: "unusual-codec",
        severity: "info",
        title: "Unusual video codec",
        message: `Video codec is \`${v.codec}\`.`,
        evidence: { codec: v.codec },
        hint: "Social platforms re-encode on upload; an exotic codec may be rejected or transcoded badly. H.264 is the safe default.",
      }),
    );
  }

  return defects;
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
