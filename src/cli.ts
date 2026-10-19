#!/usr/bin/env bun
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { collectPages, createBitbucketClient } from './api.ts';
import { resolveRepository } from './config.ts';
import { createRepository } from './repositories.ts';
import { openPullrequest, pullrequestChanges, writePullrequest } from './pullrequests.ts';
import {
  addComment,
  commentBody,
  positiveId,
  publishComment,
  readCommentBody,
  reopenComment,
  resolveComment,
  threadRootId,
  updateComment,
  withThreadResolution,
  type ReviewComment,
} from './comments.ts';
import {
  getRepositoriesByWorkspaceByRepoSlug as getRepository,
  getRepositoriesByWorkspaceByRepoSlugPullrequests as listPullrequests,
  getRepositoriesByWorkspaceByRepoSlugPullrequestsByPullRequestId as getPullrequest,
  getRepositoriesByWorkspaceByRepoSlugPullrequestsByPullRequestIdComments as listComments,
  getRepositoriesByWorkspaceByRepoSlugPullrequestsByPullRequestIdDiff as getDiff,
} from './generated/sdk.gen.ts';
import type { Pullrequest } from './generated/types.gen.ts';

const help = `bb — Bitbucket Cloud CLI

Usage:
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

Repository creation defaults to private; --public must be explicit.
Creation requires an explicit workspace/repo (positional or --repo), refuses
existing repositories, and does not clone, change Git remotes, or push.
Without --project, Bitbucket assigns the oldest project in the workspace.

PR creation defaults to the current Git branch and targets the repository's
main branch unless --destination is given. Push the source branch first.
PR updates send only supplied fields; --description '' clears the description.
pr open launches the PR in your system browser.

Comment creation defaults to pending; --publish posts it visibly right away.
Publishing a pending comment re-creates it as published (new id) and deletes
the draft, because Bitbucket cannot change pending state in place.
--unresolved keeps comments in open threads; thread status is read per thread.
--author matches display name or nickname (case-insensitive), account id or uuid.
Use --body-file <path|-> instead of
--body for a file or stdin. --line uses the new diff side unless --side old.
--reply-to adds the comment to an existing thread, inheriting its anchor.
Resolve and reopen act on a thread's top-level comment and are no-ops when the
thread is already in the requested state.
Updates replace the text and retain the comment's pending/published state.
Publication is per-comment, not a batch review submission.

Options:
  --repo, -R <workspace/repo>  Defaults to Git origin
  --json                     JSON output (lists are fully paginated arrays)
  --help, -h                 Show help

Authentication (environment variables):
  BITBUCKET_EMAIL + BITBUCKET_API_TOKEN, or BITBUCKET_ACCESS_TOKEN
  Without credentials, requests are anonymous.

The CLI checks returned state after every write and never retries writes.`;

function print(value: string) {
  // Remote PR content is untrusted terminal input; JSON output preserves raw data.
  console.log(stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''));
}

function headline(pr: Pullrequest) {
  return `#${pr.id ?? '?'}  ${pr.state ?? ''}  ${pr.title ?? ''}`;
}

function formatComment(comment: ReviewComment) {
  return [
    `#${comment.id ?? '?'}  ${comment.user?.display_name ?? 'Unknown'}${comment.parent?.id ? ` ↳ #${comment.parent.id}` : ''}${comment.pending ? ' [pending]' : ''}${comment.resolution ? ' [resolved]' : ''}`,
    ...(comment.inline ? [`${comment.inline.path}:${comment.inline.to ?? comment.inline.from ?? '?'}`] : []),
    comment.deleted ? '[deleted]' : comment.content?.raw ?? '',
  ].join('\n');
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      repo: { type: 'string', short: 'R' },
      private: { type: 'boolean' },
      public: { type: 'boolean' },
      project: { type: 'string' },
      description: { type: 'string' },
      'description-file': { type: 'string' },
      title: { type: 'string' },
      source: { type: 'string' },
      destination: { type: 'string' },
      state: { type: 'string' },
      body: { type: 'string' },
      'body-file': { type: 'string' },
      file: { type: 'string' },
      line: { type: 'string' },
      side: { type: 'string' },
      'reply-to': { type: 'string' },
      pending: { type: 'boolean' },
      publish: { type: 'boolean' },
      unresolved: { type: 'boolean' },
      author: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || args.length === 0) {
    console.log(help);
    return;
  }
  const [resource, command] = positionals;
  const creationFlags = ['private', 'public', 'project', 'description'] as const;
  if (resource === 'repo') {
    if (!['create', 'view'].includes(command ?? '')) throw new Error('Unknown command. Run bb --help.');
    if (positionals.length > 3 || (positionals[2] !== undefined && values.repo !== undefined)) {
      throw new Error('Supply one workspace/repo, positional or --repo.');
    }
    const allowed = new Set(['repo', 'json', ...(command === 'create' ? creationFlags : [])]);
    for (const flag of Object.keys(values)) {
      if (!allowed.has(flag)) throw new Error(`--${flag} is not supported by repo ${command}.`);
    }
    if (values.private && values.public) throw new Error('Use either --private or --public, not both.');
    if (values.project !== undefined && !values.project.trim()) throw new Error('--project must not be empty.');
    const explicit = positionals[2] ?? values.repo;
    if (command === 'create' && explicit === undefined) throw new Error('Repository creation requires an explicit workspace/repo.');
    const path = resolveRepository(explicit);
    const client = createBitbucketClient();
    const data = command === 'create'
      ? await createRepository(client, path, { isPrivate: !values.public, project: values.project, description: values.description })
      : (await getRepository({ client, path, throwOnError: true })).data;
    if (values.json) console.log(JSON.stringify(data, null, 2));
    else print([
      `${command === 'create' ? 'Created ' : ''}${data.full_name ?? `${path.workspace}/${path.repo_slug}`} (${data.is_private === true ? 'private' : data.is_private === false ? 'public' : 'unknown visibility'})`,
      data.links?.html?.href ?? '',
      ...(data.links?.clone ?? []).map((link) => `${link.name ?? 'clone'}: ${link.href ?? ''}`),
    ].filter(Boolean).join('\n'));
    return;
  }
  const writesPr = resource === 'pr' && (command === 'create' || command === 'update');
  for (const flag of creationFlags) {
    if (flag === 'description' && writesPr) continue;
    if (values[flag] !== undefined) throw new Error(`--${flag} is only supported by ${flag === 'description' ? 'repo create, pr create, or pr update' : 'repo create'}.`);
  }
  for (const flag of ['title', 'source', 'destination', 'description-file'] as const) {
    if (values[flag] !== undefined && !writesPr) throw new Error(`--${flag} is only supported by pr create or update.`);
  }
  if (writesPr) {
    const allowed = new Set(['repo', 'json', 'title', 'source', 'destination', 'description', 'description-file']);
    for (const flag of Object.keys(values)) {
      if (!allowed.has(flag)) throw new Error(`--${flag} is not supported by pr ${command}.`);
    }
    if (positionals.length !== (command === 'create' ? 2 : 3)) throw new Error('Unexpected or missing arguments. Run bb --help.');
    const id = command === 'update' ? positiveId(positionals[2], 'PR id') : undefined;
    const changes = await pullrequestChanges(values, command === 'create');
    const repository = resolveRepository(values.repo);
    const data = await writePullrequest(createBitbucketClient(), repository, changes, id);
    if (values.json) console.log(JSON.stringify(data, null, 2));
    else print([`${command === 'create' ? 'Created' : 'Updated'} ${headline(data)}`, data.links?.html?.href ?? ''].filter(Boolean).join('\n'));
    return;
  }
  const action = command === 'comment' ? positionals[2] : undefined;
  if (resource !== 'pr' || !['list', 'view', 'open', 'diff', 'comments', 'comment'].includes(command ?? '') ||
      (command === 'comment' && !['add', 'pending', 'publish', 'update', 'resolve', 'reopen'].includes(action ?? ''))) {
    throw new Error('Unknown command. Run bb --help.');
  }
  const needsCommentId = action === 'publish' || action === 'update' || action === 'resolve' || action === 'reopen';
  const expectedArgs = command === 'list' ? 2 : command === 'comment' ? (needsCommentId ? 5 : 4) : 3;
  if (positionals.length !== expectedArgs) throw new Error('Unexpected or missing arguments. Run bb --help.');
  const id = command === 'list' ? undefined : positiveId(positionals[command === 'comment' ? 3 : 2], 'PR id');
  const commentId = needsCommentId ? positiveId(positionals[4], 'Comment id') : undefined;
  const state = values.state ?? 'OPEN';
  if (values.state !== undefined && command !== 'list') throw new Error('--state is only supported by pr list.');
  if (!['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'].includes(state)) throw new Error('Invalid PR state.');
  for (const flag of ['body', 'body-file'] as const) {
    if (values[flag] !== undefined && action !== 'add' && action !== 'update') {
      throw new Error(`--${flag} is only supported by pr comment add or update.`);
    }
  }
  for (const flag of ['file', 'line', 'side', 'reply-to'] as const) {
    if (values[flag] !== undefined && action !== 'add') throw new Error(`--${flag} is only supported by pr comment add.`);
  }
  if (values.pending && command !== 'comments' && action !== 'add' && action !== 'pending') {
    throw new Error('--pending is only supported by comments, comment pending, or comment add.');
  }
  if (values.publish && action !== 'add') throw new Error('--publish is only supported by pr comment add.');
  if (values.publish && values.pending) throw new Error('Use either --pending or --publish, not both.');
  for (const flag of ['unresolved', 'author'] as const) {
    if (values[flag] !== undefined && command !== 'comments') throw new Error(`--${flag} is only supported by pr comments.`);
  }
  if (values.unresolved && values.pending) throw new Error('Use either --pending or --unresolved, not both.');
  if (values.author !== undefined && !values.author.trim()) throw new Error('--author must not be empty.');
  const body = action === 'add' ? await commentBody(values) : undefined;
  const updatedText = action === 'update' ? await readCommentBody(values) : undefined;

  const repository = resolveRepository(values.repo);
  if (command === 'open') {
    const url = openPullrequest(repository, id!);
    if (values.json) console.log(JSON.stringify({ url }, null, 2));
    else print(url);
    return;
  }
  const client = createBitbucketClient();
  const options = { client, throwOnError: true as const };
  const path = { ...repository, pull_request_id: Number(id) };
  const json = (data: unknown) => console.log(JSON.stringify(data, null, 2));

  switch (command) {
    case 'list': {
      const { data } = await listPullrequests({ ...options, path: repository, query: { state: state as Pullrequest['state'] } });
      const prs = await collectPages(client, data);
      if (values.json) json(prs);
      else print(prs.map(headline).join('\n') || 'No pull requests.');
      break;
    }
    case 'view': {
      const { data } = await getPullrequest({ ...options, path });
      if (values.json) json(data);
      else print([
        headline(data),
        `${data.source?.branch?.name ?? '?'} → ${data.destination?.branch?.name ?? '?'}`,
        data.links?.html?.href ?? '',
        '',
        String(data.description ?? data.summary?.raw ?? ''),
      ].join('\n'));
      break;
    }
    case 'comment': {
      if (action === 'add') {
        const comment = await addComment(client, path, body!);
        if (values.json) json(comment);
        else print(`Created ${comment.pending ? 'pending' : 'published'} comment #${comment.id}.\n${formatComment(comment)}`);
        break;
      }
      if (action === 'update') {
        const comment = await updateComment(client, path, commentId!, updatedText!);
        if (values.json) json(comment);
        else print(`Updated comment #${commentId} (${comment.pending ? 'pending' : 'published'}).\n${formatComment(comment)}`);
        break;
      }
      if (action === 'publish') {
        const comment = await publishComment(client, path, commentId!);
        if (values.json) json(comment);
        else print(comment.id === commentId ? `Comment #${commentId} is published.` : `Published #${commentId} as #${comment.id}.`);
        break;
      }
      if (action === 'resolve' || action === 'reopen') {
        const comment = action === 'resolve'
          ? await resolveComment(client, path, commentId!)
          : await reopenComment(client, path, commentId!);
        if (values.json) json(comment);
        else print(`Comment #${commentId} is ${action === 'resolve' ? 'resolved' : 'open'}.`);
        break;
      }
      // "comment pending" shares pagination/rendering with "comments --pending".
    }
    case 'comments': {
      const { data } = await listComments({ ...options, path });
      const listed = await collectPages(client, data) as ReviewComment[];
      const onlyPending = action === 'pending' || values.pending;
      const all = onlyPending ? listed : await withThreadResolution(client, path, listed);
      const commentsById = new Map(all.map((comment) => [comment.id!, comment]));
      const author = values.author?.trim().toLowerCase();
      const comments = all.filter((comment) => {
        if (onlyPending && (comment.pending !== true || comment.deleted)) return false;
        if (values.unresolved) {
          if (comment.deleted) return false;
          const root = commentsById.get(threadRootId(comment, commentsById) ?? -1);
          if (!root || root.deleted || root.resolution) return false;
        }
        if (author !== undefined) {
          const user = comment.user as Record<string, unknown> | undefined;
          const names = [user?.display_name, user?.nickname].filter((name): name is string => typeof name === 'string');
          const ids = [user?.account_id, user?.uuid].filter((id): id is string => typeof id === 'string');
          if (!names.some((name) => name.toLowerCase().includes(author)) && !ids.some((id) => id.toLowerCase() === author)) return false;
        }
        return true;
      });
      if (values.json) json(comments);
      else print(comments.map(formatComment).join('\n\n') || (onlyPending ? 'No pending comments returned by Bitbucket.' : 'No matching comments.'));
      break;
    }
    case 'diff': {
      const { data } = await getDiff({ ...options, path, parseAs: 'text' });
      if (values.json) json(data);
      else print(String(data));
      break;
    }
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unexpected error.';
    console.error(`bb: ${stripVTControlCharacters(message)}`);
    process.exitCode = 1;
  });
}
