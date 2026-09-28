# Bitbucket CLI

Local Bitbucket Cloud PR CLI. Bun + TypeScript, with a Hey API-generated fetch SDK.
No runtime dependencies, database, or background service.

## Start

Tested with Bun 1.4.2. Bun is the package manager and runtime.

```sh
bun install --frozen-lockfile
bun run bb --help
bun run bb pr list --repo workspace/repository
bun run bb pr view 123 --repo workspace/repository --json
bun run bb pr diff 123 --repo workspace/repository
bun run bb pr comments 123 --repo workspace/repository
```

For private repositories, export credentials in your shell or copy `.env.example`
to `.env` and fill it in locally. Never commit credentials.

- `BITBUCKET_EMAIL` + `BITBUCKET_API_TOKEN`: Atlassian account email and a Bitbucket Cloud API token with repository/PR read permissions.
- **Or** `BITBUCKET_ACCESS_TOKEN`: a Bitbucket access token or OAuth access token with the appropriate read permissions.
- No credentials means anonymous access to public repositories.
- Mixed or incomplete authentication configuration is rejected.

Bun loads `.env` from the working directory. For use across repositories, export
credentials in the calling shell; the CLI does not maintain a credential store.

## Commands

```text
bb pr list [--state OPEN|MERGED|DECLINED|SUPERSEDED]
bb pr view <id>
bb pr diff <id>
bb pr comments <id> [--pending]
bb pr comment add <id> --body <text> [--pending]
    [--file <path> --line <n> [--side old|new]]
bb pr comment pending <id>
bb pr comment publish <id> <comment-id>
```

All commands accept `--repo` / `-R workspace/repository` and `--json`.
Without `--repo`, the repository is inferred from the current Git `origin`
(HTTPS, SCP-style SSH, or SSH URL on bitbucket.org).

Lists default to `OPEN` and follow all pages. JSON lists are arrays, not page
envelopes. JSON diffs are strings. Human output removes terminal escape sequences;
JSON preserves API data. Errors go to stderr with exit status 1.
Requests have a 30-second timeout per request; rate-limit errors report
`Retry-After` when present. There are no automatic retries.

### Pending comments (live verification still needed)

```sh
# All new comments default to pending; --pending is optional and explicit.
bb pr comment add 123 --body 'Please handle this edge case.' --pending
bb pr comment add 123 --file src/file.ts --line 42 --body 'Check for null here.'
bb pr comment add 123 --file src/old.ts --line 8 --side old --body-file review.md
printf '%s\n' 'General review note' | bb pr comment add 123 --body-file -

# List pending comments returned by Bitbucket, across every page.
bb pr comment pending 123
bb pr comments 123 --pending --json

# Publish one explicitly selected comment by its returned Bitbucket ID.
bb pr comment publish 123 456
```

`--file` is the path in the PR, not a local file to read. `--line` is a positive,
one-based diff line number. The new side is the default; use `--side old` for
removed lines. General comments omit both flags. `--body-file` preserves Markdown
and newlines; `-` reads stdin. Empty bodies and incompatible options are rejected.

Creation sends `pending: true`. Publication first reads the selected comment,
then updates only `pending: false`, preserving content and anchors. An already
published comment is left alone. Deleted comments or unknown pending state are
rejected. There is no publish-all operation, approval, or automatic review submission.

**Important:** the [API documentation](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/)
includes `pending` in comment POST/PUT schemas, but does not explain publication
semantics or document a batch publish-review endpoint. These workflows are tested
with mocked HTTP, **not a live PR**. Verify draft privacy, listing visibility, and
publication on a test PR before relying on them. Listing filters the comments the
API returns; it does not guarantee every web-UI draft is exposed.

The CLI requires the expected pending state in write responses before reporting
success. If Bitbucket ignores pending on creation, the comment may already be
public; an error cannot undo that. Inspect the PR on any ambiguous result before
retrying creation. Writes are never automatically retried or deleted.

The current comment POST/PUT documentation lists `read:pullrequest:bitbucket` for
API tokens, even though these are writes. Broader future approval/request-changes
workflows require `write:pullrequest:bitbucket` as well.

### Use from other repositories

The executable source can be called directly:

```sh
/path/to/bitbucket-cli/src/cli.ts pr list
```

Optional standalone binary (for the current platform):

```sh
bun run build
./dist/bb --help
# Optionally install dist/bb into a directory on your PATH.
```

## Development

```sh
bun run check       # Typecheck handwritten and generated code, then offline tests
bun run generate    # Explicit regeneration from the checked-in spec; no network
bun run build       # Optional standalone binary; not needed for development
```

- `openapi/bitbucket.json`: unmodified upstream specification snapshot.
- `tools/openapi/`: isolated Hey API generator workspace and `openapi-ts.config.ts`.
- `src/generated/`: checked-in generated types, SDK functions, and fetch client; never hand-edit.
- `src/config.ts`: authentication and Git remote inference.
- `src/api.ts`: client configuration, errors, and guarded pagination.
- `src/comments.ts`: pending-comment input validation, creation, and publication.
- `src/cli.ts`: argument handling, SDK calls, and output.
- `tests/cli.test.ts`: offline checks through the actual generated SDK with mocked HTTP.

**Typechecking uses stable native TypeScript 7.0.2 (`tsc`)**, from the regular
`typescript` package; no native-preview package is needed. `bun run typecheck` and
`bun run check` use that compiler. Bun handles builds.

Hey API 0.99.0 still needs the legacy JavaScript compiler API (`ts.SyntaxKind`).
Its dependency on TypeScript **5.9.3** is confined to the `tools/openapi` workspace.
Bun's isolated linker keeps the two compilers separate, with one root `bun.lock`
and one `bun install`. `bun run generate` runs in that workspace using the local
spec snapshot; generation itself requires no network.

The comment adapter restores inherited fields from the generated `Comment` type:
the generated `Omit<Comment, 'type'>` loses named properties because that schema
has an index signature. This workaround is local to `src/comments.ts`.

### Update the specification

Source: <https://dac-static.atlassian.com/cloud/bitbucket/swagger.v3.json?_v=2.300.194>

```sh
curl --fail --location \
  'https://dac-static.atlassian.com/cloud/bitbucket/swagger.v3.json?_v=2.300.194' \
  --output openapi/bitbucket.json
bun run generate
bun run check
git diff -- openapi src/generated
```

Review and commit the spec, generated output, and any related handwritten changes
together. Do not fetch a moving remote spec during builds. Upgrade generator
versions explicitly and keep `bun.lock` in Git.

## Next slice

Live verification of pending comments on an explicitly selected test PR, then
approval and request-changes workflows. No live authenticated writes have been
performed during implementation.
