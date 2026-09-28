import { readFile } from 'node:fs/promises';
import type { Client } from './generated/client/index.ts';
import {
  getRepositoriesByWorkspaceByRepoSlugPullrequestsByPullRequestIdCommentsByCommentId as getComment,
  postRepositoriesByWorkspaceByRepoSlugPullrequestsByPullRequestIdComments as postComment,
  putRepositoriesByWorkspaceByRepoSlugPullrequestsByPullRequestIdCommentsByCommentId as putComment,
} from './generated/sdk.gen.ts';
import type { Comment, PullrequestComment } from './generated/types.gen.ts';

// Hey API's Omit<Comment, 'type'> loses named fields through Comment's index signature.
export type ReviewComment = PullrequestComment & Pick<Comment, 'id' | 'user' | 'inline' | 'deleted' | 'content'>;
type PrPath = { workspace: string; repo_slug: string; pull_request_id: number };
type PendingBody = Pick<Comment, 'content' | 'inline'> & { pending: true };
type Input = { body?: string; 'body-file'?: string; file?: string; line?: string; side?: string };

export function positiveId(value: string | undefined, name: string): number {
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
}

export async function readCommentBody(input: Pick<Input, 'body' | 'body-file'>): Promise<string> {
  if ((input.body !== undefined) === (input['body-file'] !== undefined)) {
    throw new Error('Supply exactly one of --body or --body-file (use - for stdin).');
  }
  const raw = input.body ?? (input['body-file'] === '-'
    ? await Bun.stdin.text()
    : await readFile(input['body-file']!, 'utf8'));
  if (!raw.trim()) throw new Error('Comment body must not be empty.');
  return raw;
}

export async function pendingBody(input: Input): Promise<PendingBody> {
  if ((input.file !== undefined) !== (input.line !== undefined)) {
    throw new Error('Inline comments require both --file and --line.');
  }
  if (input.side !== undefined && input.file === undefined) throw new Error('--side requires --file and --line.');
  if (input.side !== undefined && !['old', 'new'].includes(input.side)) throw new Error('--side must be old or new.');
  let inline: Comment['inline'];
  if (input.file !== undefined) {
    if (!input.file || /[\\\x00-\x1f]/.test(input.file) || input.file.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('--file must be a repository-relative path without traversal.');
    }
    const line = positiveId(input.line, 'Line');
    inline = { path: input.file, [input.side === 'old' ? 'from' : 'to']: line };
  }
  const raw = await readCommentBody(input);
  return { pending: true, content: { raw }, ...(inline ? { inline } : {}) };
}

export async function addPendingComment(client: Client, path: PrPath, body: PendingBody): Promise<ReviewComment> {
  let data: ReviewComment;
  try {
    // The live endpoint rejects `type` as an extra key, despite the schema requiring it.
    // Keep the schema workaround at the SDK boundary; never send response discriminators.
    const result = await postComment({ client, path, body: body as PullrequestComment, throwOnError: true });
    data = result.data as ReviewComment;
  } catch (error) {
    throw new Error(`Comment creation failed: ${error instanceof Error ? error.message : 'Unknown error'}. Not retried; inspect the PR before re-running to avoid duplicate comments.`);
  }
  if (data.pending !== true || !Number.isSafeInteger(data.id) || data.id! <= 0) {
    throw new Error(`Bitbucket did not confirm a pending comment (id: ${data.id ?? 'unknown'}). It may already be visible; inspect the PR before retrying. No automatic cleanup was attempted.`);
  }
  return data;
}

export async function updateComment(client: Client, path: PrPath, commentId: number, raw: string): Promise<ReviewComment> {
  if (!raw.trim()) throw new Error('Comment body must not be empty.');
  const commentPath = { ...path, comment_id: commentId };
  const { data: current } = await getComment({ client, path: commentPath, throwOnError: true });
  if (current.deleted) throw new Error(`Comment #${commentId} is deleted.`);
  if (typeof current.pending !== 'boolean') {
    throw new Error(`Cannot determine whether comment #${commentId} is pending; refusing to update it.`);
  }
  let data: ReviewComment;
  try {
    // Keep the existing publication state; never send `type` or change the anchor.
    const body: Partial<ReviewComment> = { content: { raw }, pending: current.pending };
    const result = await putComment({ client, path: commentPath, body: body as PullrequestComment, throwOnError: true });
    data = result.data as ReviewComment;
  } catch (error) {
    throw new Error(`Updating #${commentId} failed: ${error instanceof Error ? error.message : 'Unknown error'}. Not retried; inspect the comment before re-running.`);
  }
  if (data.id !== commentId || data.content?.raw !== raw || data.pending !== current.pending) {
    throw new Error(`Bitbucket did not confirm the requested text and unchanged publication state for #${commentId}; inspect the comment before retrying.`);
  }
  return data;
}

export async function publishComment(client: Client, path: PrPath, commentId: number): Promise<ReviewComment> {
  const commentPath = { ...path, comment_id: commentId };
  const { data: current } = await getComment({ client, path: commentPath, throwOnError: true });
  if (current.deleted) throw new Error(`Comment #${commentId} is deleted.`);
  // Reruns must never create another comment or rewrite an already-published one.
  if (current.pending === false) return current as ReviewComment;
  if (current.pending !== true) throw new Error(`Cannot determine whether comment #${commentId} is pending; refusing to update it.`);
  let data: ReviewComment;
  try {
    const result = await putComment({
      client,
      path: commentPath,
      // Only change publication state. Omit the response discriminator, as for POST.
      body: { pending: false } as PullrequestComment,
      throwOnError: true,
    });
    data = result.data as ReviewComment;
  } catch (error) {
    throw new Error(`Publishing #${commentId} failed: ${error instanceof Error ? error.message : 'Unknown error'}. Not retried; inspect its state before re-running.`);
  }
  if (data.pending !== false) {
    throw new Error(`Bitbucket did not confirm publication of #${commentId}; inspect its state before retrying.`);
  }
  return data;
}
