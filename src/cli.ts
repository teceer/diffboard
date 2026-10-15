import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HOME, loadConfig, saveConfig } from './board';
import { Boards } from './boards';
import { isRepo, repoRoot } from './git';
import { serve } from './server';

const PID_FILE = join(HOME, 'server.pid');
const LOG_FILE = join(HOME, 'server.log');

const HELP = `diffboard: live whiteboard of a branch's changes

Boards: one server holds independent boards (repos, diff mode, notes, tours, review marks each).
Give every agent session its own board. Commands pick the board from --board <id>, then
$DIFFBOARD_BOARD, then the board that watches the current directory, then "default".
  diffboard board new <name> [repo...] [--base <ref>]      create a board (prints its id and url)
  diffboard board list                                     boards with their repos and last activity
  diffboard board current                                  the board commands here would use
  diffboard board rename <id> <name>
  diffboard board rm <id>                                  archive a board (~/.diffboard/archive)

  diffboard start [repo...] [--base <ref>] [--port 4700]   start in the background (adds the repos)
  diffboard serve [repo...] [--base <ref>] [--port 4700]   run in the foreground
  diffboard add <repo> [--base <ref>]                      watch another repo on the running board
  diffboard remove <repo-id|path>                          stop watching a repo
  diffboard base <repo-id> <ref|auto>                      change the base a repo is diffed against
  diffboard status                                         url, repos, bases, changed files
  diffboard url                                            print the board url
  diffboard stop                                           stop the background server

Notes (markdown; \`\`\`mermaid fences render as diagrams), linked to files many-to-many:
  diffboard note add --title <t> [--body <md> | --body-file <f.md> | stdin] [--link <ref>]... [--author <name>]
  diffboard note list
  diffboard note show <id>
  diffboard note edit <id> [--title <t>] [--body <md> | --body-file <f>] [--link <ref>]... [--unlink <ref>]...
  diffboard note rm <id>
  <ref> = repo-id:path[:start[-end]], /abs/path/file.ts[:start[-end]], or path[:lines] when one repo is watched

Review tours (ordered files with what to look at; files outside the tour follow automatically):
  diffboard tour set <name> --step "<ref> | <what to look at>" [--step ...] [--author <name>]
  diffboard tour set <name> --steps-file <file>       one "<ref> | <note>" per line, # for comments
  diffboard tour list | show <name> | rm <name>

The board diffs each repo against the merge-base with its base branch (auto: the closest of
origin/release-candidate/*, develop, main, master) and includes uncommitted and untracked files.
Per-branch override: git config branch.<name>.diffboardBase <ref>`;

function parseArgs(argv: string[]) {
  const out: { _: string[]; board?: string; base?: string; port?: number; title?: string; body?: string; bodyFile?: string; author?: string; link: string[]; unlink: string[]; step: string[]; stepsFile?: string } = { _: [], link: [], unlink: [], step: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--board') out.board = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--title') out.title = argv[++i];
    else if (a === '--body') out.body = argv[++i];
    else if (a === '--body-file') out.bodyFile = argv[++i];
    else if (a === '--author') out.author = argv[++i];
    else if (a === '--link') out.link.push(argv[++i]);
    else if (a === '--unlink') out.unlink.push(argv[++i]);
    else if (a === '--step') out.step.push(argv[++i]);
    else if (a === '--steps-file') out.stepsFile = argv[++i];
    else out._.push(a);
  }
  return out;
}

async function readBody(args: ReturnType<typeof parseArgs>, allowStdin: boolean) {
  if (args.body !== undefined) return args.body;
  if (args.bodyFile) return await Bun.file(args.bodyFile).text();
  if (allowStdin && !process.stdin.isTTY) return await new Response(Bun.stdin.stream()).text();
  return undefined;
}

async function cmdTour(args: ReturnType<typeof parseArgs>) {
  const [sub, name] = args._;
  if (!(await running())) await cmdStart({ ...args, _: [] });
  if (sub === 'set') {
    if (!name) throw new Error('usage: diffboard tour set <name> --step "<ref> | <note>"');
    const lines = [...args.step, ...(args.stepsFile ? (await Bun.file(args.stepsFile).text()).split('\n') : [])]
      .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const steps = lines.map(l => { const i = l.indexOf('|'); return i === -1 ? { ref: l } : { ref: l.slice(0, i).trim(), note: l.slice(i + 1).trim() }; });
    const t = await bapi('/api/tours', { method: 'POST', body: JSON.stringify({ name, steps, author: args.author ?? process.env.DIFFBOARD_AUTHOR ?? 'agent' }) });
    console.log(`tour “${t.name}”: ${t.steps.length} steps  ${await boardUrl(`tour=${encodeURIComponent(t.name)}`)}`);
  } else if (sub === 'list') {
    const { tours } = await bapi('/api/tours');
    for (const t of tours) console.log(`${t.name}  ${t.steps.length} steps  [${t.author}]`);
  } else if (sub === 'show') {
    const { tours } = await bapi('/api/tours');
    const t = tours.find((x: any) => x.name === name);
    if (!t) throw new Error(`no tour ${name}`);
    t.steps.forEach((s: any, i: number) => console.log(`${String(i + 1).padStart(2)}. ${s.repo ?? '?'}:${s.path}${s.start ? ':' + s.start + '-' + s.end : ''}${s.note ? '  | ' + s.note : ''}`));
  } else if (sub === 'rm') {
    await bapi(`/api/tours/${encodeURIComponent(name ?? '')}`, { method: 'DELETE' });
    console.log('removed');
  } else console.log(HELP);
}

async function cmdNote(args: ReturnType<typeof parseArgs>) {
  const [sub, id] = args._;
  if (!(await running())) await cmdStart({ ...args, _: [] });
  const author = args.author ?? process.env.DIFFBOARD_AUTHOR ?? 'agent';
  if (sub === 'add') {
    const n = await bapi('/api/notes', { method: 'POST', body: JSON.stringify({ title: args.title, body: (await readBody(args, true)) ?? '', author, links: args.link }) });
    console.log(`${n.id}  ${n.title}  (${n.links.length} link${n.links.length === 1 ? '' : 's'})  ${await boardUrl(`note=${n.id}`)}`);
  } else if (sub === 'list') {
    const { notes } = await bapi('/api/notes');
    for (const n of notes) console.log(`${n.id}  ${n.title}  [${n.author}]  ${n.links.map((l: any) => `${l.repo ?? l.repoPath}:${l.path}${l.start ? ':' + l.start + (l.end && l.end !== l.start ? '-' + l.end : '') : ''}`).join(', ')}`);
  } else if (sub === 'show') {
    const n = await bapi(`/api/notes/${id}`);
    console.log(`# ${n.title}\n[${n.author}] links: ${n.links.map((l: any) => `${l.repo}:${l.path}${l.start ? ':' + l.start + '-' + l.end : ''}`).join(', ')}\n\n${n.body}`);
  } else if (sub === 'edit') {
    const n = await bapi(`/api/notes/${id}`, { method: 'PATCH', body: JSON.stringify({ title: args.title, body: await readBody(args, false), addLinks: args.link, removeLinks: args.unlink, author }) });
    console.log(`${n.id}  ${n.title}  updated`);
  } else if (sub === 'rm') {
    await bapi(`/api/notes/${id}`, { method: 'DELETE' });
    console.log('deleted');
  } else console.log(HELP);
}

async function port() { return (await loadConfig()).port; }
async function api(path: string, init?: RequestInit) {
  const res = await fetch(`http://127.0.0.1:${await port()}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
async function running() { try { await api('/api/health'); return true; } catch { return false; } }

/* ---------- the board a command works on ---------- */
let boardArg: string | undefined;
let boardCache: string | undefined;
async function boardId(create = false): Promise<string> {
  if (boardCache) return boardCache;
  const named = boardArg ?? process.env.DIFFBOARD_BOARD;
  if (named) {
    const { boards } = await api('/api/boards');
    const hit = boards.find((b: any) => b.id === named || b.name === named);
    if (hit) return (boardCache = hit.id);
    if (!create) throw new Error(`no board ${named} (diffboard board list)`);
    return (boardCache = (await api('/api/boards', { method: 'POST', body: JSON.stringify({ name: named }) })).id);
  }
  return (boardCache = (await api(`/api/boards/resolve?cwd=${encodeURIComponent(process.cwd())}`)).id);
}
async function bapi(path: string, init?: RequestInit) { return api(`/api/b/${encodeURIComponent(await boardId())}${path.slice(4)}`, init); }
async function boardUrl(hash = '') {
  const id = await boardId();
  return `http://localhost:${await port()}/#board=${encodeURIComponent(id)}${hash ? '&' + hash : ''}`;
}

async function cmdBoard(args: ReturnType<typeof parseArgs>) {
  const [sub, ...rest] = args._;
  if (!(await running())) await cmdStart({ ...args, _: [] });
  if (sub === 'new') {
    const [name, ...repos] = rest;
    if (!name) throw new Error('usage: diffboard board new <name> [repo...] [--base <ref>]');
    const b = await api('/api/boards', { method: 'POST', body: JSON.stringify({ name, repos: repos.map(p => ({ path: resolve(p), base: args.base })) }) });
    boardCache = b.id;
    console.log(`${b.id}  ${await boardUrl()}\nUse it with --board ${b.id} or DIFFBOARD_BOARD=${b.id}; commands run inside its repos pick it up on their own.`);
  } else if (sub === 'list' || !sub) {
    const { boards } = await api('/api/boards');
    for (const b of boards) {
      const repos = b.repos.map((r: any) => `${r.id}${r.branch ? '@' + r.branch : ''}`).join(', ') || 'no repos';
      console.log(`${b.id.padEnd(24)} ${b.name !== b.id ? `“${b.name}” ` : ''}${repos}  ${b.files} files +${b.add} -${b.del}${b.lastAt ? `  ${new Date(b.lastAt).toLocaleTimeString()} ${b.lastText}` : ''}`);
    }
  } else if (sub === 'current') {
    console.log(`${await boardId()}  ${await boardUrl()}`);
  } else if (sub === 'rename') {
    if (!rest[0] || !rest[1]) throw new Error('usage: diffboard board rename <id> <name>');
    await api(`/api/boards/${encodeURIComponent(rest[0])}`, { method: 'PATCH', body: JSON.stringify({ name: rest.slice(1).join(' ') }) });
    console.log('renamed');
  } else if (sub === 'rm') {
    await api(`/api/boards/${encodeURIComponent(rest[0] ?? '')}`, { method: 'DELETE' });
    console.log('archived');
  } else console.log(HELP);
}

async function cmdServe(args: ReturnType<typeof parseArgs>) {
  const cfg = await loadConfig();
  if (args.port) cfg.port = args.port;
  await mkdir(HOME, { recursive: true });
  const boards = new Boards();
  await boards.load();
  await saveConfig({ port: cfg.port });
  const named = args.board ?? process.env.DIFFBOARD_BOARD;
  const board = named ? boards.get(named) ?? await boards.create(named) : boards.fallback;
  for (const p of args._) {
    const abs = resolve(p);
    if (!(await isRepo(abs))) { console.error(`skip ${abs}: not a git repository`); continue; }
    await board.addRepo({ path: await repoRoot(abs), base: args.base });
  }
  serve(boards, cfg.port);
  await writeFile(PID_FILE, String(process.pid));
  console.log(`diffboard on http://localhost:${cfg.port} (${boards.meta.length} board${boards.meta.length === 1 ? '' : 's'})`);
}

async function cmdStart(args: ReturnType<typeof parseArgs>) {
  if (await running()) {
    if (args._.length) await boardId(true);
    for (const p of args._) await bapi('/api/repos', { method: 'POST', body: JSON.stringify({ path: resolve(p), base: args.base }) });
    console.log(`already running: ${args._.length ? await boardUrl() : `http://localhost:${await port()}`}`);
    return;
  }
  await mkdir(HOME, { recursive: true });
  const fd = openSync(LOG_FILE, 'a');
  const child = Bun.spawn(['bun', join(import.meta.dir, 'cli.ts'), 'serve', ...process.argv.slice(3)], { stdio: ['ignore', fd, fd], env: process.env });
  child.unref();
  for (let i = 0; i < 60 && !(await running()); i++) await Bun.sleep(250);
  if (!(await running())) { console.error(`failed to start, see ${LOG_FILE}`); process.exit(1); }
  console.log(`started: ${args._.length || args.board ? await boardUrl() : `http://localhost:${await port()}`}`);
}

async function cmdStatus() {
  if (!(await running())) { console.log('not running'); process.exitCode = 1; return; }
  const s = await bapi('/api/state');
  const { boards } = await api('/api/boards');
  console.log(`board ${s.board}  ${await boardUrl()}  mode=${s.mode}${boards.length > 1 ? `  (${boards.length} boards: diffboard board list)` : ''}`);
  for (const r of s.repos) {
    console.log(`  ${r.id}  ${r.branch}  base=${r.base} (${r.baseSource})  ${r.files} files +${r.add} -${r.del}${r.error ? '  ERROR ' + r.error : ''}`);
  }
}

async function cmdStop() {
  try {
    const pid = Number(await readFile(PID_FILE, 'utf8'));
    process.kill(pid);
    await rm(PID_FILE, { force: true });
    console.log('stopped');
  } catch { console.log('not running'); }
}

const [, , cmd = 'help', ...rest] = process.argv;
const args = parseArgs(rest);
boardArg = args.board;
try {
  switch (cmd) {
    case 'serve': await cmdServe(args); break;
    case 'start': await cmdStart(args); break;
    case 'add':
      if (!args._[0]) throw new Error('usage: diffboard add <repo> [--base <ref>]');
      if (!(await running())) { await cmdStart(args); break; }
      await boardId(true);
      console.log(await bapi('/api/repos', { method: 'POST', body: JSON.stringify({ path: resolve(args._[0]), base: args.base }) }));
      break;
    case 'remove': await bapi(`/api/repos?repo=${encodeURIComponent(args._[0] ?? '')}`, { method: 'DELETE' }); console.log('removed'); break;
    case 'base': await bapi('/api/base', { method: 'POST', body: JSON.stringify({ repo: args._[0], base: args._[1] === 'auto' ? '' : args._[1] }) }); console.log('ok'); break;
    case 'status': await cmdStatus(); break;
    case 'note': await cmdNote(args); break;
    case 'tour': await cmdTour(args); break;
    case 'board': case 'boards': await cmdBoard(args); break;
    case 'url': console.log(await running() ? await boardUrl() : `http://localhost:${await port()}`); break;
    case 'stop': await cmdStop(); break;
    default: console.log(HELP);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
