import { authorization, type Env } from './config.ts';
import { createClient, type Client } from './generated/client/index.ts';

const baseUrl = 'https://api.bitbucket.org/2.0';

export function createBitbucketClient(env: Env = process.env, fetchImpl: typeof fetch = fetch) {
  const auth = authorization(env);
  const client = createClient({
    baseUrl,
    headers: auth ? { Authorization: auth } : {},
    fetch: fetchImpl,
    throwOnError: true,
  });
  // A fresh timeout for each request, not one shared deadline for the CLI session.
  client.interceptors.request.use((request) => new Request(request, { signal: AbortSignal.timeout(30_000) }));
  client.interceptors.error.use((error, response) => {
    if (!response) return error instanceof Error ? error : new Error('Bitbucket request failed.');
    const envelope = typeof error === 'object' && error !== null && 'error' in error ? error.error : undefined;
    const info = typeof envelope === 'object' && envelope !== null ? envelope as Record<string, unknown> : {};
    const message = typeof info.message === 'string' ? `: ${info.message}` : '';
    // Preserve validation details without dumping request headers or the whole response.
    const diagnostics = ['detail', 'fields', 'data'].flatMap((key) => {
      const value = info[key];
      return value === undefined || value === null ? [] : [`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`];
    });
    const retry = response.headers.get('retry-after');
    const status = `Bitbucket HTTP ${response.status}${message}${retry ? ` (Retry-After: ${retry})` : ''}`;
    return new Error([status, ...diagnostics].join('\n'));
  });
  return client;
}

type Page<T> = { values?: T[]; next?: string };

export async function collectPages<T>(client: Client, first: Page<T>): Promise<T[]> {
  const values = [...(first.values ?? [])];
  let next = first.next;
  const seen = new Set<string>();
  while (next) {
    const url = new URL(next);
    // Never forward credentials to an arbitrary pagination URL.
    if (url.origin !== 'https://api.bitbucket.org' || !url.pathname.startsWith('/2.0/') || url.username || url.password) {
      throw new Error('Refusing an untrusted Bitbucket pagination URL.');
    }
    if (seen.has(url.href)) throw new Error('Bitbucket returned a repeated pagination URL.');
    seen.add(url.href);
    const { data } = await client.get<{ 200: Page<T> }, unknown, true>({
      url: url.pathname + url.search,
      baseUrl: url.origin,
      throwOnError: true,
    });
    values.push(...(data.values ?? []));
    next = data.next;
  }
  return values;
}
