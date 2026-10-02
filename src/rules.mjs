/**
 * The rule catalogue.
 *
 * Single source of truth for the rule ids vidlint can emit. The CLI, the MCP
 * server and the README all read from here so they cannot drift apart.
 */

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {string} title
 * @property {'error'|'warn'|'info'} severity   severity in the typical case
 * @property {string} summary
 * @property {string|null} reference             external standard this encodes, if any
 * @property {boolean} optIn
 */

/** @type {Rule[]} */
export const RULES = [
  {
    id: "blank-frames",
    title: "Blank frames",
    severity: "error",
    summary: "The picture is a single flat colour, so nothing is being rendered.",
    reference: null,
    optIn: false,
  },
  {
    id: "frozen-with-audio",
    title: "Picture frozen while audio continues",
    severity: "error",
    summary:
      "The frame does not change while there is still sound. This is the signature of a stalled render or a scene whose animation ended before its audio did. This audio-visual join is vidlint's headline rule.",
    reference: null,
    optIn: false,
  },
  {
    id: "dead-air",
    title: "Static shot / dead air",
    severity: "warn",
    summary:
      "The frame does not change for a sustained period. Classified against the audio track: in silence it is a held beat (info), otherwise it is dead air.",
    reference: null,
    optIn: false,
  },
  {
    id: "flash-risk",
    title: "Flash / strobe risk",
    severity: "error",
    summary:
      "More than three opposing relative-luminance changes of 10% or more per second, where the darker state is below 0.80 relative luminance and at least 25% of a 10-degree visual field changes.",
    reference: "WCAG 2.3.1 / ITU-R BT.1702 (EBU QC 0021B)",
    optIn: false,
  },
  {
    id: "mostly-static",
    title: "Video is mostly static",
    severity: "warn",
    summary: "Over 60% of the running time has almost no movement.",
    reference: null,
    optIn: false,
  },
  {
    id: "no-cuts",
    title: "Single unbroken shot",
    severity: "info",
    summary: "No scene change detected across a video of 20 seconds or more.",
    reference: null,
    optIn: false,
  },
  {
    id: "audio-gap",
    title: "Gap in the audio",
    severity: "warn",
    summary: "A long stretch where the audio drops below the silence threshold.",
    reference: null,
    optIn: false,
  },
  {
    id: "silent-audio-track",
    title: "Audio track is effectively silent",
    severity: "error",
    summary: "The audio stream carries nothing for essentially the whole video.",
    reference: null,
    optIn: false,
  },
  {
    id: "no-audio-track",
    title: "No audio track",
    severity: "warn",
    summary: "The file has no audio stream at all.",
    reference: null,
    optIn: false,
  },
  {
    id: "too-quiet",
    title: "Audio is too quiet",
    severity: "warn",
    summary: "Integrated loudness below the floor, so it will be inaudible on phone speakers.",
    reference: "EBU R128",
    optIn: false,
  },
  {
    id: "too-loud",
    title: "Audio is too loud",
    severity: "warn",
    summary: "Integrated loudness above the ceiling; platforms will attenuate it and it risks distortion.",
    reference: "EBU R128",
    optIn: false,
  },
  {
    id: "audio-clipping",
    title: "Audio clipping / hot true peak",
    severity: "warn",
    summary: "True peak reaches the ceiling, which is audible distortion.",
    reference: "EBU R128 (true peak)",
    optIn: false,
  },
  {
    id: "safe-area",
    title: "Content under a platform UI overlay",
    severity: "warn",
    summary:
      "A distinct high-contrast element sits in a region the platform draws its own chrome over. Heuristic; enabled by a platform preset.",
    reference: null,
    optIn: true,
  },
  {
    id: "edge-clipping",
    title: "Content at the frame edge",
    severity: "info",
    summary:
      "High-contrast structure in the outermost sliver of the frame, which may be clipped. Heuristic; enabled by --layout.",
    reference: null,
    optIn: true,
  },
  {
    id: "low-frame-rate",
    title: "Low frame rate",
    severity: "warn",
    summary: "The video runs below the frame-rate floor, so motion reads as a slideshow.",
    reference: null,
    optIn: false,
  },
  {
    id: "very-short",
    title: "Very short video",
    severity: "warn",
    summary: "Total duration is below the floor, which usually means durationInFrames is wrong.",
    reference: null,
    optIn: false,
  },
  {
    id: "rotation-metadata",
    title: "Video relies on rotation metadata",
    severity: "warn",
    summary:
      "The stream is stored sideways and depends on a rotation flag that some players and uploaders ignore.",
    reference: null,
    optIn: false,
  },
  {
    id: "over-compressed",
    title: "Heavily compressed",
    severity: "warn",
    summary: "Bits per pixel per frame is very low, so banding and blocking are likely.",
    reference: null,
    optIn: false,
  },
  {
    id: "unusual-codec",
    title: "Unusual video codec",
    severity: "info",
    summary: "An exotic codec may be rejected or badly transcoded on upload.",
    reference: null,
    optIn: false,
  },
  {
    id: "invalid-dimensions",
    title: "Invalid frame dimensions",
    severity: "error",
    summary: "The container reports a zero or nonsensical frame size.",
    reference: null,
    optIn: false,
  },
  {
    id: "no-video-stream",
    title: "No video stream",
    severity: "error",
    summary: "The file contains no decodable video stream.",
    reference: null,
    optIn: false,
  },
];

/** @param {string} id */
export function ruleById(id) {
  return RULES.find((r) => r.id === id) ?? null;
}
