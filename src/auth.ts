import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { openBrowser } from './browser.ts';
import { authorization, type Env } from './config.ts';

export type Consumer = { key: string; secret: string };
export type StoredLogin = {
  consumer: Consumer;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
};
export type Prompt = (question: string, hidden: boolean) => Promise<string>;
export type LoginOptions = {
  port?: number;
  openUrl?: (url: string) => void;
  prompt?: Prompt;
  fetchImpl?: typeof fetch;
  notify?: (line: string) => void;
  now?: () => number;
};

const authorizeUrl = 'https://bitbucket.org/site/oauth2/authorize';
const tokenUrl = 'https://bitbucket.org/site/oauth2/access_token';
export const defaultPort = 8976;
const refreshMarginMs = 5 * 60_000;
const loginTimeoutMs = 5 * 60_000;
const lockWaitMs = 10_000;
const staleLockMs = 30_000;
// Keep a token request well under the stale-lock age so waiters never break a live refresh.
const tokenRequestTimeoutMs = 20_000;
const reloginMessage = 'Stored Bitbucket login expired or was revoked; run bb auth login.';

export function credentialsPath(env: Env): string {
  const base = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(env.HOME || homedir(), '.config');
  return join(base, 'bitbucket-cli', 'credentials.json');
}

function lockPath(env: Env) {
  return `${credentialsPath(env)}.lock`;
}

function errorCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export async function readLogin(env: Env): Promise<StoredLogin | undefined> {
  const path = credentialsPath(env);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  const login = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {};
  const consumer = typeof login.consumer === 'object' && login.consumer !== null ? login.consumer as Record<string, unknown> : {};
  if (!nonEmpty(consumer.key) || !nonEmpty(consumer.secret) || !nonEmpty(login.access_token) || !nonEmpty(login.refresh_token) ||
      typeof login.expires_at !== 'number' || !Number.isFinite(login.expires_at) || typeof login.scope !== 'string') {
    throw new Error(`Stored Bitbucket login at ${path} is invalid; run bb auth login.`);
  }
  return {
    consumer: { key: consumer.key, secret: consumer.secret },
    access_token: login.access_token,
    refresh_token: login.refresh_token,
    expires_at: login.expires_at,
    scope: login.scope,
  };
}

export async function saveLogin(env: Env, login: StoredLogin) {
  const path = credentialsPath(env);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temp = join(dir, `.credentials.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(login, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function deleteLogin(env: Env): Promise<boolean> {
  const path = credentialsPath(env);
  const existed = await stat(path).then(() => true, () => false);
  await rm(path, { force: true });
  await rm(lockPath(env), { force: true });
  return existed;
}

function oauthErrorCode(value: unknown) {
  return typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : undefined;
}

async function requestToken(consumer: Consumer, params: Record<string, string>, fetchImpl: typeof fetch, now: () => number, refreshing: boolean): Promise<StoredLogin> {
  let response: Response;
  try {
    response = await fetchImpl(new Request(tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${consumer.key}:${consumer.secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(tokenRequestTimeoutMs),
    }));
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'could not connect';
    throw new Error(`Bitbucket token request ${reason}.`);
  }
  const data: unknown = await response.json().catch(() => undefined);
  const body = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {};
  if (!response.ok) {
    if (refreshing && (response.status === 400 || response.status === 401)) throw new Error(reloginMessage);
    const code = oauthErrorCode(body.error);
    throw new Error(`Bitbucket token ${refreshing ? 'refresh' : 'exchange'} failed (HTTP ${response.status}${code ? ` ${code}` : ''}).`);
  }
  const scope = typeof body.scope === 'string' ? body.scope : typeof body.scopes === 'string' ? body.scopes : '';
  if (!nonEmpty(body.access_token) || !nonEmpty(body.refresh_token) ||
      typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0 ||
      (body.token_type !== undefined && (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer'))) {
    throw new Error('Bitbucket returned an unexpected token response.');
  }
  return {
    consumer,
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: now() + body.expires_in * 1000,
    scope: scope.trim(),
  };
}

async function withLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    try {
      await (await open(path, 'wx', 0o600)).close();
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const info = await stat(path).catch(() => undefined);
    if (info && Date.now() - info.mtimeMs > staleLockMs) await rm(path, { force: true });
    else if (Date.now() >= deadline) throw new Error('Timed out waiting for another bb process to refresh the stored Bitbucket login.');
    else if (info) await Bun.sleep(100);
  }
  try {
    return await task();
  } finally {
    await rm(path, { force: true });
  }
}

function expiresSoon(login: StoredLogin, now: number) {
  return login.expires_at - now <= refreshMarginMs;
}

async function refreshLogin(env: Env, fetchImpl: typeof fetch, now: () => number): Promise<StoredLogin> {
  return withLock(lockPath(env), async () => {
    // Refresh tokens rotate, so a login another process refreshed while we waited must be reused.
    const latest = await readLogin(env);
    if (!latest) throw new Error('No stored Bitbucket login; run bb auth login.');
    if (!expiresSoon(latest, now())) return latest;
    const refreshed = await requestToken(latest.consumer, { grant_type: 'refresh_token', refresh_token: latest.refresh_token }, fetchImpl, now, true);
    try {
      await saveLogin(env, refreshed);
    } catch {
      throw new Error('Bitbucket refreshed the login, but it could not be saved; run bb auth login.');
    }
    return refreshed;
  });
}

export function storedAuthorization(env: Env, fetchImpl: typeof fetch, now: () => number = Date.now) {
  let current: Promise<StoredLogin | undefined> | undefined;
  return async (): Promise<string | undefined> => {
    const loaded = current ??= readLogin(env);
    let login = await loaded;
    if (!login) return undefined;
    if (expiresSoon(login, now())) {
      if (current === loaded) current = refreshLogin(env, fetchImpl, now);
      login = (await current)!;
    }
    return `Bearer ${login.access_token}`;
  };
}

export function environmentSource(env: Env) {
  if (!authorization(env)) return undefined;
  return env.BITBUCKET_ACCESS_TOKEN ? 'environment access token' : 'environment API token';
}

export async function authStatus(env: Env, now = Date.now()) {
  const environment = environmentSource(env);
  const login = await readLogin(env);
  return {
    source: environment ?? (login ? 'stored OAuth login' : 'anonymous'),
    credentials_file: credentialsPath(env),
    stored_login: login ? {
      active: environment === undefined,
      consumer_key_present: true,
      scopes: login.scope.split(/\s+/).filter(Boolean),
      access_token_expires_at: new Date(login.expires_at).toISOString(),
      access_token_expired: login.expires_at <= now,
    } : null,
  };
}

function terminalPrompt(question: string, hidden: boolean): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003' || char === '\u0004') return finish(new Error('Login cancelled.'));
        if (char === '\u007f' || char === '\b') {
          if (value && !hidden) process.stderr.write('\b \b');
          value = value.slice(0, -1);
        } else if (char >= ' ') {
          value += char;
          if (!hidden) process.stderr.write(char);
        }
      }
    };
    stdin.on('data', onData);
  });
}

export function stdinPrompt(isTTY = process.stdin.isTTY === true): Prompt {
  if (isTTY) return terminalPrompt;
  let lines: Promise<string[]> | undefined;
  let index = 0;
  return async () => {
    lines ??= Bun.stdin.text().then((text) => text.split(/\r?\n/));
    return (await lines)[index++] ?? '';
  };
}

function page(message: string, status = 200) {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' } });
}

export async function login(env: Env, options: LoginOptions = {}): Promise<StoredLogin> {
  const {
    port = defaultPort,
    openUrl = (url: string) => openBrowser(url),
    prompt = stdinPrompt(),
    fetchImpl = fetch,
    notify = (line: string) => console.error(line),
    now = Date.now,
  } = options;
  const stored = await readLogin(env).catch(() => undefined);
  let consumer = stored?.consumer;
  if (!consumer) {
    const key = (await prompt('Bitbucket OAuth consumer key: ', false)).trim();
    const secret = (await prompt('Bitbucket OAuth consumer secret: ', true)).trim();
    if (!key || !secret) throw new Error('An OAuth consumer key and secret are required.');
    consumer = { key, secret };
  }
  const state = randomBytes(32).toString('base64url');
  let settle!: { resolve: (login: StoredLogin) => void; reject: (error: Error) => void };
  const result = new Promise<StoredLogin>((resolve, reject) => { settle = { resolve, reject }; });
  let handled = false;
  let redirectUri = '';
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname !== '/callback') return page('Not found.', 404);
        if (handled) return page('This login request was already handled.', 409);
        handled = true;
        try {
          if (url.searchParams.get('state') !== state) throw new Error('OAuth state mismatch; login aborted.');
          const denied = url.searchParams.get('error');
          if (denied !== null) throw new Error(`Bitbucket authorization failed${oauthErrorCode(denied) ? `: ${denied}` : ''}.`);
          const code = url.searchParams.get('code');
          if (!code) throw new Error('The Bitbucket callback did not include an authorization code.');
          const login = await requestToken(consumer, { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, fetchImpl, now, false);
          await saveLogin(env, login);
          settle.resolve(login);
          return page('Bitbucket login complete. You can close this tab and return to the terminal.');
        } catch (error) {
          settle.reject(error instanceof Error ? error : new Error('Bitbucket login failed.'));
          return page('Bitbucket login failed. Return to the terminal for details.', 400);
        }
      },
    });
  } catch {
    throw new Error(`Cannot listen on 127.0.0.1:${port}. Free the port, or use --port with a matching consumer callback URL.`);
  }
  redirectUri = `http://127.0.0.1:${server.port}/callback`;
  const authorize = new URL(authorizeUrl);
  authorize.search = new URLSearchParams({ client_id: consumer.key, response_type: 'code', state, redirect_uri: redirectUri }).toString();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    notify(`Open this URL to authorize bb (waiting for ${redirectUri}):\n${authorize.href}`);
    try {
      openUrl(authorize.href);
    } catch {
      notify('Could not launch the browser; open the URL above.');
    }
    return await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for the Bitbucket authorization callback.')), loginTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    void server.stop();
  }
}
