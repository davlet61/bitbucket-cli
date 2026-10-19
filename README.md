# Bitbucket CLI

Local Bitbucket Cloud repository and PR CLI. Bun + TypeScript, with a Hey API-generated fetch SDK.
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
bb repo create <workspace/repo> [--private | --public] [--project KEY]
    [--description <text>]
bb repo view [workspace/repo]
bb pr list [--state OPEN|MERGED|DECLINED|SUPERSEDED]
bb pr create --title <text> [--source <branch>] [--destination <branch>]
    [--description <text> | --description-file <path|->]
bb pr update <id> [--title <text>] [--destination <branch>]
    [--description <text> | --description-file <path|->]
bb pr open <id>
bb pr view <id>
bb pr diff <id>
bb pr comments <id> [--pending | --unresolved] [--author <name>]
bb pr comment add <id> --body <text> [--pending | --publish]
    [--file <path> --line <n> [--side old|new] | --reply-to <comment-id>]
bb pr comment pending <id>
bb pr comment update <id> <comment-id> --body <text>
bb pr comment publish <id> <comment-id>
bb pr comment resolve <id> <comment-id>
bb pr comment reopen <id> <comment-id>
```

All commands accept `--repo` / `-R workspace/repository` and `--json`.
Repository commands also accept a positional `workspace/repository`, but not
alongside `--repo`. Repository creation always requires an explicit target. For read/PR
commands without an explicit target, the repository is inferred from Git `origin`
(HTTPS, SCP-style SSH, or SSH URL on bitbucket.org).

Lists default to `OPEN` and follow all pages. JSON lists are arrays, not page
envelopes. JSON diffs are strings. Human output removes terminal escape sequences;
JSON preserves API data. Errors go to stderr with exit status 1.
Requests have a 30-second timeout per request; rate-limit errors report
`Retry-After` when present. There are no automatic retries.

### Creating, updating, and opening PRs

```sh
# Push the source branch before creating the PR.
bb pr create --title 'Handle empty results' --description-file description.md
bb pr create -R workspace/repository --source feature --destination main \
  --title 'Handle empty results' --description 'Return an empty list.' --json

bb pr update 123 --description-file description.md
printf '%s\n' '## Changes' '' '- Handle empty results' | bb pr update 123 --description-file -
bb pr update 123 --title 'Handle empty results safely' --destination release
bb pr update 123 --description ''

# Open an existing PR in the system browser.
bb pr open 123
```

Creation requires a title. `--source` defaults to the current Git branch;
outside a Git checkout or with a detached HEAD, supply it explicitly. Without
`--destination`, Bitbucket chooses the repository's main branch. These commands
do not push commits. Source and destination refer to branches in the selected
repository; cross-repository PR creation is not currently exposed.

Updates accept a title, description, or destination branch and send only supplied
fields. `--description-file` preserves Markdown and newlines; `-` reads stdin.
An empty description clears the existing text. Bitbucket permits updates only
while the PR is open. Concurrent edits to the same field can overwrite each other.

Write responses must confirm the PR ID, open state, and requested fields before
success is reported. Failed or ambiguous writes are never retried automatically;
inspect the PR before retrying creation to avoid duplicates. These operations use
the generated SDK and offline HTTP fixtures; they have not been live-verified.
API tokens need `read:pullrequest:bitbucket` and `write:pullrequest:bitbucket`;
OAuth/access tokens need corresponding PR write permissions. See the
[Bitbucket PR API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/).

`pr open` constructs the Bitbucket URL from the selected repository and PR ID;
it does not query the API or check whether the PR exists. It uses `xdg-open` on
Linux, `open` on macOS, or the Windows URL handler. `--json` returns `{ "url": … }`
after launching the browser. If launch fails, the error includes the URL.

### Repositories

```sh
bb repo create workspace/new-repository --private --project PROJECT_KEY
bb repo view workspace/new-repository --json
```

Creation defaults to **private**; publishing a public repository requires
`--public`. `--description` sets an optional description. `--project` accepts
a project key or UUID; without it, Bitbucket assigns the workspace's oldest
project. No project is created automatically by this CLI.

The target is checked first: an existing repository is never changed, and only
an HTTP 404 permits the creation request. A 404 can also hide an inaccessible
repository; any subsequent creation failure is reported without retrying. The
response must confirm the repository identity, Git SCM, privacy, and any supplied
project/description. On an error or unconfirmed response, inspect with `repo view`
before retrying: creation may already have succeeded. No automatic deletion or
visibility change is attempted.

These commands do not clone, initialize Git, change remotes, push commits, or
rename local directories. Repository creation requires repository administration
permission (`admin:repository:bitbucket` for API tokens); the preflight and view
also require repository read access. A repository-scoped token generally cannot
create a different repository. Use appropriately authorized account/workspace
credentials without placing them in arguments.

Implementation uses the checked-in generated SDK and is covered by offline HTTP
fixtures; repository creation has not yet been verified against a live workspace.
[Bitbucket repository API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-repositories/#api-repositories-workspace-repo-slug-post).

### Pending and published comments

```sh
# All new comments default to pending; --pending is optional and explicit.
bb pr comment add 123 --body 'Please handle this edge case.' --pending
bb pr comment add 123 --file src/file.ts --line 42 --body 'Check for null here.'
bb pr comment add 123 --file src/old.ts --line 8 --side old --body-file review.md
printf '%s\n' 'General review note' | bb pr comment add 123 --body-file -

# List pending comments returned by Bitbucket, across every page.
bb pr comment pending 123
bb pr comments 123 --pending --json

# Replace text without intentionally changing pending/published state or location.
bb pr comment update 123 456 --body 'Revised finding.'
bb pr comment update 123 456 --body-file review.md --json

# Publish one explicitly selected comment by its returned Bitbucket ID.
bb pr comment publish 123 456

# Post a visible comment or reply directly, without a draft.
bb pr comment add 123 --reply-to 456 --body-file reply.md --publish
```

`--file` is the path in the PR, not a local file to read. `--line` is a positive,
one-based diff line number. The new side is the default; use `--side old` for
removed lines. General comments omit both flags. `--body-file` preserves Markdown
and newlines; `-` reads stdin. Empty bodies and incompatible options are rejected.

Creation sends `pending: true` unless `--publish` is given; then `pending` is
omitted and Bitbucket creates a published comment. Bitbucket rejects any change
to `pending` on PUT (`pending: extra keys not allowed`), so publication reads the
draft, re-creates it as published with the same text, inline anchor and parent,
and then deletes the draft. The published comment gets a new ID, which is printed.
If deleting the draft fails, the error names both IDs. An already published
comment is left alone. Deleted comments or unknown pending state are rejected.
There is no publish-all operation, approval, or automatic review submission.

Updates accept exactly one of `--body` or `--body-file` (including `-` for stdin).
They read the current comment, then send only the replacement `content.raw`.
Bitbucket rejects `pending` in text-update requests (`extra keys not allowed`),
so state is checked in the response rather than included in the PUT body.
No discriminator or inline anchor is sent. `--pending`,
`--file`, `--line`, and `--side` are rejected on updates; publication is a separate
command. The response must confirm the comment ID, text, and unchanged publication
state. Editing an already-published comment changes its visible text immediately.
Updates are read-then-write, not atomic against concurrent edits/publication;
avoid editing the same comment from multiple sessions at once.

**Important:** the [API documentation](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/)
includes `pending` in comment POST/PUT schemas, but does not document publication
or a batch publish-review endpoint. Live behavior: POST rejects `type`
(`extra keys not allowed`); POST with `pending: true` creates a draft; POST without
`pending` creates a published comment; PUT rejects `pending`. Listing filters the
comments the API returns; it does not guarantee every web-UI draft is exposed.

The CLI requires the expected pending state in write responses before reporting
success. If Bitbucket ignores pending on creation, the comment may already be
public; an error cannot undo that. Inspect the PR on any ambiguous result before
retrying creation. Writes are never automatically retried or deleted.

The current comment POST/PUT documentation lists `read:pullrequest:bitbucket` for
API tokens, even though these are writes. Broader future approval/request-changes
workflows require `write:pullrequest:bitbucket` as well.

### Filtering comments

```sh
# Comments in threads that are still open, including their replies.
bb pr comments 123 --unresolved

# Comments by one reviewer: display name or nickname substring, or exact account id/uuid.
bb pr comments 123 --author nemanja --unresolved --json
```

The comment list always returns `resolution: null`, so `bb pr comments` reads each
thread's top-level comment to report real resolved status (one request per thread).
`--pending` lists drafts only and skips these lookups.

### Threads: replies, resolve, reopen

```sh
# Reply to an existing thread; the reply inherits the parent's file/line anchor.
bb pr comment add 123 --reply-to 456 --body 'Fixed - handled the empty case.'
bb pr comment publish 123 789

# Resolve or reopen a thread by its top-level comment ID.
bb pr comment resolve 123 456
bb pr comment reopen 123 456
```

Replies send `parent: {id}` and default to pending like any new comment.
`--reply-to` cannot be combined with `--file`/`--line`. Resolve and reopen first
read the comment: deleted comments are rejected, and a thread already in the
requested state is left alone, so reruns are safe. Otherwise they call
`POST`/`DELETE …/comments/{id}/resolve`. Failures are reported, never retried.

Live-verified on 2026-09-30: published replies with `parent` (HTTP 201),
resolution (200), and the 409 `Comment has already been resolved.` returned for
an already-resolved thread. Pending replies and reopen are not yet live-verified.

### Use from other repositories

The executable source can be called directly:

```sh
/path/to/bitbucket-cli/src/cli.ts pr list
```

Optional standalone binary (for the current platform):

```sh
bun run build
./dist/bb --help

# Build and install/update ~/.local/bin/bb (ensure ~/.local/bin is on PATH).
bun run install:local
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
- `src/comments.ts`: comment input validation, pending creation, text updates, and publication.
- `src/repositories.ts`: private-by-default creation, existing-repository guard, and write-response checks.
- `src/pullrequests.ts`: PR creation, field updates, branch inference, and browser opening.
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
has an index signature. The same module omits the response discriminator `type`
from writes: the live create endpoint rejects it, although the generated request
schema requires it. Type assertions are confined to the SDK calls; generated
files and the upstream spec are not hand-edited.

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

Live verification of text updates, publication, and draft privacy on an explicitly
selected test PR, then approval and request-changes workflows. Pending creation
and read-back have been verified; the diagnostic comment was left pending.
