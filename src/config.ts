import { execFileSync } from 'node:child_process';

export type Env = Record<string, string | undefined>;

export function authorization(env: Env): string | undefined {
  const { BITBUCKET_EMAIL: email, BITBUCKET_API_TOKEN: apiToken, BITBUCKET_ACCESS_TOKEN: accessToken } = env;
  if (accessToken && (email || apiToken)) {
    throw new Error('Use BITBUCKET_ACCESS_TOKEN or BITBUCKET_EMAIL + BITBUCKET_API_TOKEN, not both.');
  }
  if (accessToken) return `Bearer ${accessToken}`;
  if (email || apiToken) {
    if (!email || !apiToken) throw new Error('Set both BITBUCKET_EMAIL and BITBUCKET_API_TOKEN.');
    return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
  }
  return undefined;
}

export function parseRepository(value: string) {
  const match = /^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/.exec(value);
  if (!match || match[2] === '.' || match[2] === '..') {
    throw new Error('Repository must be workspace/repo-slug.');
  }
  return { workspace: match[1]!, repo_slug: match[2]! };
}

export function repositoryFromRemote(remote: string) {
  const match = /^(?:git@bitbucket\.org:|ssh:\/\/git@bitbucket\.org\/|https:\/\/(?:[^/@]+@)?bitbucket\.org\/)([^?#]+)$/.exec(remote.trim());
  if (!match) throw new Error('Origin is not a Bitbucket Cloud remote; use --repo workspace/repo-slug.');
  return parseRepository(match[1]!.replace(/\/$/, '').replace(/\.git$/, ''));
}

export function resolveRepository(explicit?: string) {
  if (explicit !== undefined) return parseRepository(explicit);
  let remote: string;
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error('Cannot read Git origin; use --repo workspace/repo-slug.');
  }
  return repositoryFromRemote(remote);
}
