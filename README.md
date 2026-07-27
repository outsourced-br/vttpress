# vttpress

Compress WebVTT captions into clean transcripts for Claude, ChatGPT,
Microsoft 365 Copilot, and other language models.

`vttpress` removes cue identifiers, timestamps, styling, HTML caption tags,
and repeated rolling-caption fragments while preserving speaker turns.
Processing happens locally and the package has no runtime dependencies.

## Run without installing

```sh
npx vttpress meeting.vtt meeting.txt
```

The output argument is optional. Without it, `vttpress` writes a `.txt` file
beside the input:

```sh
npx vttpress meeting.vtt
```

The output extension selects `txt`, `md`, or `json`. You can also choose the
format explicitly:

```sh
npx vttpress meeting.vtt meeting.md --timestamps start
npx vttpress meeting.vtt meeting.json --pretty-json
npx vttpress captions transcripts --recursive --format txt
```

## Options

```text
-f, --format <txt|md|json>    Output format (default: infer or txt)
-t, --timestamps <mode>       none, start, or range (default: none)
    --strip-speakers          Remove detected speaker names
    --no-title                Omit the transcript title
-r, --recursive               Search input directories recursively
    --pretty-json             Indent JSON output
    --overwrite               Replace existing output files
-v, --version                 Show the version
-h, --help                    Show help
```

Node.js 18 or newer is required.

## Development

```sh
npm ci
npm test
```

## Publishing

Releases are published by `.github/workflows/publish.yml` when a version tag
such as `v0.1.0` is pushed. The workflow verifies that the tag matches the
version in `package.json`, runs the test suite, and publishes to npm.

Use npm trusted publishing after the package exists:

1. Open the `vttpress` package settings on npm.
2. Add a GitHub Actions trusted publisher.
3. Set the GitHub owner to `outsourced-br`, repository to `vttpress`, workflow
   filename to `publish.yml`, and allow `npm publish`.
4. Bump the package version, commit it, and push the matching `vX.Y.Z` tag.

For the first release, either publish once from an authenticated local npm
session or add an npm automation token as the `NPM_TOKEN` GitHub Actions
secret. After trusted publishing is configured, the token can be removed.
