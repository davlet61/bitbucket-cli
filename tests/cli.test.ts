import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pendingBody } from '../src/comments.ts';
import { createBitbucketClient, collectPages } from '../src/api.ts';
import { main } from '../src/cli.ts';
import { authorization, parseRepository, repositoryFromRemote } from '../src/config.ts';
import { getRepositoriesByWorkspaceByRepoSlugPullrequests as listPullrequests } from '../src/generated/sdk.gen.ts';

const authKeys = ['BITBUCKET_EMAIL', 'BITBUCKET_API_TOKEN', 'BITBUCKET_ACCESS_TOKEN'] as const;
const originalEnv = Object.fromEntries(authKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalLog = console.log;

beforeEach(() => {
  for (const key of authKeys) delete process.env[key];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  for (const key of authKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

function respond(handler: (request: Request) => Response | Promise<Response>) {
  return spyOn(globalThis, 'fetch').mockImplementation(Object.assign(
    async (input: RequestInfo | URL) => handler(input as Request),
    { preconnect: originalFetch.preconnect },
  ));
}

const collection = 'https://api.bitbucket.org/2.0/repositories/team/project/pullrequests';

describe('configuration', () => {
  test('supports API tokens and bearer tokens without silently mixing credentials', () => {
    expect(authorization({})).toBeUndefined();
    expect(authorization({ BITBUCKET_ACCESS_TOKEN: 'access' })).toBe('Bearer access');
    expect(authorization({ BITBUCKET_EMAIL: 'dev@example.com', BITBUCKET_API_TOKEN: 'token' }))
      .toBe(`Basic ${Buffer.from('dev@example.com:token').toString('base64')}`);
    expect(() => authorization({ BITBUCKET_EMAIL: 'dev@example.com' })).toThrow('Set both');
    expect(() => authorization({ BITBUCKET_ACCESS_TOKEN: 'access', BITBUCKET_API_TOKEN: 'token' })).toThrow('not both');
  });

  test('recognizes Cloud origins without accepting arbitrary hosts or traversal', () => {
    for (const remote of [
      'git@bitbucket.org:team/project.git',
      'ssh://git@bitbucket.org/team/project.git',
      'https://bitbucket.org/team/project.git',
      'https://user@bitbucket.org/team/project',
    ]) expect(repositoryFromRemote(remote)).toEqual({ workspace: 'team', repo_slug: 'project' });
    for (const remote of ['git@github.com:team/project.git', 'https://bitbucket.org.evil.test/team/project']) {
      expect(() => repositoryFromRemote(remote)).toThrow('not a Bitbucket');
    }
    for (const repo of ['team/..', '../project', 'team/project/extra', 'team/project?q=bad']) {
      expect(() => parseRepository(repo)).toThrow('workspace/repo-slug');
    }
  });
});

describe('CLI through the generated SDK', () => {
  test('help needs neither Git configuration nor credentials', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const network = respond(() => { throw new Error('Unexpected network request'); });
    await main(['--help']);
    expect(log.mock.calls[0]?.[0]).toContain('bb pr list');
    expect(network).not.toHaveBeenCalled();
  });

  test('lists all pages as JSON and preserves authentication on subsequent pages', async () => {
    process.env.BITBUCKET_ACCESS_TOKEN = 'test-token';
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const urls: string[] = [];
    respond((request) => {
      urls.push(request.url);
      expect(request.headers.get('Authorization')).toBe('Bearer test-token');
      if (urls.length === 1) return Response.json({ values: [{ id: 1, title: 'First' }], next: `${collection}?page=2&state=OPEN` });
      return Response.json({ values: [{ id: 2, title: 'Second' }] });
    });
    await main(['pr', 'list', '-R', 'team/project', '--json']);
    expect(urls).toEqual([`${collection}?state=OPEN`, `${collection}?page=2&state=OPEN`]);
    expect(JSON.parse(log.mock.calls[0]?.[0])).toEqual([{ id: 1, title: 'First' }, { id: 2, title: 'Second' }]);
  });

  test('views a PR and strips terminal escape sequences', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    respond((request) => {
      expect(request.url).toBe(`${collection}/42`);
      return Response.json({ id: 42, title: '\u001b[31mReview me\u001b[0m', state: 'OPEN', summary: { raw: 'Description' } });
    });
    await main(['pr', 'view', '42', '--repo', 'team/project']);
    expect(log.mock.calls[0]?.[0]).toContain('#42  OPEN  Review me');
    expect(log.mock.calls[0]?.[0]).toContain('Description');
    expect(log.mock.calls[0]?.[0]).not.toContain('\u001b');
  });

  test('renders inherited inline comment fields, including pending state', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    respond((request) => {
      expect(request.url).toBe(`${collection}/42/comments`);
      return Response.json({ values: [{ type: 'pullrequest_comment', id: 7, pending: true, user: { display_name: 'Reviewer' }, inline: { path: 'src/file.ts', to: 9 }, content: { raw: 'Check this' } }] });
    });
    await main(['pr', 'comments', '42', '-R', 'team/project']);
    expect(log.mock.calls[0]?.[0]).toBe('#7  Reviewer [pending]\nsrc/file.ts:9\nCheck this');
  });

  test('reads diffs as text rather than JSON', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    respond((request) => {
      expect(request.url).toBe(`${collection}/42/diff`);
      return new Response('diff --git a/file b/file\n+new line', { headers: { 'Content-Type': 'text/plain' } });
    });
    await main(['pr', 'diff', '42', '-R', 'team/project']);
    expect(log.mock.calls[0]?.[0]).toContain('+new line');
  });

  test('validates arguments before making requests', async () => {
    const network = respond(() => { throw new Error('Unexpected request'); });
    for (const args of [
      ['pr', 'publish', '42'], ['pr', 'view'], ['pr', 'view', '-1'],
      ['pr', 'view', '1.5'], ['pr', 'view', '9007199254740992'],
      ['pr', 'list', 'extra'], ['pr', 'list', '--state', 'INVALID'],
      ['pr', 'view', '42', '--state', 'OPEN'], ['pr', 'list', '--typo'],
    ]) await expect(main(args)).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });
});

describe('pending comment workflow', () => {
  test('omits the type discriminator rejected by the live comment endpoint', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const network = respond(async (request) => {
      const body = await request.json();
      // Recorded rejection from the authorized pending-only probe on PR #965.
      if ('type' in body) return Response.json({
        error: { message: 'Bad request', fields: { type: 'extra keys not allowed' } },
      }, { status: 400 });
      return Response.json({ ...body, type: 'pullrequest_comment', id: 7 }, { status: 201 });
    });
    for (const anchor of [[], ['--file', 'src/file.ts', '--line', '9']]) {
      await main(['pr', 'comment', 'add', '42', '-R', 'team/project', '--body', 'Diagnostic fixture', '--json', ...anchor]);
    }
    expect(network).toHaveBeenCalledTimes(2);
    for (const call of log.mock.calls) expect(JSON.parse(call[0])).toMatchObject({ id: 7, pending: true });
  });

  test('creates a pending inline comment by default through the SDK', async () => {
    process.env.BITBUCKET_ACCESS_TOKEN = 'test-token';
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const network = respond(async (request) => {
      expect(request.url).toBe(`${collection}/42/comments`);
      expect(request.method).toBe('POST');
      expect(request.headers.get('Authorization')).toBe('Bearer test-token');
      const body = await request.json();
      expect(body).toEqual({ pending: true, content: { raw: 'Check this' }, inline: { path: 'src/file.ts', to: 9 } });
      return Response.json({ ...body, id: 7 }, { status: 201 });
    });
    await main(['pr', 'comment', 'add', '42', '-R', 'team/project', '--body', 'Check this', '--file', 'src/file.ts', '--line', '9', '--json']);
    expect(network).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]?.[0])).toMatchObject({ id: 7, pending: true });
  });

  test('maps old-side anchors and preserves file body content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bb-body-'));
    try {
      const file = join(dir, 'comment.md');
      await writeFile(file, 'Review\n\n```ts\noldCode();\n```\n');
      expect(await pendingBody({ 'body-file': file, file: 'src/file.ts', line: '12', side: 'old' })).toEqual({
        pending: true,
        content: { raw: 'Review\n\n```ts\noldCode();\n```\n' },
        inline: { path: 'src/file.ts', from: 12 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('creates general pending comments with an explicit --pending flag', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    respond(async (request) => {
      expect(await request.json()).toEqual({ pending: true, content: { raw: 'General note' } });
      return Response.json({ id: 8, pending: true, content: { raw: 'General note' } }, { status: 201 });
    });
    await main(['pr', 'comment', 'add', '42', '-R', 'team/project', '--body', 'General note', '--pending']);
    expect(log.mock.calls[0]?.[0]).toContain('Created pending comment #8');
  });

  test('filters pending comments across every page and excludes deleted comments', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    respond((request) => request.url.endsWith('page=2')
      ? Response.json({ values: [{ id: 4, pending: true }, { id: 5, pending: true, deleted: true }] })
      : Response.json({ values: [{ id: 1, pending: false }, { id: 2 }, { id: 3, pending: true }], next: `${collection}/42/comments?page=2` }));
    for (const args of [['pr', 'comment', 'pending', '42'], ['pr', 'comments', '42', '--pending']]) {
      await main([...args, '-R', 'team/project', '--json']);
    }
    for (const call of log.mock.calls) expect(JSON.parse(call[0])).toEqual([{ id: 3, pending: true }, { id: 4, pending: true }]);
  });

  test('publishes an explicit pending comment without overwriting its content', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const network = respond(async (request) => {
      expect(request.url).toBe(`${collection}/42/comments/7`);
      if (request.method === 'GET') return Response.json({ id: 7, pending: true, content: { raw: 'Original' } });
      expect(request.method).toBe('PUT');
      expect(await request.json()).toEqual({ pending: false });
      return Response.json({ id: 7, pending: false, content: { raw: 'Original' } });
    });
    await main(['pr', 'comment', 'publish', '42', '7', '-R', 'team/project', '--json']);
    expect(network).toHaveBeenCalledTimes(2);
    expect(JSON.parse(log.mock.calls[0]?.[0])).toMatchObject({ id: 7, pending: false });
  });

  test('does not rewrite an already-published comment on a rerun', async () => {
    spyOn(console, 'log').mockImplementation(() => {});
    const network = respond((request) => {
      expect(request.method).toBe('GET');
      return Response.json({ id: 7, pending: false });
    });
    await main(['pr', 'comment', 'publish', '42', '7', '-R', 'team/project']);
    expect(network).toHaveBeenCalledTimes(1);
  });

  test('refuses publication when pending state is unknown or comment is deleted', async () => {
    let current: object = { id: 7 };
    const network = respond((request) => {
      expect(request.method).toBe('GET');
      return Response.json(current);
    });
    const args = ['pr', 'comment', 'publish', '42', '7', '-R', 'team/project'];
    await expect(main(args)).rejects.toThrow('Cannot determine');
    current = { id: 7, pending: true, deleted: true };
    await expect(main(args)).rejects.toThrow('deleted');
    expect(network).toHaveBeenCalledTimes(2);
  });

  test('does not report success if Bitbucket ignores pending on creation or publication', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    respond((request) => {
      if (request.method === 'POST') return Response.json({ id: 7, pending: false }, { status: 201 });
      return Response.json({ id: 7, pending: true });
    });
    await expect(main(['pr', 'comment', 'add', '42', '-R', 'team/project', '--body', 'Note'])).rejects.toThrow('may already be visible');
    await expect(main(['pr', 'comment', 'publish', '42', '7', '-R', 'team/project'])).rejects.toThrow('did not confirm publication');
    expect(log).not.toHaveBeenCalled();
  });

  test('never automatically retries ambiguous write failures', async () => {
    const network = respond(() => { throw new Error('Connection reset'); });
    await expect(main(['pr', 'comment', 'add', '42', '-R', 'team/project', '--body', 'Note']))
      .rejects.toThrow('inspect the PR before re-running');
    expect(network).toHaveBeenCalledTimes(1);
  });

  test('validates comment inputs before any request', async () => {
    const network = respond(() => { throw new Error('Unexpected request'); });
    const add = ['pr', 'comment', 'add', '42', '-R', 'team/project'];
    for (const flags of [
      [], ['--body', ' '], ['--body', 'x', '--body-file', 'file'],
      ['--body', 'x', '--file', 'src/file.ts'], ['--body', 'x', '--line', '2'],
      ['--body', 'x', '--file', '../file', '--line', '2'],
      ['--body', 'x', '--file', '/file', '--line', '2'],
      ['--body', 'x', '--file', 'file', '--line', '0'],
      ['--body', 'x', '--file', 'file', '--line', '2.5'],
      ['--body', 'x', '--file', 'file', '--line', '2', '--side', 'wrong'],
      ['--body', 'x', '--side', 'old'],
    ]) await expect(main([...add, ...flags])).rejects.toThrow();
    for (const args of [
      ['pr', 'comment', 'publish', '42'], ['pr', 'comment', 'publish', '42', 'all'],
      ['pr', 'comment', 'publish', '42', '7', '--body', 'overwrite'],
      ['pr', 'comment', 'pending', '42', '--body', 'x'],
      ['pr', 'view', '42', '--pending'], ['pr', 'list', '--file', 'file'],
    ]) await expect(main(args)).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });
});

describe('comment updates', () => {
  test.each([true, false])('updates text without the pending field rejected by Bitbucket (state=%s)', async (pending) => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const inline = { path: 'src/file.ts', to: 9 };
    const network = respond(async (request) => {
      expect(request.url).toBe(`${collection}/42/comments/7`);
      if (request.method === 'GET') return Response.json({ id: 7, pending, inline, content: { raw: 'Original' } });
      expect(request.method).toBe('PUT');
      const body = await request.json();
      // Replay the reported live PUT rejection; POST accepts this field, PUT does not.
      if ('pending' in body) return Response.json({
        error: { message: 'Bad request', fields: { pending: 'extra keys not allowed' } },
      }, { status: 400 });
      expect(body).toEqual({ content: { raw: 'Revised\n\n**finding**' } });
      return Response.json({ id: 7, pending, inline, content: { raw: 'Revised\n\n**finding**' } });
    });
    await main(['pr', 'comment', 'update', '42', '7', '-R', 'team/project', '--body', 'Revised\n\n**finding**', '--json']);
    expect(network).toHaveBeenCalledTimes(2);
    expect(JSON.parse(log.mock.calls[0]?.[0])).toEqual({ id: 7, pending, inline, content: { raw: 'Revised\n\n**finding**' } });
  });

  test('accepts --body-file and reports the retained state in human output', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const dir = await mkdtemp(join(tmpdir(), 'bb-update-'));
    try {
      const file = join(dir, 'comment.md');
      const raw = 'Updated from file\n';
      await writeFile(file, raw);
      respond(async (request) => {
        if (request.method === 'GET') return Response.json({ id: 7, pending: true });
        expect(await request.json()).toEqual({ content: { raw } });
        return Response.json({ id: 7, pending: true, content: { raw } });
      });
      await main(['pr', 'comment', 'update', '42', '7', '-R', 'team/project', '--body-file', file]);
      expect(log.mock.calls[0]?.[0]).toContain('Updated comment #7 (pending).');
      expect(log.mock.calls[0]?.[0]).toContain(raw);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses deleted or unknown-state comments before writing', async () => {
    let current: object = { id: 7, pending: true, deleted: true };
    const network = respond((request) => {
      expect(request.method).toBe('GET');
      return Response.json(current);
    });
    const args = ['pr', 'comment', 'update', '42', '7', '-R', 'team/project', '--body', 'Revised'];
    await expect(main(args)).rejects.toThrow('deleted');
    current = { id: 7 };
    await expect(main(args)).rejects.toThrow('Cannot determine');
    expect(network).toHaveBeenCalledTimes(2);
  });

  test('does not retry a failed PUT or claim success', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const network = respond((request) => {
      if (request.method === 'GET') return Response.json({ id: 7, pending: true });
      expect(request.method).toBe('PUT');
      return Response.json({ error: { message: 'Forbidden' } }, { status: 403 });
    });
    await expect(main(['pr', 'comment', 'update', '42', '7', '-R', 'team/project', '--body', 'Revised']))
      .rejects.toThrow('Updating #7 failed: Bitbucket HTTP 403: Forbidden. Not retried');
    expect(network).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalled();
  });

  test('rejects an update response with changed state, wrong text, or wrong id', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    let result: object;
    respond((request) => Response.json(request.method === 'GET' ? { id: 7, pending: true } : result));
    for (const invalid of [
      { id: 7, pending: false, content: { raw: 'Revised' } },
      { id: 7, pending: true, content: { raw: 'Original' } },
      { id: 8, pending: true, content: { raw: 'Revised' } },
    ]) {
      result = invalid;
      await expect(main(['pr', 'comment', 'update', '42', '7', '-R', 'team/project', '--body', 'Revised']))
        .rejects.toThrow('did not confirm');
    }
    expect(log).not.toHaveBeenCalled();
  });

  test('rejects invalid update arguments without network requests', async () => {
    const network = respond(() => { throw new Error('Unexpected request'); });
    const base = ['pr', 'comment', 'update', '42', '7', '-R', 'team/project'];
    for (const flags of [
      [], ['--body', ' '], ['--body', 'x', '--body-file', 'file'],
      ['--body', 'x', '--file', 'src/file.ts'], ['--body', 'x', '--line', '1'],
      ['--body', 'x', '--side', 'old'], ['--body', 'x', '--pending'],
    ]) await expect(main([...base, ...flags])).rejects.toThrow();
    await expect(main(['pr', 'comment', 'update', '42', '--body', 'x'])).rejects.toThrow();
    await expect(main(['pr', 'comment', 'update', '42', '0', '--body', 'x'])).rejects.toThrow('Comment id');
    expect(network).not.toHaveBeenCalled();
  });
});

describe('API failures and pagination safety', () => {
  test('preserves validation diagnostics through comment creation errors without retrying', async () => {
    // Synthetic error envelope: tests diagnostic preservation, not the live 400's cause.
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const network = respond(() => Response.json({
      type: 'error',
      error: {
        message: 'Bad request',
        detail: 'Validation failed for the submitted comment.',
        fields: { content: ['Invalid content.'] },
        data: { code: 'validation_failed' },
      },
      unrelated: 'DO_NOT_DUMP_THE_FULL_RESPONSE',
    }, { status: 400 }));
    const failure = await main(['pr', 'comment', 'add', '42', '-R', 'team/project', '--body', 'Diagnostic fixture'])
      .then(() => { throw new Error('Expected creation to fail'); }, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('Bitbucket HTTP 400: Bad request');
    expect(message).toContain('Validation failed for the submitted comment.');
    expect(message).toContain('fields: {"content":["Invalid content."]}');
    expect(message).toContain('data: {"code":"validation_failed"}');
    expect(message).not.toContain('DO_NOT_DUMP_THE_FULL_RESPONSE');
    expect(network).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  test('reports HTTP errors and rate-limit guidance without credentials', async () => {
    respond(() => Response.json({ error: { message: 'Slow down' } }, { status: 429, headers: { 'Retry-After': '60' } }));
    const client = createBitbucketClient({ BITBUCKET_ACCESS_TOKEN: 'secret' });
    await expect(listPullrequests({ client, path: { workspace: 'team', repo_slug: 'project' }, throwOnError: true }))
      .rejects.toThrow('Bitbucket HTTP 429: Slow down (Retry-After: 60)');
  });

  test('reports non-JSON errors without dumping response bodies', async () => {
    respond(() => new Response('<html>Unauthorized</html>', { status: 401 }));
    await expect(main(['pr', 'list', '-R', 'team/project'])).rejects.toThrow('Bitbucket HTTP 401');
  });

  test('does not follow untrusted next URLs', async () => {
    const network = respond(() => { throw new Error('Credentials would leak'); });
    const client = createBitbucketClient({ BITBUCKET_ACCESS_TOKEN: 'secret' });
    for (const next of ['https://evil.test/2.0/foo', 'http://api.bitbucket.org/2.0/foo', 'https://api.bitbucket.org/not-api', 'https://user@api.bitbucket.org/2.0/foo']) {
      await expect(collectPages(client, { values: [], next })).rejects.toThrow('untrusted');
    }
    expect(network).not.toHaveBeenCalled();
  });

  test('stops cyclic pagination instead of looping forever', async () => {
    const next = `${collection}?page=2`;
    const network = respond(() => Response.json({ values: [], next }));
    await expect(collectPages(createBitbucketClient({}), { values: [], next })).rejects.toThrow('repeated pagination');
    expect(network).toHaveBeenCalledTimes(1);
  });
});
