import { resolve } from 'node:path';
import { isRepo, repoRoot } from '../git';
import { exportDesign, FORMATS, type ExportFormat } from './export';
import { OpError, type Role } from './model';
import type { DesignStore } from './store';

/**
 * Same-origin check that survives a reverse proxy (harness serve over Tailscale): the browser's
 * Origin is https://<machine>.ts.net while this server sees plain http, so compare hosts only.
 */
export function sameOrigin(req: Request, url: URL) {
  const origin = req.headers.get('origin');
  if (!origin) return true; // the CLI, curl
  let host: string;
  try { host = new URL(origin).host; } catch { return false; }
  return host === url.host || host === req.headers.get('x-forwarded-host');
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** /api/designs and /api/d/<id>/...: design boards. Writes accept only JSON from the board's own origin or the CLI. */
export async function designRoute(store: DesignStore, p: string, req: Request, url: URL): Promise<Response> {
  if (req.method !== 'GET') {
    if (!sameOrigin(req, url) || (req.method !== 'DELETE' && !req.headers.get('content-type')?.includes('application/json'))) return json({ error: 'forbidden' }, 403);
  }
  const body: any = req.method === 'GET' || req.method === 'DELETE' ? {} : await req.json().catch(() => ({}));
  const author = String(body.author ?? body.by ?? 'you') || 'you';
  try {
    if (p === '/api/designs' && req.method === 'GET') return json({ designs: store.list() });
    if (p === '/api/designs' && req.method === 'POST') {
      const repo = resolve(String(body.repo ?? ''));
      if (!(await isRepo(repo))) return json({ error: `${repo} is not a git repository` }, 400);
      const d = await store.create(String(body.name ?? ''), await repoRoot(repo), { dir: body.dir || undefined, author, purpose: body.purpose || undefined });
      return json({ id: d.id, name: d.name, file: store.file(d.id) });
    }
    if (p === '/api/designs/open' && req.method === 'POST') {
      const d = await store.open(resolve(String(body.file ?? '')));
      return json({ id: d.id, name: d.name, file: store.file(d.id) });
    }

    const m = /^\/api\/d\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return json({ error: 'not found' }, 404);
    const id = decodeURIComponent(m[1]);
    const rest = m[2] ?? '';

    if (rest === '' && req.method === 'GET') return json(store.view(id));
    if (rest === '' && req.method === 'DELETE') { await store.close(id); return json({ ok: true }); }
    if (rest === '/ops' && req.method === 'POST') return json(await store.apply(id, body.ops, author));
    if (rest === '/undo' && req.method === 'POST') return json(await store.undo(id, author));
    if (rest === '/seen' && req.method === 'POST') { store.seen(id, author); return json({ ok: true }); }
    if (rest === '/preview') return json(store.preview(id, req.method === 'GET' ? { proposal: url.searchParams.get('proposal') ?? undefined } : { ops: body.ops, proposal: body.proposal }));
    if (rest === '/proposals' && req.method === 'GET') return json({ proposals: store.get(id).proposals });
    if (rest === '/proposals' && req.method === 'POST') return json(await store.propose(id, { title: body.title, rationale: body.rationale, ops: body.ops }, author));
    const pm = /^\/proposals\/([\w-]+)$/.exec(rest);
    if (pm && req.method === 'GET') {
      const pr = store.get(id).proposals.find(x => x.id === pm[1]);
      return pr ? json({ ...pr, comments: store.get(id).comments.filter(c => c.target === `proposal:${pr.id}`) }) : json({ error: `no proposal ${pm[1]}` }, 404);
    }
    if (pm && req.method === 'POST') return json(await store.decide(id, pm[1], body.accept === true, author, body.reason || undefined));
    if (rest === '/comments' && req.method === 'POST') return json(await store.comment(id, body.text, author, body.target || undefined));
    if (rest === '/participants' && req.method === 'POST') return json(await store.join(id, String(body.name ?? ''), String(body.role ?? 'propose') as Role));
    const partm = /^\/participants\/(.+)$/.exec(rest);
    if (partm && req.method === 'DELETE') { await store.leave(id, decodeURIComponent(partm[1])); return json({ ok: true }); }
    if (rest === '/approve' && req.method === 'POST') return json(await store.approve(id, author));
    if (rest === '/history' && req.method === 'GET') return json({ entries: await store.history(id) });
    const vm = /^\/versions\/(\d+)$/.exec(rest);
    if (vm && req.method === 'GET') return json(await store.version(id, Number(vm[1])));
    if (rest === '/export' && req.method === 'GET') {
      const f = (url.searchParams.get('format') ?? 'md') as ExportFormat;
      if (!FORMATS.includes(f)) return json({ error: `format is one of ${FORMATS.join(', ')}` }, 400);
      return new Response(exportDesign(store.get(id), f), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    if (e instanceof OpError) return json({ error: e.message }, 400);
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return json({ error: 'not found' }, 404);
    return json({ error: (e as Error).message }, 500);
  }
}
