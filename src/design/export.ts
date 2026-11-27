import type { Column, Design, Table } from './model';
import { check } from './rules';

export type ExportFormat = 'md' | 'dbml' | 'mermaid' | 'json';
export const FORMATS: ExportFormat[] = ['md', 'dbml', 'mermaid', 'json'];

export function exportDesign(d: Design, format: ExportFormat): string {
  if (format === 'json') return JSON.stringify(d, null, 2);
  if (format === 'dbml') return dbml(d);
  if (format === 'mermaid') return mermaid(d);
  return markdown(d);
}

const colFlags = (c: Column) => [c.pk && 'pk', c.unique && 'unique', !c.nullable && !c.pk && 'not null', c.default && `default: ${c.default}`].filter(Boolean) as string[];

function dbml(d: Design) {
  const out: string[] = [`// ${d.name}${d.approved ? ` · v${d.approved.version}${d.draft ? ' + changes' : ''}` : ' · draft'}`];
  for (const e of d.enums) out.push(`Enum ${e.name} {\n${e.values.map(v => `  "${v}"`).join('\n')}\n}`);
  for (const t of d.tables) {
    const lines = t.columns.map(c => {
      const flags = colFlags(c);
      if (c.ref && c.fk !== false) flags.push(`ref: > ${c.ref.table}.${c.ref.column}`);
      if (c.note) flags.push(`note: '${c.note.replace(/'/g, "\\'")}'`);
      return `  ${c.name} ${/[\s(),]/.test(c.type) ? `"${c.type}"` : c.type}${flags.length ? ` [${flags.join(', ')}]` : ''}`;
    });
    const notes = [t.module && `module: ${t.module}`, t.kind === 'view' && 'view', t.note].filter(Boolean).join(' · ');
    if (notes) lines.push(`  Note: '${notes.replace(/'/g, "\\'")}'`);
    out.push(`Table ${t.name} {\n${lines.join('\n')}\n}`);
  }
  const logical = d.tables.flatMap(t => t.columns.filter(c => c.ref && c.fk === false).map(c => `// logical reference, no constraint: ${t.name}.${c.name} > ${c.ref!.table}.${c.ref!.column}`));
  return [...out, ...logical].join('\n\n') + '\n';
}

const mmType = (t: string) => t.replace(/[^\w]/g, '_');
function mermaid(d: Design) {
  const out = ['erDiagram'];
  for (const t of d.tables) {
    out.push(`  ${t.name} {`);
    for (const c of t.columns) {
      const key = [c.pk && 'PK', c.ref && 'FK', c.unique && 'UK'].filter(Boolean).join(',');
      const note = [c.nullable ? 'nullable' : '', c.note ?? ''].filter(Boolean).join('; ');
      out.push(`    ${mmType(c.type)} ${c.name}${key ? ' ' + key : ''}${note ? ` "${note.replace(/"/g, "'")}"` : ''}`);
    }
    out.push('  }');
  }
  for (const t of d.tables) for (const c of t.columns) if (c.ref) {
    const one = c.unique || c.pk;
    out.push(`  ${c.ref.table} ||--${c.nullable ? 'o' : '|'}${one ? '|' : '{'} ${t.name} : "${c.name}${c.fk === false ? ' (no fk)' : ''}"`);
  }
  return out.join('\n') + '\n';
}

function tableMd(t: Table) {
  const head = `### ${t.name}${t.kind === 'view' ? ' (view)' : ''}${t.module ? ` · module ${t.module}` : ''}`;
  const rows = t.columns.map(c => `| ${c.name} | ${c.type} | ${[...colFlags(c), c.ref && `→ ${c.ref.table}.${c.ref.column}${c.fk === false ? ' (no fk)' : ''}`].filter(Boolean).join(', ')} | ${c.note ?? ''} |`);
  const parts = [head, ...(t.note ? [t.note] : []), '| column | type | constraints | note |', '|---|---|---|---|', ...rows];
  if (t.samples?.length) {
    const keys = t.columns.map(c => c.name).filter(k => t.samples!.some(r => k in r));
    parts.push('', 'Sample rows:', '', `| ${keys.join(' | ')} |`, `|${keys.map(() => '---').join('|')}|`, ...t.samples.map(r => `| ${keys.map(k => r[k] ?? '').join(' | ')} |`));
  }
  return parts.join('\n');
}

/** Everything an implementing agent needs, as text it can read in one go. */
function markdown(d: Design) {
  const status = d.approved ? `v${d.approved.version}, approved by ${d.approved.by} on ${new Date(d.approved.at).toISOString().slice(0, 10)}${d.draft ? ' (changed since: not approved yet)' : ''}` : 'draft, not approved';
  const out = [`# Design: ${d.name}`, '', `Status: ${status} · rev ${d.rev}`];
  if (d.purpose) out.push('', d.purpose);
  const acc = d.assumptions.filter(a => a.status === 'accepted');
  const open = d.assumptions.filter(a => a.status === 'open' || a.status === 'question');
  if (d.assumptions.length) {
    out.push('', '## Assumptions');
    for (const a of acc) out.push(`- ${a.id} ✓ ${a.text}`);
    for (const a of open) out.push(`- ${a.id} ${a.status === 'question' ? '? (open question)' : '… (not decided)'} ${a.text}`);
    for (const a of d.assumptions.filter(x => x.status === 'rejected')) out.push(`- ${a.id} ✗ rejected: ${a.text}`);
  }
  if (d.modules.length) out.push('', '## Modules', ...d.modules.map(m => `- ${m.name} (${m.kind}${m.path ? `, ${m.path}` : ''})`));
  if (d.tables.length) out.push('', '## Data model', '', ...d.tables.map(tableMd).flatMap(x => [x, '']));
  if (d.enums.length) out.push('## Enums', ...d.enums.map(e => `- ${e.name}: ${e.values.join(', ')}`), '');
  if (d.steps.length) {
    out.push('## Process');
    const order = topo(d);
    for (const s of order) {
      const io = s.touches.map(t => `${t.op} ${t.table}${t.columns?.length ? `(${t.columns.join(', ')})` : ''}`).join(', ');
      const next = d.flows.filter(f => f.from === s.id).map(f => `${f.to}${f.label ? ` [${f.label}]` : ''}`).join(', ');
      out.push(`- ${s.id} ${s.title}${s.lane ? ` · ${s.lane}` : ''}${s.trigger ? ` · trigger: ${s.trigger}` : ''}${io ? ` · data: ${io}` : ''}${next ? ` · then: ${next}` : ''}${s.note ? `\n  ${s.note}` : ''}`);
    }
    out.push('');
  }
  for (const m of d.machines) {
    out.push(`## States of ${m.table}.${m.column}`, `States: ${m.states.join(', ')}`, ...m.transitions.map(t => `- ${t.from} → ${t.to}${t.step ? ` (${t.step})` : ''}${t.label ? `: ${t.label}` : ''}`), '');
  }
  const f = check(d).filter(x => x.level !== 'info');
  if (f.length) out.push('## Open findings', ...f.map(x => `- ${x.level}: ${x.message}`), '');
  const props = d.proposals.filter(p => p.status === 'open');
  if (props.length) out.push('## Open proposals (not part of the model above)', ...props.map(p => `- ${p.id} ${p.title} by ${p.author}${p.rationale ? `: ${p.rationale}` : ''}`), '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

function topo(d: Design) {
  const seen = new Set<string>(), out: Design['steps'] = [];
  const starts = d.steps.filter(s => !d.flows.some(f => f.to === s.id));
  const visit = (id: string) => {
    if (seen.has(id)) return;
    const s = d.steps.find(x => x.id === id); if (!s) return;
    seen.add(id); out.push(s);
    for (const f of d.flows.filter(x => x.from === id)) visit(f.to);
  };
  for (const s of starts) visit(s.id);
  for (const s of d.steps) visit(s.id);
  return out;
}
