/**
 * Normalise ffprobe's JSON into the small shape the checks actually need.
 */

import { probeJson } from "./ffmpeg.mjs";

/**
 * Parse ffprobe rationals like `30000/1001` into a number.
 * @param {string|undefined} value
 * @returns {number|null}
 */
function parseRational(value) {
  if (!value || typeof value !== "string") return null;
  const [num, den] = value.split("/").map(Number);
  if (!Number.isFinite(num)) return null;
  if (den === undefined) return num;
  if (!Number.isFinite(den) || den === 0) return null;
  return num / den;
}

/** @param {string|undefined} value */
function parseNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read rotation from either the modern side-data form or the legacy tag.
 * @param {any} stream
 */
function readRotation(stream) {
  const direct = parseNumber(stream?.tags?.rotate);
  if (direct !== null) return ((direct % 360) + 360) % 360;

  const displayMatrix = stream?.side_data_list?.find(
    (d) => typeof d?.rotation === "number",
  );
  if (displayMatrix) {
    return ((Math.round(displayMatrix.rotation) % 360) + 360) % 360;
  }
  return 0;
}

/**
 * @typedef {object} MediaInfo
 * @property {string} input
 * @property {string|null} formatName
 * @property {number|null} duration      seconds
 * @property {number|null} sizeBytes
 * @property {number|null} bitrate       bits/second
 * @property {null|{
 *   codec: string, width: number, height: number, rotation: number,
 *   displayWidth: number, displayHeight: number,
 *   fps: number|null, nbFrames: number|null, pixFmt: string|null
 * }} video
 * @property {null|{
 *   codec: string, sampleRate: number|null, channels: number|null, channelLayout: string|null
 * }} audio
 * @property {any} raw
 */

/**
 * @param {string} input
 * @returns {Promise<MediaInfo>}
 */
export async function probeMedia(input) {
  const raw = await probeJson(input);
  const streams = Array.isArray(raw?.streams) ? raw.streams : [];

  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");

  const duration =
    parseNumber(raw?.format?.duration) ??
    (v ? parseNumber(v.duration) : null) ??
    (a ? parseNumber(a.duration) : null);

  let video = null;
  if (v) {
    const rotation = readRotation(v);
    const swapped = rotation === 90 || rotation === 270;
    const width = Number(v.width) || 0;
    const height = Number(v.height) || 0;
    video = {
      codec: String(v.codec_name ?? "unknown"),
      width,
      height,
      rotation,
      displayWidth: swapped ? height : width,
      displayHeight: swapped ? width : height,
      fps: parseRational(v.avg_frame_rate) ?? parseRational(v.r_frame_rate),
      nbFrames: parseNumber(v.nb_frames),
      pixFmt: v.pix_fmt ?? null,
    };
  }

  let audio = null;
  if (a) {
    audio = {
      codec: String(a.codec_name ?? "unknown"),
      sampleRate: parseNumber(a.sample_rate),
      channels: parseNumber(a.channels),
      channelLayout: a.channel_layout ?? null,
    };
  }

  return {
    input,
    formatName: raw?.format?.format_name ?? null,
    duration,
    sizeBytes: parseNumber(raw?.format?.size),
    bitrate: parseNumber(raw?.format?.bit_rate),
    video,
    audio,
    raw,
  };
}
