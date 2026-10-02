#!/usr/bin/env node
/**
 * vidlint MCP server.
 *
 * Deliberately dependency-free: MCP's stdio transport is newline-delimited
 * JSON-RPC 2.0, which is a few dozen lines. Shipping without pulling in the SDK
 * keeps `npx vidlint-mcp` instant and keeps vidlint's "no dependencies"
 * property intact.
 *
 * Remotion deprecated their own official MCP server in favour of Agent Skills,
 * noting that agents do not reliably invoke MCP tools. So this server is a thin
 * adapter over the same CLI/JSON contract the Skill uses - not the primary
 * interface. Prefer the CLI when you have the choice.
 *
 * IMPORTANT: stdout carries protocol messages only. Every diagnostic goes to
 * stderr, or the client will fail to parse the stream.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { PLATFORM_PRESETS } from "../config.mjs";
import { lint, SCHEMA_VERSION, TOOL_VERSION } from "../lint.mjs";
import { renderText } from "../report.mjs";
import { RULES } from "../rules.mjs";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "vidlint";

/** @param {string} message */
function log(message) {
  process.stderr.write(`[vidlint-mcp] ${message}\n`);
}

const TOOLS = [
  {
    name: "lint_video",
    description:
      "Analyse a video file and return an objective defect report. Catches blank frames, a picture frozen while audio continues, dead air, " +
      "WCAG 2.3.1 flash/strobe risk, silent or clipped audio, wrong loudness, and container problems. " +
      "Returns the report as text plus the full JSON. Use this to check generated or rendered video before shipping it, " +
      "then fix each defect and re-run until the report is clean.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the video file to analyse. Relative paths resolve against the server's working directory.",
        },
        platform: {
          type: "string",
          enum: Object.keys(PLATFORM_PRESETS),
          description:
            "Safe-area preset. Anything other than 'none' enables the (heuristic) layout pass so content under platform UI chrome is reported.",
        },
        safeArea: {
          type: "object",
          description: "Explicit safe-area insets as fractions of frame width/height. Overrides `platform`.",
          properties: {
            top: { type: "number" },
            right: { type: "number" },
            bottom: { type: "number" },
            left: { type: "number" },
          },
          required: ["top", "right", "bottom", "left"],
          additionalProperties: false,
        },
        layout: {
          type: "boolean",
          description: "Also run the edge-clipping pixel heuristic. Off by default because it false-positives on busy full-bleed footage.",
        },
        temporalFps: {
          type: "number",
          description: "Temporal sampling rate for the time-based checks. Default 30.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_rules",
    description:
      "List every rule vidlint can report, with its id, default severity, what it means, and the external standard it encodes (if any).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_platforms",
    description:
      "List the safe-area presets and the fraction of the frame each one reserves. Note that only 'remotion' comes from a first-party source.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/**
 * @param {any} args
 */
async function callLintVideo(args) {
  const raw = args?.path;
  if (typeof raw !== "string" || raw.trim() === "") {
    return { isError: true, text: "`path` is required and must be a non-empty string." };
  }

  const path = resolve(raw);
  if (!existsSync(path)) {
    return { isError: true, text: `No such file: ${path}` };
  }
  if (!statSync(path).isFile()) {
    return { isError: true, text: `Not a file: ${path}` };
  }

  const options = {};
  if (typeof args.platform === "string") {
    if (!(args.platform in PLATFORM_PRESETS)) {
      return {
        isError: true,
        text: `Unknown platform preset \`${args.platform}\`. Known: ${Object.keys(PLATFORM_PRESETS).join(", ")}.`,
      };
    }
    options.platform = args.platform;
  }
  if (args.safeArea && typeof args.safeArea === "object") options.safeArea = args.safeArea;
  if (args.layout === true) options.checkEdgeClipping = true;
  if (typeof args.temporalFps === "number") options.temporalFps = args.temporalFps;

  const report = await lint(path, options);

  const summary =
    `${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ${report.summary.infos} info. ` +
    (report.summary.passed ? "Passed." : "FAILED - fix the errors below and re-run.");

  return {
    isError: false,
    report,
    summary,
    text: renderText(report, { color: false, verbose: true }),
  };
}

/**
 * @param {string} name
 * @param {any} args
 */
async function callTool(name, args) {
  switch (name) {
    case "lint_video":
      return callLintVideo(args);

    case "list_rules":
      return {
        isError: false,
        text: RULES.map(
          (r) =>
            `${r.id} [${r.severity}]${r.optIn ? " (opt-in)" : ""}\n    ${r.title}\n    ${r.summary}` +
            (r.reference ? `\n    reference: ${r.reference}` : ""),
        ).join("\n"),
      };

    case "list_platforms":
      return {
        isError: false,
        text: Object.entries(PLATFORM_PRESETS)
          .map(
            ([name, a]) =>
              `${name.padEnd(12)} top ${a.top}  right ${a.right}  bottom ${a.bottom}  left ${a.left}`,
          )
          .join("\n") +
          "\n\nOnly `remotion` derives from a first-party source. The per-platform presets are\n" +
          "community-reported and unverified - calibrate against a real device.",
      };

    default:
      return { isError: true, text: `Unknown tool: ${name}` };
  }
}

/** @param {any} message */
async function handle(message) {
  const { id, method, params } = message ?? {};

  // Notifications carry no id and must never be answered.
  const isNotification = id === undefined || id === null;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        // Echo the client's requested version when it asks for a string; the
        // transport surface here is deliberately small and version-stable.
        protocolVersion:
          typeof params?.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: TOOL_VERSION },
      },
    };
  }

  if (method === "notifications/initialized" || isNotification) return null;

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (method === "tools/call") {
    const name = params?.name;
    if (typeof name !== "string") {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: "`name` is required" } };
    }

    try {
      const outcome = await callTool(name, params?.arguments ?? {});
      /** @type {any[]} */
      const content = [];

      if (outcome.text) content.push({ type: "text", text: outcome.text });
      if (outcome.report) {
        content.push({ type: "text", text: JSON.stringify(outcome.report, null, 2) });
      }
      if (content.length === 0) content.push({ type: "text", text: "No output." });

      return {
        jsonrpc: "2.0",
        id,
        result: {
          content,
          isError: outcome.isError === true,
          ...(outcome.report ? { structuredContent: outcome.report } : {}),
        },
      };
    } catch (err) {
      // Tool failures are results, not protocol errors, so the model can read them.
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: `vidlint failed: ${err instanceof Error ? err.message : String(err)}${
                err && err.hint ? `\n\n${err.hint}` : ""
              }`,
            },
          ],
          isError: true,
        },
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function main() {
  log(`vidlint MCP server ${TOOL_VERSION} ready (schema ${SCHEMA_VERSION})`);

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    handle(message)
      .then((response) => {
        if (response) send(response);
      })
      .catch((err) => {
        log(`unhandled error: ${err && err.stack ? err.stack : err}`);
        if (message && message.id !== undefined && message.id !== null) {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: "Internal error" },
          });
        }
      });
  });

  rl.on("close", () => process.exit(0));
}

main();
