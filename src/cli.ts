#!/usr/bin/env bun
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { collectPages, createBitbucketClient } from './api.ts';
import { resolveRepository } from './config.ts';
import {
  addPendingComment,
  pendingBody,
  positiveId,
  publishComment,
  readCommentBody,
  reopenComment,
  resolveComment,
  updateComment,
  type ReviewComment,
} from './comments.ts';
import {
  getRepositoriesByWorkspaceByRepoSlugPullrequests as listPullrequests,
  getRepositoriesByWorkspaceByRepoSlugPullrequestsByPullRequestId as getPullrequest,
  getRepositoriesByWorkspaceByRepoSlugPullrequestsByPullRequestIdComments as listComments,
  getRepositoriesByWorkspaceByRepoSlugPullrequestsByPullRequestIdDiff as getDiff,
} from './generated/sdk.gen.ts';
import type { Pullrequest } from './generated/types.gen.ts';

const help = `bb — Bitbucket Cloud PR CLI

Usage:
  bb pr list [--state OPEN|MERGED|DECLINED|SUPERSEDED]
  bb pr view <id>
  bb pr diff <id>
  bb pr comments <id> [--pending]
  bb pr comment add <id> --body <text> [--pending]
      [--file <path> --line <n> [--side old|new] | --reply-to <comment-id>]
  bb pr comment pending <id>
  bb pr comment update <id> <comment-id> --body <text>
  bb pr comment publish <id> <comment-id>
  bb pr comment resolve <id> <comment-id>
  bb pr comment reopen <id> <comment-id>

Comment creation defaults to pending. Use --body-file <path|-> instead of
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

Pending creation/read-back is live-verified; updates and publication are not.
The CLI checks returned state; verify draft privacy on a test PR first.`;

function print(value: string) {
  // Remote PR content is untrusted terminal input; JSON output preserves raw data.
  console.log(stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''));
}

function headline(pr: Pullrequest) {
  return `#${pr.id ?? '?'}  ${pr.state ?? ''}  ${pr.title ?? ''}`;
}

function formatComment(comment: ReviewComment) {
  return [
    `#${comment.id ?? '?'}  ${comment.user?.display_name ?? 'Unknown'}${comment.pending ? ' [pending]' : ''}${comment.resolution ? ' [resolved]' : ''}`,
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
      state: { type: 'string' },
      body: { type: 'string' },
      'body-file': { type: 'string' },
      file: { type: 'string' },
      line: { type: 'string' },
      side: { type: 'string' },
      'reply-to': { type: 'string' },
      pending: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || args.length === 0) {
    console.log(help);
    return;
  }
  const [resource, command] = positionals;
  const action = command === 'comment' ? positionals[2] : undefined;
  if (resource !== 'pr' || !['list', 'view', 'diff', 'comments', 'comment'].includes(command ?? '') ||
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
  const body = action === 'add' ? await pendingBody(values) : undefined;
  const updatedText = action === 'update' ? await readCommentBody(values) : undefined;

  const repository = resolveRepository(values.repo);
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
        data.summary?.raw ?? '',
      ].join('\n'));
      break;
    }
    case 'comment': {
      if (action === 'add') {
        const comment = await addPendingComment(client, path, body!);
        if (values.json) json(comment);
        else print(`Created pending comment #${comment.id}.\n${formatComment(comment)}`);
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
        else print(`Comment #${commentId} is published.`);
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
      const all = await collectPages(client, data) as ReviewComment[];
      const onlyPending = action === 'pending' || values.pending;
      const comments = onlyPending ? all.filter((comment) => comment.pending === true && !comment.deleted) : all;
      if (values.json) json(comments);
      else print(comments.map(formatComment).join('\n\n') || (onlyPending ? 'No pending comments returned by Bitbucket.' : 'No comments.'));
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
