import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'U';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  add: number;
  del: number;
  binary: boolean;
}

export interface RepoSnapshot {
  branch: string;
  head: string;
  headSubject: string;
  base: string;
  baseSource: 'configured' | 'git-config' | 'auto' | 'fallback';
  mergeBase: string;
  files: ChangedFile[];
}

export type DiffMode = 'branch' | 'head';

/** Runs git; non-zero exit throws unless the code is listed in `okCodes`. */
export async function git(cwd: string, args: string[], okCodes: number[] = [0]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (!okCodes.includes(code)) throw new Error(`git ${args.join(' ')} (exit ${code}): ${err.trim()}`);
  return out;
}

const tryGit = async (cwd: string, args: string[]) => {
  try { return (await git(cwd, args)).trim(); } catch { return ''; }
};

export async function isRepo(path: string): Promise<boolean> {
  return (await tryGit(path, ['rev-parse', '--is-inside-work-tree'])) === 'true';
}

export async function repoRoot(path: string): Promise<string> {
  return git(path, ['rev-parse', '--show-toplevel']).then(s => s.trim());
}

/** Branches a feature branch is usually cut from, most specific first. */
const BASE_PATTERNS = ['refs/remotes/origin/release-candidate/*', 'refs/remotes/origin/develop', 'refs/remotes/origin/main', 'refs/remotes/origin/master'];

/**
 * Picks the base to diff against:
 * explicit config > `git config branch.<name>.diffboardBase` > the candidate branch whose
 * merge-base with HEAD is closest (fewest commits between them) > HEAD.
 */
export async function resolveBase(cwd: string, configured?: string): Promise<{ base: string; source: RepoSnapshot['baseSource'] }> {
  if (configured) return { base: configured, source: 'configured' };
  const branch = await tryGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch && branch !== 'HEAD') {
    const fromConfig = await tryGit(cwd, ['config', '--get', `branch.${branch}.diffboardBase`]);
    if (fromConfig) return { base: fromConfig, source: 'git-config' };
  }
  const refs = (await tryGit(cwd, ['for-each-ref', '--format=%(refname:short)', ...BASE_PATTERNS])).split('\n').filter(Boolean);
  // on a base branch itself (master, develop, a release candidate) the base is its own upstream:
  // the board then shows what is not pushed yet, not the whole history since another base branch
  if (branch && refs.includes(`origin/${branch}`)) return { base: `origin/${branch}`, source: 'auto' };
  let best: { ref: string; distance: number } | null = null;
  for (const ref of refs) {
    if (branch && ref === `origin/${branch}`) continue;
    const mb = await tryGit(cwd, ['merge-base', 'HEAD', ref]);
    if (!mb) continue;
    const distance = Number(await tryGit(cwd, ['rev-list', '--count', `${mb}..HEAD`]));
    if (Number.isNaN(distance)) continue;
    if (!best || distance < best.distance) best = { ref, distance };
  }
  if (best) return { base: best.ref, source: 'auto' };
  return { base: 'HEAD', source: 'fallback' };
}

function parseNameStatus(raw: string): Map<string, { status: FileStatus; oldPath?: string }> {
  const out = new Map<string, { status: FileStatus; oldPath?: string }>();
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    if (!code) continue;
    const kind = code[0];
    if (kind === 'R' || kind === 'C') {
      const oldPath = parts[i++];
      const path = parts[i++];
      out.set(path, { status: kind === 'R' ? 'R' : 'A', oldPath: kind === 'R' ? oldPath : undefined });
    } else {
      const path = parts[i++];
      const status: FileStatus = kind === 'A' ? 'A' : kind === 'D' ? 'D' : 'M';
      out.set(path, { status });
    }
  }
  return out;
}

function parseNumstat(raw: string): Map<string, { add: number; del: number; binary: boolean }> {
  const out = new Map<string, { add: number; del: number; binary: boolean }>();
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; ) {
    const head = parts[i++];
    if (!head) continue;
    const [a, d, path] = head.split('\t');
    let target = path;
    if (path === '') { i++; target = parts[i++]; } // rename: "a\td\t" \0 old \0 new
    const binary = a === '-' || d === '-';
    out.set(target, { add: binary ? 0 : Number(a), del: binary ? 0 : Number(d), binary });
  }
  return out;
}

async function countLines(file: string): Promise<number> {
  try {
    const s = await stat(file);
    if (s.size > 2_000_000) return 0;
    const text = await readFile(file, 'utf8');
    if (text.includes('\0')) return 0;
    return text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch { return 0; }
}

export async function snapshot(cwd: string, mode: DiffMode, configuredBase?: string): Promise<RepoSnapshot> {
  const branch = (await tryGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])) || 'HEAD';
  const head = await tryGit(cwd, ['rev-parse', 'HEAD']);
  const headSubject = await tryGit(cwd, ['log', '-1', '--format=%s']);
  const { base, source } = await resolveBase(cwd, configuredBase);
  const mergeBase = mode === 'head' ? head : (await tryGit(cwd, ['merge-base', 'HEAD', base])) || head;

  const diffArgs = ['-M', '-z', mergeBase, '--'];
  const [ns, num, untrackedRaw] = await Promise.all([
    git(cwd, ['diff', '--name-status', ...diffArgs]),
    git(cwd, ['diff', '--numstat', ...diffArgs]),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const statuses = parseNameStatus(ns);
  const stats = parseNumstat(num);
  const files: ChangedFile[] = [];
  for (const [path, s] of statuses) {
    const n = stats.get(path) ?? { add: 0, del: 0, binary: false };
    files.push({ path, oldPath: s.oldPath, status: s.status, ...n });
  }
  for (const path of untrackedRaw.split('\0').filter(Boolean)) {
    files.push({ path, status: 'U', add: await countLines(join(cwd, path)), del: 0, binary: false });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { branch, head, headSubject, base, baseSource: source, mergeBase, files };
}

/** `full` keeps every unchanged line as context, so the diff reads as the whole file. */
export async function fileDiff(cwd: string, mergeBase: string, file: Pick<ChangedFile, 'path' | 'oldPath' | 'status'>, full = false): Promise<string> {
  const ctx = full ? ['-U1000000'] : [];
  if (file.status === 'U') return git(cwd, ['diff', ...ctx, '--no-index', '--', '/dev/null', file.path], [0, 1]);
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  return git(cwd, ['diff', '-M', ...ctx, mergeBase, '--', ...paths]);
}

export async function fileContent(cwd: string, mergeBase: string, file: Pick<ChangedFile, 'path' | 'oldPath' | 'status'>, side: 'new' | 'old'): Promise<string | null> {
  if (side === 'new') {
    if (file.status === 'D') return null;
    try { return await readFile(join(cwd, file.path), 'utf8'); } catch { return null; }
  }
  if (file.status === 'A' || file.status === 'U') return null;
  try { return await git(cwd, ['show', `${mergeBase}:${file.oldPath ?? file.path}`]); } catch { return null; }
}

export async function remoteBranches(cwd: string): Promise<string[]> {
  return (await tryGit(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes/origin'])).split('\n').filter(b => b && b !== 'origin/HEAD' && b !== 'origin');
}

export async function trackedSources(cwd: string): Promise<string[]> {
  const raw = await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs']);
  return raw.split('\0').filter(p => p && !/(^|\/)(node_modules|dist|build|\.next|coverage)\//.test(p) && !p.endsWith('.d.ts'));
}
