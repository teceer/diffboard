import { stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Board } from './board';
import type { Boards } from './boards';
import { fileContent, fileDiff, git, isRepo, remoteBranches, repoRoot } from './git';
import { lspQuery, type LspOp } from './lsp';

const UI = join(import.meta.dir, '..', 'ui');
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export function serve(boards: Boards, port: number) {
  const encoder = new TextEncoder();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const send = (c: ReadableStreamDefaultController<Uint8Array>, payload: string) => { try { c.enqueue(encoder.encode(payload)); } catch { clients.delete(c); } };
  // every board's changes go to every client: the open board refreshes, the sidebar updates its entries
  boards.onChange(e => { const payload = 'boards' in e ? `event: boards\ndata: {}\n\n` : `event: change\ndata: ${JSON.stringify(e)}\n\n`; for (const c of clients) send(c, payload); });
  setInterval(() => { for (const c of clients) send(c, `: ping\n\n`); }, 15000);

  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;

      if (p === '/' || p === '/index.html') return new Response(Bun.file(join(UI, 'index.html')));
      if (p === '/app.js' || p === '/styles.css') return new Response(Bun.file(join(UI, p.slice(1))));

      if (p === '/events') {
        let ctrl: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) { ctrl = c; clients.add(c); send(c, `event: boards\ndata: {}\n\n`); },
          cancel() { clients.delete(ctrl); },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
      }

      /* ---------- boards ---------- */
      if (p === '/api/boards' && req.method === 'GET') return json({ boards: boards.list() });
      if (p === '/api/boards' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const repos = [];
        for (const r of (body.repos ?? []) as { path: string; base?: string }[]) {
          const path = resolve(String(r.path ?? ''));
          if (!(await isRepo(path))) return json({ error: `${path} is not a git repository` }, 400);
          repos.push({ path: await repoRoot(path), base: r.base || undefined });
        }
        const b = await boards.create(String(body.name ?? ''), repos);
        return json({ id: b.id, name: boards.meta.find(m => m.id === b.id)!.name });
      }
      if (p === '/api/boards/resolve') {
        const r = boards.resolve(resolve(url.searchParams.get('cwd') ?? '/'));
        return 'error' in r ? json(r, 409) : json(r);
      }
      const boardMatch = /^\/api\/boards\/([^/]+)$/.exec(p);
      if (boardMatch && req.method === 'PATCH') {
        const body = await req.json().catch(() => ({}));
        const ok = await boards.rename(decodeURIComponent(boardMatch[1]), String(body.name ?? ''));
        return json({ ok }, ok ? 200 : 400);
      }
      if (boardMatch && req.method === 'DELETE') {
        const ok = await boards.remove(decodeURIComponent(boardMatch[1]));
        return json(ok ? { ok } : { error: 'no such board (default cannot be removed)' }, ok ? 200 : 400);
      }
      if (p === '/api/health') return json({ ok: true, pid: process.pid, boards: boards.meta.length });

      /* ---------- one board: /api/b/<id>/..., or the default board for the unprefixed routes ---------- */
      const scoped = /^\/api\/b\/([^/]+)(\/.*)$/.exec(p);
      const board = scoped ? boards.get(decodeURIComponent(scoped[1])) : boards.fallback;
      if (!board) return json({ error: `no board ${decodeURIComponent(scoped![1])}` }, 404);
      return boardRoute(board, scoped ? `/api${scoped[2]}` : p, req, url);
    },
  });

  async function boardRoute(board: Board, p: string, req: Request, url: URL): Promise<Response> {
      if (p === '/api/state') return json({ ...board.state(), board: board.id });

      if (p === '/api/diff' || p === '/api/file') {
        const hit = board.findFile(url.searchParams.get('repo') ?? '', url.searchParams.get('path') ?? '');
        if (!hit) {
          // neighbours are unchanged files: serve their current content
          const r = board.repos.get(url.searchParams.get('repo') ?? '');
          if (r && p === '/api/file') {
            const f = Bun.file(join(r.path, url.searchParams.get('path') ?? ''));
            if (await f.exists()) return json({ content: await f.text(), side: 'new' });
          }
          return json({ error: 'not a changed file' }, 404);
        }
        const mb = hit.repo.snap!.mergeBase;
        if (p === '/api/diff') return json({ diff: await fileDiff(hit.repo.path, mb, hit.file, url.searchParams.get('full') === '1') });
        const side = url.searchParams.get('side') === 'old' ? 'old' : 'new';
        return json({ content: await fileContent(hit.repo.path, mb, hit.file, side), side });
      }

      /* the working-tree copy of a file, for editing in the panel; writes refuse to clobber a newer version on disk */
      if (p === '/api/worktree') {
        const r = board.repos.get(url.searchParams.get('repo') ?? '');
        const abs = r && resolve(r.path, url.searchParams.get('path') ?? '');
        if (!r || !abs || !abs.startsWith(r.path + sep)) return json({ error: 'unknown file' }, 404);
        if (req.method === 'GET') {
          try { return json({ content: await Bun.file(abs).text(), mtime: (await stat(abs)).mtimeMs }); }
          catch { return json({ error: 'file not found' }, 404); }
        }
        if (req.method === 'PUT') {
          // only the board itself may write: no cross-origin pages, no form posts
          const origin = req.headers.get('origin');
          if ((origin && origin !== url.origin) || !req.headers.get('content-type')?.includes('application/json')) return json({ error: 'forbidden' }, 403);
          const body = await req.json().catch(() => ({}));
          if (typeof body.content !== 'string') return json({ error: 'content required' }, 400);
          const now = await stat(abs).then(s => s.mtimeMs, () => null);
          if (now === null) return json({ error: 'file not found' }, 404);
          if (typeof body.mtime === 'number' && now !== body.mtime) return json({ error: 'changed on disk', mtime: now }, 409);
          await writeFile(abs, body.content);
          return json({ mtime: (await stat(abs)).mtimeMs });
        }
      }

      /* language server: hover types, occurrences, definitions, references of the working-tree file */
      if (p === '/api/lsp' && req.method === 'POST') {
        const origin = req.headers.get('origin');
        if ((origin && origin !== url.origin) || !req.headers.get('content-type')?.includes('application/json')) return json({ error: 'forbidden' }, 403);
        const body = await req.json().catch(() => ({}));
        const r = board.repos.get(String(body.repo ?? ''));
        const abs = r && resolve(r.path, String(body.path ?? ''));
        if (!r || !abs || !abs.startsWith(r.path + sep)) return json({ error: 'unknown file' }, 404);
        if (!['hover', 'highlight', 'definition', 'references'].includes(body.op)) return json({ error: 'unknown op' }, 400);
        try {
          const res = await lspQuery(r.path, abs, body.op as LspOp, Number(body.line) || 0, Number(body.character) || 0);
          if ('locations' in res && res.locations) {
            // files of the board's repos open in the panel; anything else (libraries outside the repos) is shown as is
            const repos = [...board.repos.values()].sort((a, b) => b.path.length - a.path.length);
            return json({ ...res, locations: res.locations.map(l => {
              const owner = repos.find(x => l.file.startsWith(x.path + sep));
              return owner ? { repo: owner.id, path: l.file.slice(owner.path.length + 1), range: l.range, text: l.text } : { file: l.file, range: l.range, text: l.text };
            }) });
          }
          return json(res);
        } catch (e) { return json({ error: (e as Error).message }, 502); }
      }

      /* every file of the board's repos (tracked plus untracked, not ignored), for the file tree and quick open */
      if (p === '/api/files' && req.method === 'GET') {
        const repos = [];
        for (const r of board.repos.values()) {
          const raw = await git(r.path, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).catch(() => '');
          repos.push({ repo: r.id, files: [...new Set(raw.split('\0').filter(Boolean))].sort() });
        }
        return json({ repos });
      }

      /* the whole-repo map: every file plus file-to-file import edges (the client folds them into folders) */
      if (p === '/api/map' && req.method === 'GET') {
        const repos = [...board.repos.values()];
        const files: [number, string][] = [];
        const index = new Map<string, number>();
        for (const [ri, r] of repos.entries()) {
          const raw = await git(r.path, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).catch(() => '');
          for (const f of new Set(raw.split('\0').filter(Boolean))) { index.set(`${r.id}:${f}`, files.length); files.push([ri, f]); }
          if (r.tooMany) await r.graph.refresh(); // skipped while the diff was too big to draw
        }
        const edges: [number, number][] = [];
        for (const r of repos) for (const [f, targets] of r.graph.imports) {
          const a = index.get(`${r.id}:${f}`);
          if (a === undefined) continue;
          for (const t of targets) {
            const i = t.indexOf(':');
            const b = index.get(i > 0 && board.repos.has(t.slice(0, i)) ? t : `${r.id}:${t}`);
            if (b !== undefined && b !== a) edges.push([a, b]);
          }
        }
        return json({ repos: repos.map(r => r.id), files, edges });
      }

      /* raw bytes of a working-tree file, for images in rendered markdown */
      if (p === '/api/raw' && req.method === 'GET') {
        const r = board.repos.get(url.searchParams.get('repo') ?? '');
        const abs = r && resolve(r.path, url.searchParams.get('path') ?? '');
        if (!r || !abs || !abs.startsWith(r.path + sep)) return json({ error: 'unknown file' }, 404);
        const f = Bun.file(abs);
        if (!(await f.exists())) return json({ error: 'file not found' }, 404);
        // images only: never serve repo HTML/JS from the board's origin
        if (!/^image\/(png|jpe?g|gif|webp|avif|svg\+xml|x-icon|bmp)$/.test(f.type.split(';')[0])) return json({ error: 'not an image' }, 415);
        return new Response(f, { headers: { 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' } });
      }

      /* open a file in a desktop editor: not every browser hands custom URL schemes to the OS */
      if (p === '/api/open' && req.method === 'POST') {
        const origin = req.headers.get('origin');
        if ((origin && origin !== url.origin) || !req.headers.get('content-type')?.includes('application/json')) return json({ error: 'forbidden' }, 403);
        const body = await req.json().catch(() => ({}));
        const r = board.repos.get(String(body.repo ?? ''));
        const abs = r && resolve(r.path, String(body.path ?? ''));
        if (!r || !abs || !abs.startsWith(r.path + sep)) return json({ error: 'unknown file' }, 404);
        const scheme = { zed: 'zed', vscode: 'vscode' }[String(body.editor)];
        if (!scheme) return json({ error: 'unknown editor' }, 400);
        const line = Number(body.line) > 0 ? `:${Math.floor(Number(body.line))}` : '';
        const target = `${scheme}://file${abs.split(sep).map(encodeURIComponent).join('/')}${line}`;
        const proc = Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', target], { stdout: 'ignore', stderr: 'pipe' });
        if ((await proc.exited) !== 0) return json({ error: (await new Response(proc.stderr).text()).trim() || `could not open ${scheme}` }, 500);
        return json({ ok: true });
      }

      if (p === '/api/branches') {
        const r = board.repos.get(url.searchParams.get('repo') ?? '');
        return r ? json({ branches: await remoteBranches(r.path) }) : json({ error: 'unknown repo' }, 404);
      }

      if (req.method === 'POST' && p === '/api/repos') {
        const body = await req.json().catch(() => ({}));
        const path = resolve(String(body.path ?? ''));
        if (!(await isRepo(path))) return json({ error: `${path} is not a git repository` }, 400);
        const id = await board.addRepo({ path: await repoRoot(path), base: body.base || undefined });
        return json({ id });
      }
      if (req.method === 'DELETE' && p === '/api/repos') {
        const ok = await board.removeRepo(url.searchParams.get('repo') ?? '');
        return json({ ok }, ok ? 200 : 404);
      }
      if (req.method === 'POST' && p === '/api/base') {
        const body = await req.json().catch(() => ({}));
        await board.setBase(String(body.repo), body.base || undefined);
        return json({ ok: true });
      }
      if (req.method === 'POST' && p === '/api/mode') {
        const body = await req.json().catch(() => ({}));
        await board.setMode(body.mode === 'head' ? 'head' : 'branch');
        return json({ ok: true });
      }
      if (p === '/api/tours' && req.method === 'GET') return json({ tours: board.state().review.tours });
      if (p === '/api/tours' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        try { return json(await board.setTour(String(body.name || 'review'), body.steps ?? [], String(body.author || 'agent'))); }
        catch (e) { return json({ error: (e as Error).message }, 400); }
      }
      const tourMatch = /^\/api\/tours\/(.+)$/.exec(p);
      if (tourMatch && req.method === 'DELETE') { const ok = await board.removeTour(decodeURIComponent(tourMatch[1])); return json({ ok }, ok ? 200 : 404); }
      if (p === '/api/reviewed' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        try { await board.markReviewed(String(body.repo), String(body.path), body.reviewed !== false); return json({ ok: true }); }
        catch (e) { return json({ error: (e as Error).message }, 400); }
      }
      if (p === '/api/notes' && req.method === 'GET') return json({ notes: board.state().notes });
      if (p === '/api/notes' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        try { return json(await board.createNote(body)); } catch (e) { return json({ error: (e as Error).message }, 400); }
      }
      const noteMatch = /^\/api\/notes\/([\w-]+)$/.exec(p);
      if (noteMatch && req.method === 'GET') {
        const n = board.state().notes.find(x => x.id.startsWith(noteMatch[1]));
        return n ? json(n) : json({ error: 'no such note' }, 404);
      }
      if (noteMatch && req.method === 'PATCH') {
        const body = await req.json().catch(() => ({}));
        try { const n = await board.updateNote(noteMatch[1], body); return n ? json(n) : json({ error: 'no such note' }, 404); }
        catch (e) { return json({ error: (e as Error).message }, 400); }
      }
      if (noteMatch && req.method === 'DELETE') {
        const ok = await board.removeNote(noteMatch[1]);
        return json({ ok }, ok ? 200 : 404);
      }
      return new Response('not found', { status: 404 });
  }
}
