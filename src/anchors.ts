import type { Client } from './generated/client/index.ts';
import { getRepositoriesByWorkspaceByRepoSlugPullrequestsByPullRequestIdDiff as getDiff } from './generated/sdk.gen.ts';

type PrPath = { workspace: string; repo_slug: string; pull_request_id: number };
export type Side = 'new' | 'old';
type Lines = { visible: Set<number>; changed: Set<number> };
export type DiffLines = Record<Side, Map<string, Lines>>;
export type AnchorStatus = 'changed' | 'context' | 'outside';

const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripPrefix(path: string): string | undefined {
  if (path === '/dev/null') return undefined;
  return path.replace(/^[ab]\//, '');
}

export function parseDiff(diff: string): DiffLines {
  const result: DiffLines = { new: new Map(), old: new Map() };
  let paths: Partial<Record<Side, string>> = {};
  let line: Record<Side, number> | undefined;
  const mark = (side: Side, changed: boolean) => {
    const path = paths[side] ?? paths[side === 'new' ? 'old' : 'new'];
    if (!path || !line) return;
    const lines = result[side].get(path) ?? { visible: new Set(), changed: new Set() };
    result[side].set(path, lines);
    lines.visible.add(line[side]);
    if (changed) lines.changed.add(line[side]);
    line[side] += 1;
  };
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) {
      paths = {};
      line = undefined;
    } else if (!line && text.startsWith('--- ')) {
      paths.old = stripPrefix(text.slice(4));
    } else if (!line && text.startsWith('+++ ')) {
      paths.new = stripPrefix(text.slice(4));
    } else if (hunk.test(text)) {
      const [, old, added] = text.match(hunk)!;
      line = { old: Number(old), new: Number(added) };
    } else if (line && text.startsWith('+')) {
      mark('new', true);
    } else if (line && text.startsWith('-')) {
      mark('old', true);
    } else if (line && text.startsWith(' ')) {
      mark('new', false);
      mark('old', false);
    }
  }
  return result;
}

export function anchorStatus(lines: DiffLines, side: Side, path: string, line: number): AnchorStatus {
  const file = lines[side].get(path);
  if (!file?.visible.has(line)) return 'outside';
  return file.changed.has(line) ? 'changed' : 'context';
}

export async function readDiffLines(client: Client, path: PrPath): Promise<DiffLines> {
  const { data } = await getDiff({ client, path, parseAs: 'text', throwOnError: true });
  return parseDiff(String(data));
}

export function ranges(lines: Iterable<number>): string {
  const sorted = [...lines].sort((a, b) => a - b);
  const spans: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j += 1;
    spans.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return spans.join(', ');
}
