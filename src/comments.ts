import { readFile } from 'node:fs/promises';
import type { Client } from './generated/client/index.ts';
import {
  deleteRepositoriesByWorkspaceByRepoSlugPullrequestsByPullRequestIdCommentsByCommentId as deleteComment,
  deleteRepositoriesByWorkspaceByRepoSlugPullrequestsByPullRequestIdCommentsByCommentIdResolve as deleteResolution,
  getRepositoriesByWorkspaceByRepoSlugPullrequestsByPullRequestIdCommentsByCommentId as getComment,
  postRepositoriesByWorkspaceByRepoSlugPullrequestsByPullRequestIdCommentsByCommentIdResolve as postResolution,
  postRepositoriesByWorkspaceByRepoSlugPullrequestsByPullRequestIdComments as postComment,
  putRepositoriesByWorkspaceByRepoSlugPullrequestsByPullRequestIdCommentsByCommentId as putComment,
} from './generated/sdk.gen.ts';
import type { Comment, PullrequestComment } from './generated/types.gen.ts';

// Hey API's Omit<Comment, 'type'> loses named fields through Comment's index signature.
export type ReviewComment = PullrequestComment & Pick<Comment, 'id' | 'user' | 'inline' | 'deleted' | 'content' | 'parent'>;
type PrPath = { workspace: string; repo_slug: string; pull_request_id: number };
type CommentBody = Pick<Comment, 'content' | 'inline'> & { pending?: true; parent?: { id: number } };
type Input = {
  body?: string; 'body-file'?: string; file?: string; line?: string; side?: string; 'reply-to'?: string; publish?: boolean;
};

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

export async function commentBody(input: Input): Promise<CommentBody> {
  if ((input.file !== undefined) !== (input.line !== undefined)) {
    throw new Error('Inline comments require both --file and --line.');
  }
  if (input.side !== undefined && input.file === undefined) throw new Error('--side requires --file and --line.');
  if (input.side !== undefined && !['old', 'new'].includes(input.side)) throw new Error('--side must be old or new.');
  if (input['reply-to'] !== undefined && input.file !== undefined) {
    throw new Error('Replies inherit their anchor; --reply-to cannot be combined with --file or --line.');
  }
  const parent = input['reply-to'] === undefined ? undefined : { id: positiveId(input['reply-to'], 'Reply-to comment id') };
  let inline: Comment['inline'];
  if (input.file !== undefined) {
    if (!input.file || /[\\\x00-\x1f]/.test(input.file) || input.file.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('--file must be a repository-relative path without traversal.');
    }
    const line = positiveId(input.line, 'Line');
    inline = { path: input.file, [input.side === 'old' ? 'from' : 'to']: line };
  }
  const raw = await readCommentBody(input);
  return {
    ...(input.publish ? {} : { pending: true as const }),
    content: { raw },
    ...(inline ? { inline } : {}),
    ...(parent ? { parent } : {}),
  };
}

export async function addComment(client: Client, path: PrPath, body: CommentBody): Promise<ReviewComment> {
  let data: ReviewComment;
  try {
    // The live endpoint rejects `type` as an extra key, despite the schema requiring it.
    // Keep the schema workaround at the SDK boundary; never send response discriminators.
    const result = await postComment({ client, path, body: body as PullrequestComment, throwOnError: true });
    data = result.data as ReviewComment;
  } catch (error) {
    throw new Error(`Comment creation failed: ${error instanceof Error ? error.message : 'Unknown error'}. Not retried; inspect the PR before re-running to avoid duplicate comments.`);
  }
  if (!Number.isSafeInteger(data.id) || data.id! <= 0) {
    throw new Error('Bitbucket did not return a comment id; inspect the PR before retrying.');
  }
  if (body.pending && data.pending !== true) {
    throw new Error(`Bitbucket did not confirm a pending comment (id: ${data.id}). It may already be visible; inspect the PR before retrying. No automatic cleanup was attempted.`);
  }
  if (!body.pending && data.pending !== false) {
    throw new Error(`Bitbucket did not confirm a published comment (id: ${data.id}); inspect the PR before retrying.`);
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
    // Text updates reject `pending` (and `type`); send only the editable content.
    // Verify publication state in the response instead of attempting to write it.
    const body: Partial<ReviewComment> = { content: { raw } };
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
  const current = await readLiveComment(client, commentPath);
  // Reruns must never create another comment or rewrite an already-published one.
  if (current.pending === false) return current;
  if (current.pending !== true) throw new Error(`Cannot determine whether comment #${commentId} is pending; refusing to publish it.`);
  if (!current.content?.raw?.trim()) throw new Error(`Comment #${commentId} has no text to publish.`);
  // Bitbucket rejects pending changes on PUT, so publishing re-creates the draft and then removes it.
  const inline = current.inline ? { path: current.inline.path, from: current.inline.from, to: current.inline.to } : undefined;
  const published = await addComment(client, path, {
    content: { raw: current.content.raw },
    ...(inline ? { inline } : {}),
    ...(current.parent?.id ? { parent: { id: current.parent.id } } : {}),
  });
  try {
    await deleteComment({ client, path: commentPath, throwOnError: true });
  } catch (error) {
    throw new Error(`Published #${commentId} as #${published.id}, but deleting the draft failed: ${error instanceof Error ? error.message : 'Unknown error'}. Delete draft #${commentId} manually.`);
  }
  return published;
}

export async function withThreadResolution(client: Client, path: PrPath, comments: ReviewComment[]): Promise<ReviewComment[]> {
  // The comment list always returns a null resolution; only the single-comment endpoint reports it.
  const roots = comments.filter((comment) => !comment.parent && !comment.deleted && comment.id !== undefined);
  const live = new Map(await Promise.all(roots.map(async (root) => {
    const { data } = await getComment({ client, path: { ...path, comment_id: root.id! }, throwOnError: true });
    return [root.id!, (data as ReviewComment).resolution ?? null] as const;
  })));
  return comments.map((comment) => (live.has(comment.id!) ? { ...comment, resolution: live.get(comment.id!) ?? undefined } : comment));
}

export function threadRootId(comment: ReviewComment, commentsById: Map<number, ReviewComment>): number | undefined {
  let current = comment;
  const seen = new Set<number>();
  while (current.parent?.id !== undefined && !seen.has(current.parent.id)) {
    seen.add(current.parent.id);
    const parent = commentsById.get(current.parent.id);
    if (!parent) return current.parent.id;
    current = parent;
  }
  return current.id;
}

async function readLiveComment(client: Client, commentPath: PrPath & { comment_id: number }): Promise<ReviewComment> {
  const { data } = await getComment({ client, path: commentPath, throwOnError: true });
  if (data.deleted) throw new Error(`Comment #${commentPath.comment_id} is deleted.`);
  return data as ReviewComment;
}

export async function resolveComment(client: Client, path: PrPath, commentId: number): Promise<ReviewComment> {
  const commentPath = { ...path, comment_id: commentId };
  const current = await readLiveComment(client, commentPath);
  if (current.resolution) return current;
  try {
    const { data: resolution } = await postResolution({ client, path: commentPath, throwOnError: true });
    return { ...current, resolution };
  } catch (error) {
    throw new Error(`Resolving #${commentId} failed: ${error instanceof Error ? error.message : 'Unknown error'}. Inspect the thread before re-running.`);
  }
}

export async function reopenComment(client: Client, path: PrPath, commentId: number): Promise<ReviewComment> {
  const commentPath = { ...path, comment_id: commentId };
  const current = await readLiveComment(client, commentPath);
  if (!current.resolution) return current;
  try {
    await deleteResolution({ client, path: commentPath, throwOnError: true });
  } catch (error) {
    throw new Error(`Reopening #${commentId} failed: ${error instanceof Error ? error.message : 'Unknown error'}. Inspect the thread before re-running.`);
  }
  const { resolution: _resolution, ...reopened } = current;
  return reopened;
}
