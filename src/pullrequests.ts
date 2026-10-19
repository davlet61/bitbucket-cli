import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { Client } from './generated/client/index.ts';
import type { Pullrequest } from './generated/types.gen.ts';
import {
  postRepositoriesByWorkspaceByRepoSlugPullrequests as postPullrequest,
  putRepositoriesByWorkspaceByRepoSlugPullrequestsByPullRequestId as putPullrequest,
} from './generated/sdk.gen.ts';

type RepositoryPath = { workspace: string; repo_slug: string };
type Input = { title?: string; source?: string; destination?: string; description?: string; 'description-file'?: string };
type Changes = { title?: string; description?: string; source?: { branch: { name: string } }; destination?: { branch: { name: string } } };

export function currentBranch(): string {
  try {
    return execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error('Cannot determine the current Git branch; use --source <branch>.');
  }
}

export async function pullrequestChanges(input: Input, creating: boolean): Promise<Changes> {
  for (const field of ['title', 'source', 'destination'] as const) {
    if (input[field] !== undefined && !input[field].trim()) throw new Error(`--${field} must not be empty.`);
  }
  if (creating && input.title === undefined) throw new Error('PR creation requires --title.');
  if (!creating && input.source !== undefined) throw new Error('--source is only supported by pr create.');
  if (input.description !== undefined && input['description-file'] !== undefined) {
    throw new Error('Supply either --description or --description-file, not both.');
  }
  const description = input['description-file'] === undefined ? input.description
    : input['description-file'] === '-' ? await Bun.stdin.text() : await readFile(input['description-file'], 'utf8');
  const source = creating ? input.source ?? currentBranch() : undefined;
  if (source !== undefined && source === input.destination) throw new Error('Source and destination branches must differ.');
  const changes: Changes = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(source !== undefined ? { source: { branch: { name: source } } } : {}),
    ...(input.destination !== undefined ? { destination: { branch: { name: input.destination } } } : {}),
  };
  if (!Object.keys(changes).length) throw new Error('Supply --title, --description, --description-file, or --destination to update a PR.');
  return changes;
}

export async function writePullrequest(client: Client, repository: RepositoryPath, changes: Changes, id?: number): Promise<Pullrequest> {
  let data: Pullrequest;
  try {
    // Only send editable fields. The generated schema requires a response discriminator
    // and omits description, which the documented write endpoint accepts.
    const options = { client, body: changes as Pullrequest, throwOnError: true as const };
    ({ data } = id === undefined
      ? await postPullrequest({ ...options, path: repository })
      : await putPullrequest({ ...options, path: { ...repository, pull_request_id: id } }));
  } catch (error) {
    throw new Error(`PR ${id === undefined ? 'creation' : 'update'} failed: ${error instanceof Error ? error.message : 'Unknown error'}. Not retried; inspect the PR before trying again.`);
  }
  if (!Number.isSafeInteger(data?.id) || data.id! <= 0 || (id !== undefined && data.id !== id) ||
      data.state !== 'OPEN' ||
      (changes.title !== undefined && data.title !== changes.title) ||
      (changes.description !== undefined && (data.description ?? data.summary?.raw) !== changes.description) ||
      (changes.source !== undefined && data.source?.branch?.name !== changes.source.branch.name) ||
      (changes.destination !== undefined && data.destination?.branch?.name !== changes.destination.branch.name)) {
    throw new Error('Bitbucket did not confirm the requested PR settings. The write may have succeeded; inspect the PR before retrying.');
  }
  return data;
}

export function openPullrequest(repository: RepositoryPath, id: number, run = execFileSync, platform = process.platform): string {
  const url = `https://bitbucket.org/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repo_slug)}/pull-requests/${id}`;
  try {
    if (platform === 'darwin') run('open', [url], { stdio: 'ignore' });
    else if (platform === 'win32') run('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore' });
    else run('xdg-open', [url], { stdio: 'ignore' });
  } catch {
    throw new Error(`Could not launch the browser. Open ${url}`);
  }
  return url;
}
