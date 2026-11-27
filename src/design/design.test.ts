import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOps, diffDesigns, emptyDesign, OpError, type Design, type Op } from './model';
import { check } from './rules';
import { exportDesign } from './export';
import { DesignStore } from './store';
import { parseColumn } from './cli';

const seed: Op[] = [
  { op: 'add-module', name: 'people', kind: 'platform' },
  { op: 'add-table', table: 'person', module: 'people', columns: [{ name: 'id', type: 'uuid', pk: true }, { name: 'email', type: 'citext' }] },
  { op: 'add-table', table: 'room', module: 'rooms', columns: [{ name: 'id', type: 'uuid', pk: true }, { name: 'name', type: 'text' }] },
  { op: 'add-table', table: 'reservation', module: 'rooms', columns: [
    { name: 'id', type: 'uuid', pk: true },
    { name: 'room_id', type: 'uuid', ref: { table: 'room', column: 'id' } },
    { name: 'person_id', type: 'uuid', ref: { table: 'person', column: 'id' } },
    { name: 'status', type: 'reservation_status' },
  ] },
  { op: 'set-enum', name: 'reservation_status', values: ['held', 'paid', 'expired'] },
];
const base = () => applyOps(emptyDesign('rooms', 'Rooms'), seed);

describe('operations', () => {
  test('a batch builds tables, places them and registers modules', () => {
    const d = base();
    expect(d.tables.map(t => t.name)).toEqual(['person', 'room', 'reservation']);
    expect(d.modules.map(m => `${m.name}:${m.kind}`)).toEqual(['people:platform', 'rooms:module']);
    for (const t of d.tables) expect(typeof t.x).toBe('number');
    // tables of one module do not land on top of each other
    const [room, res] = [d.tables[1], d.tables[2]];
    expect(room.x === res.x && room.y === res.y).toBe(false);
  });

  test('a batch is all or nothing', () => {
    const d = base();
    expect(() => applyOps(d, [{ op: 'add-column', table: 'room', column: { name: 'capacity', type: 'int' } }, { op: 'remove-table', table: 'nope' }])).toThrow(OpError);
    expect(d.tables[1].columns.map(c => c.name)).toEqual(['id', 'name']);
  });

  test('renaming a table or column follows every reference', () => {
    let d = applyOps(base(), [
      { op: 'add-step', id: 'S1', title: 'Book', lane: 'Guest', touches: [{ table: 'reservation', op: 'C', columns: ['status'] }] },
      { op: 'set-machine', table: 'reservation', column: 'status', states: ['held', 'paid'], transitions: [{ from: 'held', to: 'paid', step: 'S1' }] },
    ]);
    d = applyOps(d, [{ op: 'set-table', table: 'room', name: 'venue' }, { op: 'set-column', table: 'reservation', column: 'status', name: 'state' }]);
    expect(d.tables.find(t => t.name === 'reservation')!.columns.find(c => c.name === 'room_id')!.ref).toEqual({ table: 'venue', column: 'id' });
    expect(d.steps[0].touches[0].columns).toEqual(['state']);
    expect(d.machines[0].column).toBe('state');
  });

  test('a referenced table or column cannot be removed', () => {
    expect(() => applyOps(base(), [{ op: 'remove-table', table: 'room' }])).toThrow(/referenced by reservation/);
    expect(() => applyOps(base(), [{ op: 'remove-column', table: 'room', column: 'id' }])).toThrow(/reservation.room_id/);
  });

  test('steps get ids, lanes and flows', () => {
    const d = applyOps(base(), [
      { op: 'add-step', title: 'Pick a room', lane: 'Guest', touches: [{ table: 'room', op: 'R' }] },
      { op: 'add-step', title: 'Hold it', lane: 'System', after: 'S1', touches: [{ table: 'reservation', op: 'c' as 'C' }] },
    ]);
    expect(d.steps.map(s => s.id)).toEqual(['S1', 'S2']);
    expect(d.lanes).toEqual(['Guest', 'System']);
    expect(d.flows).toEqual([{ from: 'S1', to: 'S2' }]);
    expect(d.steps[1].x!).toBeGreaterThan(d.steps[0].x!);
    expect(d.steps[1].y!).toBeGreaterThan(d.steps[0].y!);
  });

  test('bad names and unknown ops are refused', () => {
    expect(() => applyOps(base(), [{ op: 'add-table', table: 'drop table' }])).toThrow(/not a valid name/);
    expect(() => applyOps(base(), [{ op: 'explode' } as unknown as Op])).toThrow(/unknown op/);
  });

  test('the diff names what a proposal adds, removes and changes, ignoring moves', () => {
    const a = base();
    const b = applyOps(a, [
      { op: 'add-table', table: 'reservation_event', module: 'rooms', columns: [{ name: 'id', type: 'uuid', pk: true }] },
      { op: 'remove-column', table: 'reservation', column: 'status' },
      { op: 'set-column', table: 'room', column: 'name', type: 'citext' },
      { op: 'move', kind: 'table', id: 'person', x: 999, y: 999 },
    ]);
    const diff = diffDesigns(a, b);
    expect(diff.tables.added).toEqual(['reservation_event']);
    expect(diff.columns.removed).toEqual(['reservation.status']);
    expect(diff.columns.changed).toEqual(['room.name']);
    expect(diff.tables.changed).toEqual([]);
  });
});

describe('rules', () => {
  test('a module may use the platform but not another business module', () => {
    let d = base();
    expect(check(d).filter(f => f.rule === 'module-boundary')).toEqual([]);
    d = applyOps(d, [{ op: 'add-table', table: 'payment', module: 'payments', columns: [{ name: 'id', type: 'uuid', pk: true }] },
      { op: 'add-column', table: 'reservation', column: { name: 'payment_id', type: 'uuid', ref: { table: 'payment', column: 'id' } } }]);
    const hit = check(d).find(f => f.rule === 'module-boundary')!;
    expect(hit.level).toBe('error');
    expect(hit.target).toBe('column:reservation.payment_id');
    // a logical reference without a constraint is the way out
    d = applyOps(d, [{ op: 'set-column', table: 'reservation', column: 'payment_id', fk: false }]);
    expect(check(d).some(f => f.rule === 'module-boundary')).toBe(false);
  });

  test('required columns, missing data for steps, unreachable states', () => {
    const d = applyOps(base(), [
      { op: 'set-rules', requiredColumns: ['team_id'] },
      { op: 'add-step', id: 'S7', title: 'Refund', touches: [{ table: 'refund', op: 'C' }] },
      { op: 'set-machine', table: 'reservation', column: 'status', states: ['held', 'paid', 'expired'], transitions: [{ from: 'held', to: 'paid' }] },
    ]);
    const rules = check(d).map(f => `${f.level}:${f.rule}:${f.target}`);
    expect(rules).toContain('error:required-column:table:room');
    expect(rules).not.toContain('error:required-column:table:person'); // platform
    expect(rules).toContain('error:step-data:step:S7');
    expect(rules).toContain('warn:machine:machine:reservation.status');
  });

  test('references to missing columns and type mismatches', () => {
    const d = applyOps(base(), [{ op: 'add-column', table: 'room', column: { name: 'owner', type: 'text', ref: { table: 'person', column: 'id' } } },
      { op: 'add-column', table: 'room', column: { name: 'ghost', type: 'uuid', ref: { table: 'person', column: 'nope' } } }]);
    const rules = check(d).map(f => `${f.rule}:${f.target}`);
    expect(rules).toContain('reference-type:column:room.owner');
    expect(rules).toContain('reference:column:room.ghost');
    expect(check(base()).filter(f => f.rule === 'unknown-type')).toEqual([]); // the enum is known
  });
});

describe('export', () => {
  test('dbml, mermaid and markdown carry the model', () => {
    const d = applyOps(base(), [{ op: 'add-assumption', text: 'A reservation belongs to a team', status: 'accepted' },
      { op: 'set-samples', table: 'room', rows: [{ id: 'r-1', name: 'Wisła' }] }]);
    const dbml = exportDesign(d, 'dbml');
    expect(dbml).toContain('Table reservation {');
    expect(dbml).toContain('room_id uuid [not null, ref: > room.id]');
    expect(dbml).toContain('Enum reservation_status');
    const mm = exportDesign(d, 'mermaid');
    expect(mm).toStartWith('erDiagram');
    expect(mm).toContain('room ||--|{ reservation : "room_id"');
    const md = exportDesign(d, 'md');
    expect(md).toContain('A1 ✓ A reservation belongs to a team');
    expect(md).toContain('| r-1 | Wisła |');
    expect(md).toContain('Status: draft');
  });
});

describe('column specs', () => {
  test('the CLI shorthand', () => {
    expect(parseColumn('room_id uuid ref=room.id null')).toEqual({ name: 'room_id', type: 'uuid', ref: { table: 'room', column: 'id' }, nullable: true });
    expect(parseColumn('id uuid pk default=gen_random_uuid()')).toEqual({ name: 'id', type: 'uuid', pk: true, default: 'gen_random_uuid()' });
    expect(() => parseColumn('id')).toThrow();
    expect(() => parseColumn('id uuid wat')).toThrow(/unknown/);
  });
});

describe('store', () => {
  const setup = async () => {
    const home = await mkdtemp(join(tmpdir(), 'dfb-design-'));
    const repo = await mkdtemp(join(tmpdir(), 'dfb-repo-'));
    const s = new DesignStore(join(home, 'designs.json'));
    await s.load();
    const d = await s.create('Rezerwacje sal', repo, { author: 'agent:a' });
    return { s, d, home, repo };
  };

  test('lives in the repo as a file with history, and survives a restart', async () => {
    const { s, d, home, repo } = await setup();
    expect(d.id).toBe('rezerwacje-sal');
    expect(s.file(d.id)).toBe(join(repo, 'docs/boards/rezerwacje-sal.board.json'));
    await s.apply(d.id, seed, 'agent:a');
    const onDisk = JSON.parse(await readFile(s.file(d.id), 'utf8')) as Design;
    expect(onDisk.tables).toHaveLength(3);
    expect(onDisk.rev).toBe(1);
    const hist = (await readFile(join(repo, 'docs/boards/rezerwacje-sal/history.jsonl'), 'utf8')).trim().split('\n');
    expect(hist.map(l => JSON.parse(l).kind)).toEqual(['create', 'ops']);
    s.closeAll();
    const again = new DesignStore(join(home, 'designs.json'));
    await again.load();
    expect(again.get('rezerwacje-sal').tables).toHaveLength(3);
    again.closeAll();
  });

  test('roles: read cannot change, propose only proposes, the user decides', async () => {
    const { s, d } = await setup();
    await s.apply(d.id, seed, 'agent:a');
    await s.join(d.id, 'agent:reviewer', 'propose');
    await s.join(d.id, 'agent:reader', 'read');
    const op: Op[] = [{ op: 'add-column', table: 'room', column: { name: 'capacity', type: 'int' } }];
    await expect(s.apply(d.id, op, 'agent:reader')).rejects.toThrow(/only reads/);
    await expect(s.apply(d.id, op, 'agent:reviewer')).rejects.toThrow(/only propose/);
    await s.apply(d.id, [{ op: 'move', kind: 'table', id: 'room', x: 5, y: 5 }], 'agent:reviewer'); // layout is fine
    const p = await s.propose(d.id, { title: 'capacity', ops: op }, 'agent:reviewer');
    expect(p.id).toBe('P1');
    const pv = s.preview(d.id, { proposal: 'P1' });
    expect(pv.applies).toBe(true);
    expect(pv.diff.columns.added).toEqual(['room.capacity']);
    await expect(s.decide(d.id, 'P1', true, 'agent:reviewer')).rejects.toThrow();
    const done = await s.decide(d.id, 'P1', true, 'you');
    expect(done.status).toBe('accepted');
    expect(s.get(d.id).tables.find(t => t.name === 'room')!.columns.map(c => c.name)).toContain('capacity');
    s.closeAll();
  });

  test('a proposal that no longer fits cannot be accepted', async () => {
    const { s, d } = await setup();
    await s.apply(d.id, seed, 'agent:a');
    await s.propose(d.id, { title: 'x', ops: [{ op: 'add-column', table: 'room', column: { name: 'capacity', type: 'int' } }] }, 'agent:b');
    await s.apply(d.id, [{ op: 'add-column', table: 'room', column: { name: 'capacity', type: 'int' } }], 'you');
    expect(s.preview(d.id, { proposal: 'P1' }).applies).toBe(false);
    await expect(s.decide(d.id, 'P1', true)).rejects.toThrow(/no longer applies/);
    s.closeAll();
  });

  test('undo restores the model but keeps comments; approve snapshots a version', async () => {
    const { s, d, repo } = await setup();
    await s.apply(d.id, seed, 'agent:a');
    await s.apply(d.id, [{ op: 'remove-table', table: 'reservation' }], 'you');
    await s.comment(d.id, 'why?', 'you', 'table:reservation');
    await s.undo(d.id);
    expect(s.get(d.id).tables.map(t => t.name)).toContain('reservation');
    expect(s.get(d.id).comments).toHaveLength(1);
    await expect(s.approve(d.id, 'agent:a')).rejects.toThrow(/only the user/);
    const a = await s.approve(d.id);
    expect(a.version).toBe(1);
    expect(s.get(d.id).draft).toBeUndefined();
    const snap = JSON.parse(await readFile(join(repo, 'docs/boards/rezerwacje-sal/v1.json'), 'utf8'));
    expect(snap.tables).toHaveLength(3);
    await s.apply(d.id, [{ op: 'move', kind: 'table', id: 'room', x: 1, y: 1 }]);
    expect(s.get(d.id).draft).toBeUndefined(); // moving things around is not a change
    await s.apply(d.id, [{ op: 'add-column', table: 'room', column: { name: 'floor', type: 'int' } }]);
    expect(s.get(d.id).draft).toBe(true);
    s.closeAll();
  });

  test('takes the version on disk after a checkout rewrites the file', async () => {
    const { s, d } = await setup();
    let events = 0;
    s.onChange(() => events++);
    const file = s.file(d.id);
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    onDisk.name = 'From another branch';
    await writeFile(file, JSON.stringify(onDisk, null, 2));
    for (let i = 0; i < 80 && s.get(d.id).name !== 'From another branch'; i++) await Bun.sleep(50);
    expect(s.get(d.id).name).toBe('From another branch');
    expect(events).toBeGreaterThan(0);
    s.closeAll();
  }, 10000);
});

test('module frames do not overlap when a module grows', () => {
  let d = applyOps(emptyDesign('x', 'x'), [
    { op: 'add-table', table: 'a1', module: 'rooms', columns: Array.from({ length: 12 }, (_, i) => ({ name: `c${i}`, type: 'text' })) },
    { op: 'add-table', table: 'a2', module: 'rooms', columns: Array.from({ length: 12 }, (_, i) => ({ name: `c${i}`, type: 'text' })) },
    { op: 'add-table', table: 'p1', module: 'people', columns: [{ name: 'id', type: 'uuid', pk: true }] },
  ]);
  d = applyOps(d, [{ op: 'add-table', table: 'a3', module: 'rooms', columns: [{ name: 'id', type: 'uuid', pk: true }] }]);
  const span = (m: string) => { const ts = d.tables.filter(t => t.module === m); return [Math.min(...ts.map(t => t.x!)), Math.max(...ts.map(t => t.x! + 260))]; };
  const [r0, r1] = span('rooms'), [p0, p1] = span('people');
  expect(r1 <= p0 || p1 <= r0).toBe(true);
});

test('a table added to a design with a process never lands on the lanes or on notes', () => {
  let d = applyOps(emptyDesign('x', 'x'), [
    { op: 'add-table', table: 'a1', module: 'rooms', columns: Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, type: 'text' })) },
    { op: 'add-table', table: 'a2', module: 'rooms', columns: Array.from({ length: 10 }, (_, i) => ({ name: `c${i}`, type: 'text' })) },
    { op: 'add-step', title: 'x', lane: 'Guest' },
    { op: 'add-assumption', text: 'y' },
  ]);
  for (let i = 0; i < 4; i++) d = applyOps(d, [{ op: 'add-table', table: `n${i}`, module: 'rooms', columns: Array.from({ length: 8 }, (_, j) => ({ name: `c${j}`, type: 'text' })) }]);
  for (const t of d.tables) expect(t.y! + 34 + t.columns.length * 22).toBeLessThan(900 - 40);
  const a = d.assumptions[0];
  for (const t of d.tables) expect(t.x! + 260 <= a.x! || t.x! >= a.x! + 230 || t.y! + 300 <= a.y! || t.y! >= a.y! + 140).toBe(true);
});
