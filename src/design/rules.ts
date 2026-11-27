import type { Design } from './model';

/**
 * Checks a design the way a reviewer would, before any migration exists. `target` names what the
 * finding is about so the canvas can select it: "table:<name>", "column:<table>.<col>",
 * "step:<id>", "machine:<table>.<col>", "assumption:<id>".
 */
export interface Finding { level: 'error' | 'warn' | 'info'; rule: string; target: string; message: string }

const BASE_TYPES = /^(uuid|text|varchar|char|citext|int|integer|smallint|bigint|serial|bigserial|numeric|decimal|real|double|float|bool|boolean|date|time|timetz|timestamp|timestamptz|interval|json|jsonb|bytea|inet|tstzrange|tsrange|daterange|int4range|int8range)\b/i;

export function check(d: Design): Finding[] {
  const out: Finding[] = [];
  const push = (level: Finding['level'], rule: string, target: string, message: string) => out.push({ level, rule, target, message });
  const tables = new Map(d.tables.map(t => [t.name, t]));
  const moduleKind = (name?: string) => (name ? d.modules.find(m => m.name === name)?.kind ?? 'module' : undefined);
  const enums = new Set(d.enums.map(e => e.name));

  for (const t of d.tables) {
    if (t.kind !== 'view' && !t.columns.some(c => c.pk)) push('warn', 'primary-key', `table:${t.name}`, `${t.name} has no primary key`);
    for (const c of t.columns) {
      const bare = c.type.replace(/\[\]$/, '');
      if (!BASE_TYPES.test(bare) && !enums.has(bare) && !/^enum\b/i.test(bare)) push('warn', 'unknown-type', `column:${t.name}.${c.name}`, `${t.name}.${c.name}: type ${c.type} is neither a SQL type nor an enum on the board`);
      if (!c.ref) continue;
      const target = tables.get(c.ref.table);
      if (!target) { push('error', 'reference', `column:${t.name}.${c.name}`, `${t.name}.${c.name} points at ${c.ref.table}, which is not on the board`); continue; }
      const tc = target.columns.find(x => x.name === c.ref!.column);
      if (!tc) { push('error', 'reference', `column:${t.name}.${c.name}`, `${t.name}.${c.name} points at ${c.ref.table}.${c.ref.column}, which does not exist`); continue; }
      if (tc.type !== c.type) push('warn', 'reference-type', `column:${t.name}.${c.name}`, `${t.name}.${c.name} is ${c.type} but ${c.ref.table}.${c.ref.column} is ${tc.type}`);
      if (!tc.pk && !tc.unique) push('warn', 'reference-unique', `column:${t.name}.${c.name}`, `${t.name}.${c.name} points at ${c.ref.table}.${c.ref.column}, which is neither a key nor unique`);
      // a business module may use the platform, never another business module's tables
      if (d.rules.crossModuleFk !== 'off' && c.fk !== false && t.module && target.module && t.module !== target.module
        && moduleKind(t.module) === 'module' && moduleKind(target.module) === 'module') {
        push(d.rules.crossModuleFk, 'module-boundary', `column:${t.name}.${c.name}`,
          `${t.name}.${c.name} → ${target.name}: a foreign key from module ${t.module} into module ${target.module}. Keep the id without a constraint (fk: false) and read through ${target.module}'s public API`);
      }
    }
    if (t.module && moduleKind(t.module) === 'module' && t.kind !== 'view')
      for (const req of d.rules.requiredColumns) if (!t.columns.some(c => c.name === req)) push('error', 'required-column', `table:${t.name}`, `${t.name} has no ${req} (required in every module table)`);
    for (const [i, row] of (t.samples ?? []).entries())
      for (const k of Object.keys(row)) if (!t.columns.some(c => c.name === k)) push('warn', 'sample', `table:${t.name}`, `${t.name}: sample row ${i + 1} has ${k}, which is not a column`);
  }

  for (const s of d.steps) {
    for (const tt of s.touches) {
      const t = tables.get(tt.table);
      if (!t) { push('error', 'step-data', `step:${s.id}`, `${s.id} “${s.title}” ${verb(tt.op)} ${tt.table}, which is not on the board: the data has nowhere to live`); continue; }
      for (const c of tt.columns ?? []) if (!t.columns.some(x => x.name === c)) push('error', 'step-data', `step:${s.id}`, `${s.id} ${verb(tt.op)} ${t.name}.${c}, which does not exist`);
    }
  }
  if (d.steps.length) {
    const used = new Set(d.steps.flatMap(s => s.touches.map(t => t.table)));
    for (const t of d.tables) if (!used.has(t.name)) push('info', 'unused-table', `table:${t.name}`, `no process step reads or writes ${t.name}`);
    for (const s of d.steps) if (!d.flows.some(f => f.from === s.id || f.to === s.id) && d.steps.length > 1) push('info', 'lonely-step', `step:${s.id}`, `${s.id} “${s.title}” is not connected to the rest of the process`);
  }

  for (const m of d.machines) {
    const key = `machine:${m.table}.${m.column}`;
    const t = tables.get(m.table);
    if (!t || !t.columns.some(c => c.name === m.column)) { push('error', 'machine', key, `state machine of ${m.table}.${m.column}: the column does not exist`); continue; }
    const reach = new Set([m.states[0]]);
    for (let grew = true; grew;) { grew = false; for (const tr of m.transitions) if (reach.has(tr.from) && !reach.has(tr.to)) { reach.add(tr.to); grew = true; } }
    for (const st of m.states) if (!reach.has(st)) push('warn', 'machine', key, `${m.table}.${m.column}: state “${st}” cannot be reached from “${m.states[0]}”`);
    for (const tr of m.transitions) {
      if (tr.step && !d.steps.some(s => s.id === tr.step)) push('error', 'machine', key, `${m.table}.${m.column}: transition ${tr.from} → ${tr.to} names step ${tr.step}, which does not exist`);
      if (tr.step && d.steps.some(s => s.id === tr.step) && !d.steps.find(s => s.id === tr.step)!.touches.some(x => x.table === m.table && (x.op === 'U' || x.op === 'C')))
        push('warn', 'machine', key, `${tr.step} moves ${m.table} from ${tr.from} to ${tr.to} but does not write ${m.table}`);
    }
  }

  for (const a of d.assumptions) if (a.status === 'question') push('info', 'question', `assumption:${a.id}`, `open question ${a.id}: ${a.text}`);
  return out;
}

const verb = (op: string) => ({ C: 'creates', R: 'reads', U: 'updates', D: 'deletes' } as Record<string, string>)[op] ?? 'uses';
