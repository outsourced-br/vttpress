"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const TIMING_RE =
  /^\s*((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})(?:\s+.*)?$/;
const VOICE_RE = /<v(?:\.[^ >]+)*\s+([^>]+)>/i;
const VOICE_GLOBAL_RE = /<v(?:\.[^ >]+)*\s+[^>]+>/gi;
const TAG_RE = /<[^>]+>/g;
const SPEAKER_RE = /^\s*(?:>>\s*)?([^\n:]{1,80}?):\s+([\s\S]+)$/;

function decodeHtml(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
    (match, decimal, hexadecimal, name) => {
      if (decimal || hexadecimal) {
        const number = Number.parseInt(decimal || hexadecimal, hexadecimal ? 16 : 10);
        try {
          return String.fromCodePoint(number);
        } catch {
          return match;
        }
      }
      return named[name.toLowerCase()] ?? match;
    },
  );
}

function decodeFile(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer);
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1252").decode(buffer);
  }
}

function cleanCaption(raw) {
  const withoutInvisible = raw.replace(/[\u200b\ufeff]/g, "");
  const voice = VOICE_RE.exec(withoutInvisible);
  let speaker = voice ? decodeHtml(voice[1]).trim() : null;
  let text = withoutInvisible
    .replace(VOICE_GLOBAL_RE, "")
    .replace(TAG_RE, "");
  text = decodeHtml(text).replace(/\s+/g, " ").trim();

  if (!speaker) {
    const match = SPEAKER_RE.exec(text);
    if (match) {
      const candidate = match[1].trim();
      const isPlausibleSpeaker =
        !/^\d{1,3}$/.test(candidate) &&
        !candidate.includes("://") &&
        candidate.split(/\s+/).length <= 8;
      if (isPlausibleSpeaker) {
        speaker = candidate;
        text = match[2].trim();
      }
    }
  }

  if (speaker) {
    speaker = speaker.replace(/\s+/g, " ").replace(/^[\s-]+|[\s:-]+$/g, "");
  }
  return { speaker: speaker || null, text };
}

function normalizedToken(token) {
  return token
    .replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, "")
    .toLocaleLowerCase();
}

function appendWithoutOverlap(existing, incoming) {
  const oldWords = existing.match(/\S+/g) || [];
  const newWords = incoming.match(/\S+/g) || [];
  const oldNormalized = oldWords.map(normalizedToken);
  const newNormalized = newWords.map(normalizedToken);

  if (oldWords.length === 0) return incoming;
  if (newWords.length === 0) return existing;
  if (
    oldNormalized.length === newNormalized.length &&
    oldNormalized.every((word, index) => word === newNormalized[index])
  ) {
    return existing;
  }

  const maximum = Math.min(oldWords.length, newWords.length, 80);
  for (let size = maximum; size > 0; size -= 1) {
    const oldSuffix = oldNormalized.slice(-size);
    const newPrefix = newNormalized.slice(0, size);
    if (oldSuffix.every((word, index) => word === newPrefix[index])) {
      if (size === newWords.length) return existing;
      return `${existing} ${newWords.slice(size).join(" ")}`.trim();
    }
  }

  if (newNormalized.length >= 3) {
    const window = oldNormalized.slice(-80);
    for (
      let offset = 0;
      offset <= window.length - newNormalized.length;
      offset += 1
    ) {
      const matches = newNormalized.every(
        (word, index) => word === window[offset + index],
      );
      if (matches) return existing;
    }
  }

  return `${existing} ${incoming}`.trim();
}

function parseVtt(content) {
  const lines = content
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const cues = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    const upper = line.toUpperCase();
    if (!line || upper.startsWith("WEBVTT")) {
      index += 1;
      continue;
    }
    if (
      upper.startsWith("NOTE") ||
      upper.startsWith("STYLE") ||
      upper.startsWith("REGION")
    ) {
      index += 1;
      while (index < lines.length && lines[index].trim()) index += 1;
      continue;
    }

    let timing = TIMING_RE.exec(line);
    if (!timing && index + 1 < lines.length) {
      timing = TIMING_RE.exec(lines[index + 1].trim());
      if (timing) index += 1;
    }
    if (!timing) {
      index += 1;
      continue;
    }

    const start = timing[1];
    const end = timing[2];
    index += 1;
    const payload = [];
    while (index < lines.length && lines[index].trim()) {
      payload.push(lines[index].trim());
      index += 1;
    }

    let speaker = null;
    let text = "";
    for (const payloadLine of payload) {
      const cleaned = cleanCaption(payloadLine);
      speaker ||= cleaned.speaker;
      text = appendWithoutOverlap(text, cleaned.text);
    }
    if (text) cues.push({ start, end, speaker, text });
  }

  return cues;
}

function cuesToSegments(cues, stripSpeakers = false) {
  const segments = [];
  for (const cue of cues) {
    const speaker = stripSpeakers ? null : cue.speaker;
    const previous = segments.at(-1);
    if (previous && previous.speaker === speaker) {
      previous.text = appendWithoutOverlap(previous.text, cue.text);
      previous.end = cue.end;
    } else {
      segments.push({ ...cue, speaker });
    }
  }
  return segments;
}

function displayTime(value) {
  const withoutMilliseconds = value.replace(",", ".").split(".", 1)[0];
  const parts = withoutMilliseconds.split(":");
  return parts.length === 2
    ? `00:${withoutMilliseconds}`
    : withoutMilliseconds.padStart(8, "0");
}

function timeLabel(segment, timestamps) {
  if (timestamps === "start") return `[${displayTime(segment.start)}] `;
  if (timestamps === "range") {
    return `[${displayTime(segment.start)}–${displayTime(segment.end)}] `;
  }
  return "";
}

function renderText(source, segments, options) {
  const blocks = [];
  if (!options.noTitle) blocks.push(`Transcript: ${path.parse(source).name}`);
  for (const segment of segments) {
    const speaker = segment.speaker ? `${segment.speaker}: ` : "";
    blocks.push(`${timeLabel(segment, options.timestamps)}${speaker}${segment.text}`);
  }
  return `${blocks.join("\n\n").trim()}\n`;
}

function renderMarkdown(source, segments, options) {
  const blocks = [];
  if (!options.noTitle) blocks.push(`# Transcript: ${path.parse(source).name}`);
  for (const segment of segments) {
    const speaker = segment.speaker ? `**${segment.speaker}:** ` : "";
    blocks.push(`${timeLabel(segment, options.timestamps)}${speaker}${segment.text}`);
  }
  return `${blocks.join("\n\n").trim()}\n`;
}

function renderJson(source, segments, options) {
  const renderedSegments = segments.map((segment) => {
    const item = {};
    if (options.timestamps === "start" || options.timestamps === "range") {
      item.start = displayTime(segment.start);
    }
    if (options.timestamps === "range") item.end = displayTime(segment.end);
    if (segment.speaker) item.speaker = segment.speaker;
    item.text = segment.text;
    return item;
  });
  return `${JSON.stringify(
    { source: path.basename(source), segments: renderedSegments },
    null,
    options.prettyJson ? 2 : 0,
  )}\n`;
}

function render(source, segments, format, options) {
  if (format === "md") return renderMarkdown(source, segments, options);
  if (format === "json") return renderJson(source, segments, options);
  return renderText(source, segments, options);
}

function walkVttFiles(directory, recursive) {
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory() && recursive) {
      results.push(...walkVttFiles(candidate, true));
    } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".vtt") {
      results.push(path.resolve(candidate));
    }
  }
  return results;
}

function discoverInputs(input, recursive) {
  if (!fs.existsSync(input)) throw new Error(`Input does not exist: ${input}`);
  const stats = fs.statSync(input);
  if (stats.isFile()) {
    if (path.extname(input).toLowerCase() !== ".vtt") {
      throw new Error(`Input is not a .vtt file: ${input}`);
    }
    return { kind: "file", sources: [path.resolve(input)] };
  }
  if (!stats.isDirectory()) throw new Error(`Unsupported input: ${input}`);
  const sources = walkVttFiles(path.resolve(input), recursive).sort((a, b) =>
    a.localeCompare(b),
  );
  if (sources.length === 0) throw new Error(`No .vtt files found in ${input}`);
  return { kind: "directory", sources };
}

function formatFromOutput(output) {
  const extension = path.extname(output || "").toLowerCase();
  if (extension === ".md") return "md";
  if (extension === ".json") return "json";
  if (extension === ".txt") return "txt";
  return null;
}

function extensionFor(format) {
  return { json: ".json", md: ".md", txt: ".txt" }[format];
}

function parseArgs(argv) {
  const options = {
    format: null,
    noTitle: false,
    overwrite: false,
    prettyJson: false,
    recursive: false,
    stripSpeakers: false,
    timestamps: "none",
  };
  const positional = [];
  let parseOptions = true;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (parseOptions && argument === "--") {
      parseOptions = false;
      continue;
    }
    if (!parseOptions || !argument.startsWith("-") || argument === "-") {
      positional.push(argument);
      continue;
    }
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "-v" || argument === "--version") options.version = true;
    else if (argument === "--strip-speakers") options.stripSpeakers = true;
    else if (argument === "--no-title") options.noTitle = true;
    else if (argument === "-r" || argument === "--recursive") options.recursive = true;
    else if (argument === "--pretty-json") options.prettyJson = true;
    else if (argument === "--overwrite") options.overwrite = true;
    else if (argument === "-f" || argument === "--format") {
      options.format = argv[++index];
      if (!options.format) throw new Error(`${argument} requires a value`);
    } else if (argument.startsWith("--format=")) {
      options.format = argument.slice("--format=".length);
    } else if (argument === "-t" || argument === "--timestamps") {
      options.timestamps = argv[++index];
      if (!options.timestamps) throw new Error(`${argument} requires a value`);
    } else if (argument.startsWith("--timestamps=")) {
      options.timestamps = argument.slice("--timestamps=".length);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (options.format && !["txt", "md", "json"].includes(options.format)) {
    throw new Error("--format must be txt, md, or json");
  }
  if (!["none", "start", "range"].includes(options.timestamps)) {
    throw new Error("--timestamps must be none, start, or range");
  }
  return { options, positional };
}

const HELP = `Usage: vttpress <input> [output] [options]

Compress WebVTT captions into an AI-ready transcript.

Arguments:
  input                         .vtt file or directory
  output                        output file, or directory for batch input

Options:
  -f, --format <txt|md|json>    output format (default: infer or txt)
  -t, --timestamps <mode>       none, start, or range (default: none)
      --strip-speakers          remove detected speaker names
      --no-title                omit the transcript title
  -r, --recursive               search input directories recursively
      --pretty-json             indent JSON output
      --overwrite               replace existing output files
  -v, --version                 show the version
  -h, --help                    show this help

Examples:
  npx vttpress meeting.vtt meeting.txt
  npx vttpress meeting.vtt meeting.md --timestamps start
  npx vttpress captions transcripts --recursive --format json
`;

function planOutputs(discovered, input, output, format) {
  if (discovered.kind === "file") {
    const source = discovered.sources[0];
    const destination =
      output ||
      path.join(path.dirname(source), `${path.parse(source).name}${extensionFor(format)}`);
    return [{ source, destination: path.resolve(destination) }];
  }

  const outputDirectory =
    output || path.join(path.dirname(path.resolve(input)), `${path.basename(input)}-transcripts`);
  return discovered.sources.map((source) => {
    const relative = path.relative(path.resolve(input), source);
    const destination = path.resolve(
      outputDirectory,
      path.dirname(relative),
      `${path.parse(relative).name}${extensionFor(format)}`,
    );
    return { source, destination };
  });
}

function convert(input, output, options) {
  const discovered = discoverInputs(input, options.recursive);
  const format = options.format || formatFromOutput(output) || "txt";
  const plans = planOutputs(discovered, input, output, format);
  const caseFold = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const destinations = new Set();

  for (const plan of plans) {
    const key = caseFold(plan.destination);
    if (destinations.has(key)) {
      throw new Error(`Multiple inputs resolve to ${plan.destination}`);
    }
    destinations.add(key);
    if (fs.existsSync(plan.destination) && !options.overwrite) {
      throw new Error(
        `Output already exists: ${plan.destination} (use --overwrite)`,
      );
    }
  }

  for (const plan of plans) {
    const content = decodeFile(fs.readFileSync(plan.source));
    const cues = parseVtt(content);
    if (cues.length === 0) {
      throw new Error(`No caption cues found in ${plan.source}`);
    }
    const segments = cuesToSegments(cues, options.stripSpeakers);
    fs.mkdirSync(path.dirname(plan.destination), { recursive: true });
    fs.writeFileSync(
      plan.destination,
      render(plan.source, segments, format, options),
      "utf8",
    );
  }
  return plans.map((plan) => plan.destination);
}

function runCli(argv, metadata = {}) {
  try {
    const { options, positional } = parseArgs(argv);
    if (options.help) {
      process.stdout.write(HELP);
      return 0;
    }
    if (options.version) {
      process.stdout.write(`${metadata.version || "0.0.0"}\n`);
      return 0;
    }
    if (positional.length < 1 || positional.length > 2) {
      throw new Error("Expected <input> and optional [output]");
    }
    const created = convert(positional[0], positional[1], options);
    for (const destination of created) process.stdout.write(`${destination}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`vttpress: ${error.message}\n`);
    return 1;
  }
}

module.exports = {
  HELP,
  appendWithoutOverlap,
  cleanCaption,
  convert,
  cuesToSegments,
  decodeFile,
  parseArgs,
  parseVtt,
  renderJson,
  renderMarkdown,
  renderText,
  runCli,
};
