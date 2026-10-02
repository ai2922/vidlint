/**
 * Tests for the MCP stdio server.
 *
 * The handshake and tool listing are pure protocol, so they are cheap. One
 * round-trip through `lint_video` proves the tool wiring actually works.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { before, test } from "node:test";

import { ensureFixtures } from "./helpers/fixtures.mjs";

const SERVER = join(process.cwd(), "src", "mcp", "server.mjs");
const FIXTURES = join(process.cwd(), ".fixtures");

let fixtures;

before(() => {
  fixtures = ensureFixtures(FIXTURES);
}, { timeout: 180_000 });

/**
 * Start the server once, send a batch of requests, collect the replies.
 * @param {object[]} requests
 * @param {number} expected number of replies to wait for
 */
function converse(requests, expected) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });

    const replies = [];
    let buffer = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(
        new Error(`timed out after ${expected} replies (got ${replies.length})\nstderr:\n${stderr}`),
      );
    }, 150_000);

    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === "") continue;
        replies.push(JSON.parse(line));
        if (replies.length >= expected) {
          clearTimeout(timer);
          child.kill();
          resolvePromise(replies);
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });

    for (const request of requests) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }
  });
}

test("the server completes an MCP handshake", async () => {
  const [reply] = await converse(
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      },
    ],
    1,
  );

  assert.equal(reply.jsonrpc, "2.0");
  assert.equal(reply.id, 1);
  assert.equal(reply.result.serverInfo.name, "vidlint");
  assert.equal(reply.result.protocolVersion, "2025-06-18");
  assert.ok(reply.result.capabilities.tools);
});

test("the server echoes the client's requested protocol version", async () => {
  const [reply] = await converse(
    [{ jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2024-11-05" } }],
    1,
  );
  assert.equal(reply.result.protocolVersion, "2024-11-05");
});

test("tools/list advertises the three tools with input schemas", async () => {
  const [reply] = await converse([{ jsonrpc: "2.0", id: 2, method: "tools/list" }], 1);

  const names = reply.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["lint_video", "list_platforms", "list_rules"]);

  const lintTool = reply.result.tools.find((t) => t.name === "lint_video");
  assert.equal(lintTool.inputSchema.type, "object");
  assert.deepEqual(lintTool.inputSchema.required, ["path"]);
  assert.ok(lintTool.inputSchema.properties.platform.enum.includes("reels"));
});

test("list_rules returns the rule catalogue", async () => {
  const [reply] = await converse(
    [{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_rules", arguments: {} } }],
    1,
  );

  assert.equal(reply.result.isError, false);
  const text = reply.result.content[0].text;
  assert.match(text, /frozen-with-audio/);
  assert.match(text, /WCAG 2\.3\.1/);
});

test("list_platforms reports the presets and their caveat", async () => {
  const [reply] = await converse(
    [{ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_platforms", arguments: {} } }],
    1,
  );
  const text = reply.result.content[0].text;
  assert.match(text, /reels/);
  assert.match(text, /unverified/);
});

test("lint_video returns both a readable report and the structured JSON", { timeout: 150_000 }, async () => {
  const [reply] = await converse(
    [
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "lint_video", arguments: { path: fixtures.bad } },
      },
    ],
    1,
  );

  assert.equal(reply.result.isError, false, JSON.stringify(reply.result).slice(0, 800));

  const texts = reply.result.content.filter((c) => c.type === "text");
  assert.equal(texts.length, 2, "expected a human report and a JSON report");

  // The structured payload must survive the round trip intact.
  const report = JSON.parse(texts[1].text);
  assert.equal(report.schemaVersion, "1.0");
  assert.ok(report.defects.some((d) => d.id === "frozen-with-audio"));
  assert.deepEqual(reply.result.structuredContent.summary, report.summary);
});

test("lint_video reports a missing file as a tool error, not a crash", async () => {
  const [reply] = await converse(
    [
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "lint_video", arguments: { path: "definitely-not-here.mp4" } },
      },
    ],
    1,
  );

  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /No such file/);
});

test("an unknown method returns a JSON-RPC method-not-found error", async () => {
  const [reply] = await converse([{ jsonrpc: "2.0", id: 8, method: "does/not/exist" }], 1);
  assert.equal(reply.error.code, -32601);
});

test("malformed JSON yields a parse error rather than killing the server", async () => {
  const replies = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    const out = [];
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("timed out"));
    }, 30_000);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) out.push(JSON.parse(line));
      }
      if (out.length >= 2) {
        clearTimeout(timer);
        child.kill();
        resolvePromise(out);
      }
    });

    child.stdin.write("this is not json\n");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" })}\n`);
  });

  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies[1].result !== undefined, true, "server must keep serving after a parse error");
});
