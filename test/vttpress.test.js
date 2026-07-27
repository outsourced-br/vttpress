"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  cuesToSegments,
  decodeFile,
  parseVtt,
  renderJson,
  renderMarkdown,
  renderText,
} = require("../lib/vttpress");

const packageRoot = path.resolve(__dirname, "..");
const sample = path.join(__dirname, "fixtures", "sample.vtt");

test("parses speakers and compacts rolling captions", () => {
  const cues = parseVtt(decodeFile(fs.readFileSync(sample)));
  const segments = cuesToSegments(cues);

  assert.equal(cues.length, 6);
  assert.deepEqual(
    segments.map((segment) => segment.speaker),
    ["Alice", "Bob", "Alice"],
  );
  assert.equal(
    segments[0].text,
    "Welcome & thanks everyone. Today we begin. With the roadmap.",
  );
  assert.equal(
    segments[1].text,
    "Great. I have one question. What ships first?",
  );
});

test("renders compact text, Markdown, and JSON", () => {
  const cues = parseVtt(decodeFile(fs.readFileSync(sample)));
  const segments = cuesToSegments(cues);
  const options = {
    noTitle: false,
    prettyJson: false,
    timestamps: "none",
  };
  const text = renderText(sample, segments, options);
  const markdown = renderMarkdown(sample, segments, {
    ...options,
    timestamps: "start",
  });
  const json = renderJson(sample, segments, options);

  assert.match(text, /Alice: Welcome & thanks/);
  assert.doesNotMatch(text, /-->/);
  assert.doesNotMatch(text, /\n\n\n/);
  assert.match(markdown, /\[00:00:01\] \*\*Alice:\*\*/);
  assert.deepEqual(JSON.parse(json).segments[1], {
    speaker: "Bob",
    text: "Great. I have one question. What ships first?",
  });
  assert.ok(Buffer.byteLength(text) < fs.statSync(sample).size);
});

test("CLI supports positional output and format inference", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vttpress-"));
  context.after(() => fs.rmSync(temporary, { force: true, recursive: true }));
  const output = path.join(temporary, "meeting.md");
  const result = spawnSync(
    process.execPath,
    [
      path.join(packageRoot, "bin", "vttpress.js"),
      sample,
      output,
      "--timestamps",
      "start",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), output);
  assert.match(fs.readFileSync(output, "utf8"), /^# Transcript:/);
});

test("CLI preserves nested paths during recursive batch conversion", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vttpress-batch-"));
  context.after(() => fs.rmSync(temporary, { force: true, recursive: true }));
  const input = path.join(temporary, "input");
  const nested = path.join(input, "nested");
  const output = path.join(temporary, "output");
  fs.mkdirSync(nested, { recursive: true });
  fs.copyFileSync(sample, path.join(nested, "meeting.vtt"));

  const result = spawnSync(
    process.execPath,
    [
      path.join(packageRoot, "bin", "vttpress.js"),
      input,
      output,
      "--recursive",
      "--format",
      "json",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(output, "nested", "meeting.json")));
});
