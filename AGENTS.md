# Agent guide

This file applies to the entire repository and is intended for any coding agent.

## Project

Bitbucket Cloud CLI written in strict TypeScript, using Bun and a checked-in
Hey API fetch SDK. The executable is `bb`. There are no runtime dependencies,
database, or background services. See `README.md` for command behavior and known
differences between the API specification and live Bitbucket behavior.

## Commands

Run commands from the repository root:

```sh
bun install --frozen-lockfile  # Install dependencies when needed
bun run bb --help             # Run the CLI from source
bun run typecheck            # Typecheck all TypeScript
bun test                     # Run offline tests
bun run check                # Typecheck and run tests
bun run build                # Compile the standalone binary to dist/bb
bun run generate             # Regenerate the SDK from the local spec
```

Use Bun for package management, scripts, and tests. Versions are pinned in
`package.json` and `bun.lock`. The root compiler is TypeScript 7.0.2. The generator
workspace uses TypeScript 5.9.3 because Hey API requires the legacy compiler API.
Preserve Bun's isolated linker configuration in `bunfig.toml`; do not collapse the
two compiler dependencies into one.

## Code map

- `src/cli.ts`: argument parsing, command routing, and terminal/JSON output.
- `src/config.ts`: environment authentication and Bitbucket Git origin inference.
- `src/api.ts`: fetch client configuration, errors, timeouts, and pagination.
- `src/comments.ts`: comment validation, pending/published lifecycle, and threads.
- `src/repositories.ts`: repository creation and response verification.
- `src/pullrequests.ts`: PR creation, field updates, branch inference, and browser opening.
- `src/generated/`: generated SDK, client, and API types; do not hand-edit.
- `openapi/bitbucket.json`: upstream specification snapshot.
- `tools/openapi/`: isolated generator workspace and its configuration.
- `tests/cli.test.ts`: offline tests exercising the CLI through the generated SDK.

## Implementation conventions

- Follow the existing style: ES modules, explicit `.ts` import extensions, single
  quotes, semicolons, two-space indentation, and `import type` for type imports.
- Keep domain behavior in handwritten modules and reuse the generated SDK for API
  requests. Configure authentication centrally in `src/api.ts` and `src/config.ts`.
- Validate arguments and incompatible options before making requests. Reject
  unsupported flags rather than silently ignoring them.
- Send only the fields required for a write. Updates must not resend unrelated
  response fields or overwrite fields the caller did not supply.
- Keep schema workarounds and type assertions at the SDK boundary. Explain known
  spec/API mismatches in a comment; do not weaken generated types globally.
- Do not automatically retry writes. Verify returned identities and requested
  state before reporting success. Ambiguous failures should tell the caller how
  to inspect the result before retrying.
- Keep comment creation pending by default. Publication is an explicit action;
  preserve the documented re-create-and-delete workflow and partial-failure reporting.
- Preserve repository creation's private default and existing-repository guard.
- Keep JSON output machine-readable and preserve API content. Sanitize remote
  content in human-readable terminal output. Errors go to stderr with exit code 1.
- Follow all list pages. Preserve pagination checks that prevent credentials from
  being forwarded to untrusted URLs and stop repeated pagination URLs.
- Invoke Git and browser commands with executable/argument arrays, without shell
  interpolation of user input.
- Keep the CLI free of implicit Git pushes, remote changes, or local installation
  as side effects of repository/PR commands.

## Generated code

Normal builds and tests use the checked-in SDK and do not fetch a remote spec.
To change generation, edit `tools/openapi/openapi-ts.config.ts` and run
`bun run generate`. Updating the upstream snapshot is a separate, intentional
operation; the README documents it. Review the spec and generated diff together,
and include related handwritten changes. Do not regenerate merely to work around
a live API discrepancy already handled in an adapter.

## Verification and credentials

- Run `bun run check` after code changes. Run `bun run build` when changing CLI
  entry points, runtime imports, or standalone executable behavior.
- Add focused offline regression tests for changed behavior, using mocked HTTP
  through the actual generated SDK. Cover request bodies, validation, failures,
  and response checks for new write operations.
- Keep tests independent of real credentials, a network connection, and the
  developer's Git origin. Restore mocked globals and environment variables, and
  clean up temporary files.
- Treat `.env` and authentication values as secrets. Do not print, commit, or
  include them in command arguments, fixtures, or error messages.
- A feature implementation request does not by itself select a live Bitbucket
  target for testing writes. Use offline fixtures unless live testing has been
  authorized for a specific repository/PR and action. Clearly distinguish offline
  coverage from live verification when reporting results.
- Update CLI help and `README.md` when changing commands, flags, defaults, or
  externally visible behavior.
- Preserve unrelated uncommitted work. Keep generated artifacts and dependency
  changes scoped to the task. `dist/` is ignored; building does not update an
  already installed `bb` executable.
