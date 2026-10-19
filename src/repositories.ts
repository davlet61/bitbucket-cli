import type { Client } from './generated/client/index.ts';
import {
  getRepositoriesByWorkspaceByRepoSlug as getRepository,
  postRepositoriesByWorkspaceByRepoSlug as postRepository,
} from './generated/sdk.gen.ts';
import type { Repository } from './generated/types.gen.ts';

type RepositoryPath = { workspace: string; repo_slug: string };
type CreateOptions = { isPrivate: boolean; project?: string; description?: string };

export async function createRepository(client: Client, path: RepositoryPath, input: CreateOptions): Promise<Repository> {
  const fullName = `${path.workspace}/${path.repo_slug}`;
  const existing = await getRepository({ client, path, throwOnError: false });
  if (existing.response?.status !== 404) {
    if (existing.error) throw existing.error;
    throw new Error(`Repository ${fullName} already exists; refusing to change it.`);
  }
  const body = {
    scm: 'git',
    name: path.repo_slug,
    is_private: input.isPrivate,
    ...(input.project !== undefined ? { project: { key: input.project } } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
  let data: Repository;
  try {
    // Send only creation fields, not the response discriminators required by the SDK type.
    ({ data } = await postRepository({ client, path, body: body as Repository, throwOnError: true }));
  } catch (error) {
    throw new Error(`Repository creation failed: ${error instanceof Error ? error.message : 'Unknown error'}. Not retried; inspect ${fullName} before trying again.`);
  }
  if (!data?.uuid || data.full_name?.toLowerCase() !== fullName.toLowerCase() ||
      data.is_private !== input.isPrivate || data.scm !== 'git' ||
      (input.project !== undefined && data.project?.key !== input.project && data.project?.uuid !== input.project) ||
      (input.description !== undefined && data.description !== input.description)) {
    throw new Error(`Bitbucket did not confirm the requested repository settings for ${fullName}. It may already exist with unexpected visibility; inspect it before retrying. No automatic cleanup was attempted.`);
  }
  return data;
}
