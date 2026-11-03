import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBitbucketClient } from '../src/api.ts';
import { credentialsPath, login, readLogin, saveLogin, stdinPrompt, type StoredLogin } from '../src/auth.ts';
import { main } from '../src/cli.ts';
import { getRepositoriesByWorkspaceByRepoSlugPullrequests as listPullrequests } from '../src/generated/sdk.gen.ts';

const envKeys = ['BITBUCKET_EMAIL', 'BITBUCKET_API_TOKEN', 'BITBUCKET_ACCESS_TOKEN', 'XDG_CONFIG_HOME'] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const tokenUrl = 'https://bitbucket.org/site/oauth2/access_token';
const prUrl = 'https://api.bitbucket.org/2.0/repositories/team/project/pullrequests/42';
const consumer = { key: 'consumer-key-fixture', secret: 'consumer-secret-fixture' };
const basic = `Basic ${Buffer.from(`${consumer.key}:${consumer.secret}`).toString('base64')}`;
const secrets = [consumer.key, consumer.secret, 'access-old', 'refresh-old', 'access-new', 'refresh-new', 'env-access-token'];
let configHome: string;
let env: Record<string, string | undefined>;

beforeEach(async () => {
  for (const key of envKeys) delete process.env[key];
  configHome = await mkdtemp(join(tmpdir(), 'bb-auth-'));
  process.env.XDG_CONFIG_HOME = configHome;
  env = { XDG_CONFIG_HOME: configHome };
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await rm(configHome, { recursive: true, force: true });
});

function respond(handler: (request: Request) => Response | Promise<Response>) {
  return spyOn(globalThis, 'fetch').mockImplementation(Object.assign(
    async (input: RequestInfo | URL) => handler(input as Request),
    { preconnect: originalFetch.preconnect },
  ));
}

function storedLogin(expiresIn: number, suffix = 'old'): StoredLogin {
  return { consumer, access_token: `access-${suffix}`, refresh_token: `refresh-${suffix}`, expires_at: Date.now() + expiresIn, scope: 'pullrequest account' };
}

function tokenResponse(suffix = 'new', extra: Record<string, unknown> = {}) {
  return Response.json({ access_token: `access-${suffix}`, refresh_token: `refresh-${suffix}`, expires_in: 7200, token_type: 'bearer', scopes: 'pullrequest account', ...extra });
}

async function expectRefreshRequest(request: Request) {
  expect(request.method).toBe('POST');
  expect(request.headers.get('Authorization')).toBe(basic);
  expect(request.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
  expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-old' });
}

function callbackOpener(params: (authorize: URL) => Record<string, string>) {
  const seen: URL[] = [];
  const responses: Promise<Response>[] = [];
  const open = (href: string) => {
    const authorize = new URL(href);
    seen.push(authorize);
    const callback = new URL(authorize.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams(params(authorize)).toString();
    responses.push(originalFetch(callback));
  };
  return { open, seen, responses };
}

const quiet = { notify: () => {} };

describe('auth login', () => {
  test('authorizes in the browser, exchanges the code, and stores a private login', async () => {
    const prompts: [string, boolean][] = [];
    const prompt = async (question: string, hidden: boolean) => {
      prompts.push([question, hidden]);
      return hidden ? `${consumer.secret}\n` : ` ${consumer.key} `;
    };
    const notes: string[] = [];
    const opener = callbackOpener((authorize) => ({ code: 'code-fixture', state: authorize.searchParams.get('state')! }));
    const fetchImpl = Object.assign(async (input: RequestInfo | URL) => {
      const request = input as Request;
      expect(request.url).toBe(tokenUrl);
      expect(request.method).toBe('POST');
      expect(request.headers.get('Authorization')).toBe(basic);
      expect(request.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
      expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({
        grant_type: 'authorization_code', code: 'code-fixture', redirect_uri: opener.seen[0]!.searchParams.get('redirect_uri')!,
      });
      return tokenResponse('new', { scopes: undefined, scope: 'repository:admin pullrequest' });
    }, { preconnect: originalFetch.preconnect });
    const before = Date.now();
    const result = await login(env, { port: 0, prompt, notify: (line) => notes.push(line), openUrl: opener.open, fetchImpl });

    expect(prompts).toEqual([['Bitbucket OAuth consumer key: ', false], ['Bitbucket OAuth consumer secret: ', true]]);
    const authorize = opener.seen[0]!;
    expect(`${authorize.origin}${authorize.pathname}`).toBe('https://bitbucket.org/site/oauth2/authorize');
    expect(authorize.searchParams.get('client_id')).toBe(consumer.key);
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('state')!.length).toBeGreaterThanOrEqual(32);
    expect(authorize.searchParams.has('scope')).toBe(false);
    expect(authorize.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const page = await opener.responses[0]!;
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('login complete');
    expect(notes.join('\n')).toContain(authorize.href);
    expect(notes.join('\n')).not.toContain(consumer.secret);

    const path = credentialsPath(env);
    expect(path).toBe(join(configHome, 'bitbucket-cli', 'credentials.json'));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(configHome, 'bitbucket-cli'))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(configHome, 'bitbucket-cli'))).toEqual(['credentials.json']);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved).toEqual({ consumer, access_token: 'access-new', refresh_token: 'refresh-new', expires_at: result.expires_at, scope: 'repository:admin pullrequest' });
    expect(saved.expires_at).toBeGreaterThanOrEqual(before + 7_200_000);
    await expect(originalFetch(authorize.searchParams.get('redirect_uri')!)).rejects.toThrow();
  });

  test('reuses a stored consumer without prompting', async () => {
    await saveLogin(env, storedLogin(-1000));
    const opener = callbackOpener((authorize) => ({ code: 'code-fixture', state: authorize.searchParams.get('state')! }));
    const prompt = async () => { throw new Error('Unexpected prompt'); };
    const fetchImpl = Object.assign(async () => tokenResponse(), { preconnect: originalFetch.preconnect });
    await login(env, { ...quiet, port: 0, prompt, openUrl: opener.open, fetchImpl });
    expect(opener.seen[0]!.searchParams.get('client_id')).toBe(consumer.key);
    expect((await readLogin(env))?.refresh_token).toBe('refresh-new');
  });

  test.each([
    ['a mismatched state', () => ({ code: 'code-fixture', state: 'forged' }), 'state mismatch'],
    ['a denied authorization', (authorize: URL) => ({ error: 'access_denied', state: authorize.searchParams.get('state')! }), 'access_denied'],
  ])('rejects %s without exchanging a code', async (_, params, message) => {
    const opener = callbackOpener(params);
    const fetchImpl = Object.assign(async () => { throw new Error('Unexpected token request'); }, { preconnect: originalFetch.preconnect });
    const prompt = async (_question: string, hidden: boolean) => hidden ? consumer.secret : consumer.key;
    await expect(login(env, { ...quiet, port: 0, prompt, openUrl: opener.open, fetchImpl })).rejects.toThrow(message);
    expect((await opener.responses[0]!).status).toBe(400);
    expect(await readLogin(env)).toBeUndefined();
  });

  test('reports a failed code exchange without secrets and saves nothing', async () => {
    const opener = callbackOpener((authorize) => ({ code: 'code-fixture', state: authorize.searchParams.get('state')! }));
    const fetchImpl = Object.assign(async () => Response.json({ error: 'invalid_grant', error_description: consumer.secret }, { status: 400 }), { preconnect: originalFetch.preconnect });
    const prompt = async (_question: string, hidden: boolean) => hidden ? consumer.secret : consumer.key;
    const failure = await login(env, { ...quiet, port: 0, prompt, openUrl: opener.open, fetchImpl }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Bitbucket token exchange failed (HTTP 400 invalid_grant).');
    expect(await readLogin(env)).toBeUndefined();
  });

  test('rejects malformed token responses', async () => {
    const opener = callbackOpener((authorize) => ({ code: 'code-fixture', state: authorize.searchParams.get('state')! }));
    const fetchImpl = Object.assign(async () => tokenResponse('new', { token_type: 'mac' }), { preconnect: originalFetch.preconnect });
    const prompt = async (_question: string, hidden: boolean) => hidden ? consumer.secret : consumer.key;
    await expect(login(env, { ...quiet, port: 0, prompt, openUrl: opener.open, fetchImpl })).rejects.toThrow('unexpected token response');
    expect(await readLogin(env)).toBeUndefined();
  });

  test('explains a busy callback port', async () => {
    const busy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    try {
      const prompt = async (_question: string, hidden: boolean) => hidden ? consumer.secret : consumer.key;
      const openUrl = () => { throw new Error('Unexpected browser launch'); };
      await expect(login(env, { ...quiet, port: busy.port!, prompt, openUrl })).rejects.toThrow(`Cannot listen on 127.0.0.1:${busy.port}`);
    } finally {
      busy.stop(true);
    }
  });

  test('reads the consumer key and secret as two lines when stdin is not a terminal', async () => {
    const stdin = spyOn(Bun.stdin, 'text').mockResolvedValue(`${consumer.key}\n${consumer.secret}\n`);
    try {
      const prompt = stdinPrompt(false);
      expect(await prompt('key', false)).toBe(consumer.key);
      expect(await prompt('secret', true)).toBe(consumer.secret);
      expect(stdin).toHaveBeenCalledTimes(1);
    } finally {
      stdin.mockRestore();
    }
  });
});

describe('stored login requests', () => {
  test('environment credentials take precedence over a stored login', async () => {
    await saveLogin(env, storedLogin(-1000));
    process.env.BITBUCKET_ACCESS_TOKEN = 'env-access-token';
    spyOn(console, 'log').mockImplementation(() => {});
    const network = respond((request) => {
      expect(request.url).toBe(prUrl);
      expect(request.headers.get('Authorization')).toBe('Bearer env-access-token');
      return Response.json({ id: 42, state: 'OPEN', title: 'Feature' });
    });
    await main(['pr', 'view', '42', '-R', 'team/project']);
    expect(network).toHaveBeenCalledTimes(1);
    expect((await readLogin(env))?.refresh_token).toBe('refresh-old');
  });

  test('uses a valid stored token without refreshing', async () => {
    await saveLogin(env, storedLogin(3_600_000));
    spyOn(console, 'log').mockImplementation(() => {});
    const network = respond((request) => {
      expect(request.url).toBe(prUrl);
      expect(request.headers.get('Authorization')).toBe('Bearer access-old');
      return Response.json({ id: 42, state: 'OPEN', title: 'Feature' });
    });
    await main(['pr', 'view', '42', '-R', 'team/project']);
    expect(network).toHaveBeenCalledTimes(1);
  });

  test('refreshes an expiring token before the request and persists the rotated refresh token', async () => {
    await saveLogin(env, storedLogin(60_000));
    spyOn(console, 'log').mockImplementation(() => {});
    const urls: string[] = [];
    respond(async (request) => {
      urls.push(request.url);
      if (request.url === tokenUrl) {
        await expectRefreshRequest(request);
        return tokenResponse();
      }
      expect(request.headers.get('Authorization')).toBe('Bearer access-new');
      return Response.json({ id: 42, state: 'OPEN', title: 'Feature' });
    });
    await main(['pr', 'view', '42', '-R', 'team/project']);
    expect(urls).toEqual([tokenUrl, prUrl]);
    const saved = await readLogin(env);
    expect(saved).toMatchObject({ consumer, access_token: 'access-new', refresh_token: 'refresh-new', scope: 'pullrequest account' });
    expect(saved!.expires_at).toBeGreaterThan(Date.now() + 7_000_000);
    expect((await stat(credentialsPath(env))).mode & 0o777).toBe(0o600);
    expect(await readdir(join(configHome, 'bitbucket-cli'))).toEqual(['credentials.json']);
  });

  test('refreshes once for parallel requests in one process', async () => {
    await saveLogin(env, storedLogin(-1000));
    const network = respond(async (request) => {
      if (request.url === tokenUrl) return tokenResponse();
      expect(request.headers.get('Authorization')).toBe('Bearer access-new');
      return Response.json({ values: [] });
    });
    const client = createBitbucketClient(process.env);
    const path = { workspace: 'team', repo_slug: 'project' };
    await Promise.all([1, 2, 3].map(() => listPullrequests({ client, path, throwOnError: true })));
    expect(network.mock.calls.filter(([request]) => (request as Request).url === tokenUrl)).toHaveLength(1);
    expect(network).toHaveBeenCalledTimes(4);
  });

  test('waits for a held lock and reuses the token another process refreshed', async () => {
    await saveLogin(env, storedLogin(-1000));
    const lock = `${credentialsPath(env)}.lock`;
    await writeFile(lock, '');
    spyOn(console, 'log').mockImplementation(() => {});
    const network = respond((request) => {
      expect(request.url).toBe(prUrl);
      expect(request.headers.get('Authorization')).toBe('Bearer access-other');
      return Response.json({ id: 42, state: 'OPEN', title: 'Feature' });
    });
    const run = main(['pr', 'view', '42', '-R', 'team/project']);
    await Bun.sleep(300);
    expect(network).not.toHaveBeenCalled();
    await saveLogin(env, storedLogin(7_200_000, 'other'));
    await rm(lock);
    await run;
    expect(network).toHaveBeenCalledTimes(1);
    expect((await readLogin(env))?.refresh_token).toBe('refresh-other');
    expect(await stat(lock).catch(() => undefined)).toBeUndefined();
  });

  test('breaks a stale lock and refreshes', async () => {
    await saveLogin(env, storedLogin(-1000));
    const lock = `${credentialsPath(env)}.lock`;
    await writeFile(lock, '');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    spyOn(console, 'log').mockImplementation(() => {});
    respond(async (request) => request.url === tokenUrl ? tokenResponse() : Response.json({ id: 42, state: 'OPEN', title: 'Feature' }));
    await main(['pr', 'view', '42', '-R', 'team/project']);
    expect((await readLogin(env))?.refresh_token).toBe('refresh-new');
    expect(await stat(lock).catch(() => undefined)).toBeUndefined();
  });

  test.each([400, 401])('asks for a new login when refresh fails with HTTP %d', async (status) => {
    await saveLogin(env, storedLogin(-1000));
    const network = respond(async (request) => {
      expect(request.url).toBe(tokenUrl);
      await expectRefreshRequest(request);
      return Response.json({ error: 'invalid_grant' }, { status });
    });
    await expect(main(['pr', 'view', '42', '-R', 'team/project']))
      .rejects.toThrow('Stored Bitbucket login expired or was revoked; run bb auth login.');
    expect(network).toHaveBeenCalledTimes(1);
    expect((await readLogin(env))?.refresh_token).toBe('refresh-old');
    expect(await stat(`${credentialsPath(env)}.lock`).catch(() => undefined)).toBeUndefined();
  });

  test('does not retry a rejected stored token and suggests logging in again', async () => {
    await saveLogin(env, storedLogin(3_600_000));
    const network = respond(() => Response.json({ error: { message: 'Unauthorized' } }, { status: 401 }));
    const failure = await main(['pr', 'view', '42', '-R', 'team/project']).catch((error: Error) => error);
    expect((failure as Error).message).toContain('Bitbucket HTTP 401: Unauthorized');
    expect((failure as Error).message).toContain('run bb auth login');
    expect(network).toHaveBeenCalledTimes(1);
  });

  test('rejects an invalid credentials file without printing it', async () => {
    await mkdir(join(configHome, 'bitbucket-cli'), { recursive: true });
    await writeFile(credentialsPath(env), JSON.stringify({ access_token: 'access-old' }));
    const network = respond(() => { throw new Error('Unexpected request'); });
    const failure = await main(['pr', 'view', '42', '-R', 'team/project']).catch((error: Error) => error);
    expect((failure as Error).message).toContain('is invalid; run bb auth login');
    expect((failure as Error).message).not.toContain('access-old');
    expect(network).not.toHaveBeenCalled();
  });
});

describe('auth status and logout', () => {
  async function output(args: string[]) {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await main(args);
      return log.mock.calls.map((call) => String(call[0])).join('\n');
    } finally {
      log.mockRestore();
    }
  }

  test('reports the stored login without secrets or network requests', async () => {
    const login = storedLogin(3_600_000);
    await saveLogin(env, login);
    const network = respond(() => { throw new Error('Unexpected request'); });
    const human = await output(['auth', 'status']);
    expect(human).toContain('Active: stored OAuth login');
    expect(human).toContain('Consumer key: present');
    expect(human).toContain('Scopes: pullrequest account');
    expect(human).toContain(new Date(login.expires_at).toISOString());
    const json = JSON.parse(await output(['auth', 'status', '--json']));
    expect(json).toEqual({
      source: 'stored OAuth login',
      credentials_file: credentialsPath(env),
      stored_login: { active: true, consumer_key_present: true, scopes: ['pullrequest', 'account'], access_token_expires_at: new Date(login.expires_at).toISOString(), access_token_expired: false },
    });
    for (const secret of secrets) expect(`${human}\n${JSON.stringify(json)}`).not.toContain(secret);
    expect(network).not.toHaveBeenCalled();
  });

  test('reports environment credentials as active and the stored login as inactive', async () => {
    await saveLogin(env, storedLogin(-1000));
    process.env.BITBUCKET_ACCESS_TOKEN = 'env-access-token';
    const human = await output(['auth', 'status']);
    expect(human).toContain('Active: environment access token');
    expect(human).toContain('inactive');
    expect(human).toContain('Access token expired');
    for (const secret of secrets) expect(human).not.toContain(secret);
    delete process.env.BITBUCKET_ACCESS_TOKEN;
    process.env.BITBUCKET_EMAIL = 'dev@example.com';
    process.env.BITBUCKET_API_TOKEN = 'env-access-token';
    expect(JSON.parse(await output(['auth', 'status', '--json'])).source).toBe('environment API token');
  });

  test('reports anonymous access without a login', async () => {
    expect(JSON.parse(await output(['auth', 'status', '--json']))).toMatchObject({ source: 'anonymous', stored_login: null });
  });

  test('logout removes the login and lock and is idempotent', async () => {
    await saveLogin(env, storedLogin(3_600_000));
    await writeFile(`${credentialsPath(env)}.lock`, '');
    expect(await output(['auth', 'logout'])).toBe('Removed the stored Bitbucket login.');
    expect(await readdir(join(configHome, 'bitbucket-cli'))).toEqual([]);
    expect(await output(['auth', 'logout'])).toBe('No stored Bitbucket login.');
  });

  test('validates auth arguments before doing anything', async () => {
    const network = respond(() => { throw new Error('Unexpected request'); });
    for (const [args, message] of [
      [['auth', 'login', '--json'], '--json is not supported by auth login'],
      [['auth', 'login', '--port', '0'], '--port must be'],
      [['auth', 'login', '--port', '70000'], '--port must be'],
      [['auth', 'login', '--port', '80a'], '--port must be'],
      [['auth', 'status', '--port', '8976'], '--port is only supported by auth login'],
      [['pr', 'list', '-R', 'team/project', '--port', '8976'], '--port is only supported by auth login'],
      [['auth', 'logout', '--json'], '--json is not supported by auth logout'],
      [['auth', 'logout', '-R', 'team/project'], '--repo is not supported by auth logout'],
      [['auth', 'status', 'extra'], 'Unexpected or missing arguments'],
      [['auth', 'refresh'], 'Unknown command'],
    ] as const) await expect(main([...args])).rejects.toThrow(message);
    expect(network).not.toHaveBeenCalled();
  });
});
