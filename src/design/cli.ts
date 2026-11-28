import { resolve, sep } from 'node:path';
import type { Column, Op } from './model';

export const DESIGN_HELP = `Design boards: agree on the data model, process and assumptions before writing code.
A design lives in the project repo (docs/boards/<id>.board.json, history next to it), so it travels
with the branch. Agents change it with operations; bigger changes go in as proposals the user accepts.
Commands pick the design from --design <id>, then $DIFFBOARD_DESIGN, then the one design in this repo.
Author: --author or $DIFFBOARD_AUTHOR (e.g. agent:checkout).
  diffboard design new <name> [repo] [--dir docs/boards] [--purpose <text>]
  diffboard design list | url | open <file.board.json> | close
  diffboard design show [--format md|dbml|mermaid|json]    the design as text (md: for your context)
  diffboard design check                                    rule findings (errors, warnings, info)
  diffboard design join [--as edit|propose|read]            take part (propose: changes only as proposals)
  diffboard design table <name> [--module m] [--note t] --col "<spec>"...
  diffboard design column <table> "<spec>"                  <spec> = name type [pk] [null] [unique] [ref=table.col] [nofk] [default=v]
  diffboard design op <json | --file ops.json | stdin>      one op or a list (ops: see diffboard design ops)
  diffboard design propose --title <t> [--rationale <r>] <json | --file ops.json | stdin>
  diffboard design proposals | accept <P1> | reject <P1> [--reason <r>]
  diffboard design wait <P1> [--timeout 1800]               block until the user decides; prints the comments
  diffboard design comment <text> [--target proposal:P1|table:<name>|step:<id>]
  diffboard design comments | history | undo | approve
  diffboard design arrange                                  lay the whole board out again (only positions change; undo restores)
  diffboard design ops                                      every operation with its fields`;

const OPS_HELP = `Operations (JSON objects with "op"; send several as a list, applied all-or-nothing):
  {"op":"add-table","table":"reservation","module":"rooms","columns":[{"name":"id","type":"uuid","pk":true}]}
  {"op":"set-table","table":"t","name?":"","module?":"","kind?":"table|view","note?":""}   {"op":"remove-table","table":"t"}
  {"op":"add-column","table":"t","column":{"name":"room_id","type":"uuid","ref":{"table":"room","column":"id"}},"after?":"id"}
  {"op":"set-column","table":"t","column":"c","name?":"","type?":"","nullable?":true,"pk?":true,"unique?":true,"default?":"","ref?":{"table":"","column":""}|null,"fk?":false,"note?":""}
  {"op":"remove-column","table":"t","column":"c"}
  {"op":"set-samples","table":"t","rows":[{"id":"r-1","status":"paid"}]}     realistic sample rows, ids pointing at other tables' samples
  {"op":"set-enum","name":"reservation_status","values":["held","paid"]}   {"op":"remove-enum","name":"e"}
  {"op":"add-module","name":"people","kind":"module|platform","path?":"features/people-api"}   {"op":"remove-module","name":"m"}
  {"op":"set-rules","crossModuleFk?":"error|warn|off","requiredColumns?":["team_id"]}
  {"op":"add-lane","name":"Guest"}   {"op":"remove-lane","name":"Guest"}
  {"op":"add-step","id?":"S1","title":"Picks a room","lane":"Guest","trigger?":"","after?":"S0","touches":[{"table":"room","op":"R"},{"table":"reservation","op":"C","columns?":["status"]}]}
  {"op":"set-step","id":"S1",...}   {"op":"remove-step","id":"S1"}
  {"op":"add-flow","from":"S1","to":"S2","label?":"paid"}   {"op":"remove-flow","from":"S1","to":"S2"}
  {"op":"set-machine","table":"reservation","column":"status","states":["held","paid"],"transitions":[{"from":"held","to":"paid","step?":"S4"}]}
  {"op":"remove-machine","table":"t","column":"c"}
  {"op":"arrange"}   lays the whole board out again: modules in balanced columns, states and assumptions beside, process below
  {"op":"add-assumption","id?":"A1","text":"…","status?":"accepted|open|question|rejected"}   {"op":"set-assumption","id":"A1",...}   {"op":"remove-assumption","id":"A1"}
  {"op":"set-design","name?":"","purpose?":""}   {"op":"move","kind":"table|step|assumption|machine","id":"…","x":0,"y":0}`;

interface Args { _: string[]; author?: string; title?: string; flags: Record<string, string>; col: string[] }
interface Ctx { api: (path: string, init?: RequestInit) => Promise<any>; port: () => Promise<number> }

/** "room_id uuid ref=room.id null" → a column. */
export function parseColumn(spec: string): Column {
  const [name, type, ...rest] = spec.trim().split(/\s+/);
  if (!name || !type) throw new Error(`column spec "${spec}": need at least a name and a type`);
  const c: Column = { name, type };
  for (const w of rest) {
    const [k, v] = w.split('=');
    if (k === 'pk') c.pk = true;
    else if (k === 'null' || k === 'nullable') c.nullable = true;
    else if (k === 'unique') c.unique = true;
    else if (k === 'nofk') c.fk = false;
    else if (k === 'ref' && v?.includes('.')) { const [table, column] = v.split('.'); c.ref = { table, column }; }
    else if (k === 'default' && v !== undefined) c.default = v;
    else if (k === 'note' && v !== undefined) c.note = v.replace(/_/g, ' ');
    else throw new Error(`column spec "${spec}": unknown "${w}"`);
  }
  return c;
}

async function readOps(args: Args, from = 1): Promise<Op[]> {
  let raw = args._.slice(from).join(' ').trim();
  if (args.flags.file) raw = await Bun.file(args.flags.file).text();
  else if (!raw && !process.stdin.isTTY) raw = await new Response(Bun.stdin.stream()).text();
  if (!raw) throw new Error('no operations: pass JSON, --file <ops.json> or pipe it in (diffboard design ops)');
  let v: unknown;
  try { v = JSON.parse(raw); } catch (e) { throw new Error(`operations are not valid JSON: ${(e as Error).message}`); }
  const list = Array.isArray(v) ? v : (v as any)?.ops ?? [v];
  return list as Op[];
}

export async function cmdDesign(args: Args, ctx: Ctx) {
  const [sub = 'help', ...rest] = args._;
  const author = args.author ?? process.env.DIFFBOARD_AUTHOR ?? 'agent';
  const post = (path: string, body: unknown) => ctx.api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const url = async (id: string) => `http://localhost:${await ctx.port()}/design#d=${encodeURIComponent(id)}`;

  const pick = async (): Promise<string> => {
    const named = args.flags.design ?? process.env.DIFFBOARD_DESIGN;
    const { designs } = await ctx.api('/api/designs');
    if (named) {
      const hit = designs.find((d: any) => d.id === named || d.name === named);
      if (!hit) throw new Error(`no design ${named} (diffboard design list)`);
      return hit.id;
    }
    const cwd = process.cwd();
    const here = designs.filter((d: any) => { const root = d.file.split(`${sep}docs${sep}`)[0]; return cwd === root || cwd.startsWith(root + sep); });
    if (here.length === 1) return here[0].id;
    if (designs.length === 1) return designs[0].id;
    throw new Error(here.length > 1
      ? `several designs in this repo (${here.map((d: any) => d.id).join(', ')}): pass --design <id> or set DIFFBOARD_DESIGN`
      : 'no design here: diffboard design new <name> [repo], or pass --design <id>');
  };
  const d = async (path = '') => `/api/d/${encodeURIComponent(await pick())}${path}`;
  const findings = (list: any[]) => list.filter(f => f.level !== 'info').map(f => `  ${f.level === 'error' ? '✗' : '!'} ${f.message}`).join('\n');

  switch (sub) {
    case 'new': {
      const [name, repo = '.'] = rest;
      if (!name) throw new Error('usage: diffboard design new <name> [repo]');
      const r = await post('/api/designs', { name, repo: resolve(repo), dir: args.flags.dir, purpose: args.flags.purpose, author });
      console.log(`${r.id}  ${await url(r.id)}\nfile: ${r.file}\nUse it with --design ${r.id} or DIFFBOARD_DESIGN=${r.id}; inside the repo it is picked up on its own.`);
      return;
    }
    case 'list': {
      const { designs } = await ctx.api('/api/designs');
      if (!designs.length) console.log('no designs (diffboard design new <name> [repo])');
      for (const x of designs) console.log(`${x.id.padEnd(28)} “${x.name}”  ${x.version ? `v${x.version}${x.draft ? '+' : ''}` : 'draft'}  ${x.tables} tables, ${x.steps} steps, ${x.assumptions} assumptions${x.openProposals ? `, ${x.openProposals} open proposals` : ''}\n${' '.repeat(29)}${x.file}`);
      return;
    }
    case 'url': console.log(await url(await pick())); return;
    case 'open': {
      if (!rest[0]) throw new Error('usage: diffboard design open <file.board.json>');
      const r = await post('/api/designs/open', { file: resolve(rest[0]) });
      console.log(`${r.id}  ${await url(r.id)}`);
      return;
    }
    case 'close': await ctx.api(await d(), { method: 'DELETE' }); console.log('closed (the file stays in the repo)'); return;
    case 'show': {
      const f = args.flags.format ?? 'md';
      const res = await fetch(`http://127.0.0.1:${await ctx.port()}${await d(`/export?format=${encodeURIComponent(f)}`)}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      process.stdout.write(await res.text());
      return;
    }
    case 'check': {
      const v = await ctx.api(await d());
      if (!v.findings.length) { console.log('no findings'); return; }
      for (const f of v.findings) console.log(`${f.level.padEnd(5)} ${f.rule.padEnd(16)} ${f.message}`);
      if (v.findings.some((f: any) => f.level === 'error')) process.exitCode = 2;
      return;
    }
    case 'join': {
      const role = args.flags.as ?? 'propose';
      if (author === 'agent' && !args.author && !process.env.DIFFBOARD_AUTHOR) throw new Error('set your name: --author agent:<session> or DIFFBOARD_AUTHOR');
      const r = await post(await d('/participants'), { name: author, role });
      console.log(`${r.name} joined as ${r.role}  ${await url(await pick())}`);
      return;
    }
    case 'leave': await ctx.api(await d(`/participants/${encodeURIComponent(author)}`), { method: 'DELETE' }); console.log('left'); return;
    case 'table': {
      const [table] = rest;
      if (!table) throw new Error('usage: diffboard design table <name> [--module m] --col "<spec>"...');
      const op: Op = { op: 'add-table', table, module: args.flags.module, note: args.flags.note, kind: args.flags.kind === 'view' ? 'view' : undefined, columns: args.col.map(parseColumn) };
      const r = await post(await d('/ops'), { ops: [op], author });
      console.log(`rev ${r.rev}: table ${table} added`); if (findings(r.findings)) console.log(findings(r.findings));
      return;
    }
    case 'column': {
      const [table, ...spec] = rest;
      if (!table || !spec.length) throw new Error('usage: diffboard design column <table> "<spec>"');
      const r = await post(await d('/ops'), { ops: [{ op: 'add-column', table, column: parseColumn(spec.join(' ')) }], author });
      console.log(`rev ${r.rev}: column added`); if (findings(r.findings)) console.log(findings(r.findings));
      return;
    }
    case 'op': case 'ops-apply': {
      const ops = await readOps(args);
      const r = await post(await d('/ops'), { ops, author });
      console.log(`rev ${r.rev}: ${ops.length} op${ops.length === 1 ? '' : 's'} applied`);
      if (findings(r.findings)) console.log(`findings:\n${findings(r.findings)}`);
      return;
    }
    case 'ops': console.log(OPS_HELP); return;
    case 'propose': {
      if (!args.title) throw new Error('usage: diffboard design propose --title <t> [--rationale <r>] <json | --file ops.json>');
      const ops = await readOps(args);
      const id = await pick();
      const p = await post(`/api/d/${encodeURIComponent(id)}/proposals`, { title: args.title, rationale: args.flags.rationale, ops, author });
      console.log(`${p.id} “${p.title}” waiting for a decision  ${await url(id)}\nWait for it: diffboard design wait ${p.id}`);
      return;
    }
    case 'proposals': {
      const { proposals } = await ctx.api(await d('/proposals'));
      if (!proposals.length) console.log('no proposals');
      for (const p of proposals) console.log(`${p.id.padEnd(4)} ${p.status.padEnd(8)} “${p.title}” by ${p.author}${p.reason ? ` (${p.reason})` : ''}`);
      return;
    }
    case 'accept': case 'reject': {
      if (!rest[0]) throw new Error(`usage: diffboard design ${sub} <P1>`);
      const p = await post(await d(`/proposals/${encodeURIComponent(rest[0])}`), { accept: sub === 'accept', by: author, reason: args.flags.reason });
      console.log(`${p.id} ${p.status}`);
      return;
    }
    case 'wait': {
      const pid = rest[0];
      if (!pid) throw new Error('usage: diffboard design wait <P1> [--timeout seconds]');
      const path = await d(`/proposals/${encodeURIComponent(pid)}`);
      const until = Date.now() + (Number(args.flags.timeout) || 1800) * 1000;
      for (;;) {
        const p = await ctx.api(path);
        if (p.status !== 'open' || Date.now() > until) {
          console.log(p.status === 'open' ? `${pid} still open after the timeout` : `${pid} ${p.status} by ${p.decidedBy}${p.reason ? `: ${p.reason}` : ''}`);
          for (const c of p.comments ?? []) console.log(`  ${c.author}: ${c.text}`);
          if (p.status === 'open') process.exitCode = 3;
          return;
        }
        await Bun.sleep(2000);
      }
    }
    case 'comment': {
      const t = rest.join(' ');
      if (!t) throw new Error('usage: diffboard design comment <text> [--target proposal:P1]');
      await post(await d('/comments'), { text: t, target: args.flags.target, author });
      console.log('commented');
      return;
    }
    case 'comments': {
      const v = await ctx.api(await d());
      for (const c of v.design.comments.slice(-50)) console.log(`${new Date(c.at).toLocaleString()}  ${c.author}${c.target ? ` on ${c.target}` : ''}: ${c.text}`);
      return;
    }
    case 'history': {
      const { entries } = await ctx.api(await d('/history'));
      for (const e of entries.slice(0, 50)) console.log(`rev ${String(e.rev).padStart(3)}  ${new Date(e.at).toLocaleString()}  ${e.author}  ${e.kind}${e.proposal ? ' ' + e.proposal : ''}${e.ops ? `  ${e.ops.map((o: any) => o.op).join(', ')}` : ''}${e.version ? ` v${e.version}` : ''}`);
      return;
    }
    case 'arrange': { const r = await post(await d('/ops'), { ops: [{ op: 'arrange' }], author }); console.log(`arranged, rev ${r.rev}`); return; }
    case 'undo': { const r = await post(await d('/undo'), { author }); console.log(`undone, rev ${r.rev}`); return; }
    case 'approve': {
      const r = await post(await d('/approve'), { by: author });
      console.log(`approved as v${r.version}${r.errors.length ? ` with ${r.errors.length} open error${r.errors.length === 1 ? '' : 's'}` : ''}`);
      return;
    }
    default: console.log(DESIGN_HELP);
  }
}
