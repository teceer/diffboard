import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { git, trackedSources } from './git';

const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX = EXTS.map(e => '/index' + e);

/** Strips // and /* *\/ comments and trailing commas outside strings, so tsconfig (JSONC) parses. */
export function parseJsonc(text: string): any {
  let out = '';
  let inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

interface PathAlias { prefix: string; suffix: string; wildcard: boolean; targets: string[] }

/** Reads compilerOptions.paths/baseUrl, following relative `extends` chains. Targets are repo-absolute. */
function loadAliases(root: string): PathAlias[] {
  const seen = new Set<string>();
  let paths: Record<string, string[]> | undefined;
  let baseUrl: string | undefined;
  let configDir = root;
  const visit = (file: string) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    let json: any;
    try { json = parseJsonc(readFileSync(file, 'utf8')); } catch { return; }
    const co = json.compilerOptions ?? {};
    if (!paths && co.paths) { paths = co.paths; configDir = dirname(file); baseUrl = co.baseUrl; }
    if (baseUrl === undefined && co.baseUrl) baseUrl = co.baseUrl;
    const ext = typeof json.extends === 'string' ? [json.extends] : Array.isArray(json.extends) ? json.extends : [];
    for (const e of ext) if (e.startsWith('.')) visit(resolve(dirname(file), e.endsWith('.json') ? e : e + '.json'));
  };
  visit(join(root, 'tsconfig.json'));
  if (!paths) return [];
  const base = resolve(configDir, baseUrl ?? '.');
  return Object.entries(paths).map(([key, targets]) => {
    const star = key.indexOf('*');
    return {
      prefix: star === -1 ? key : key.slice(0, star),
      suffix: star === -1 ? '' : key.slice(star + 1),
      wildcard: star !== -1,
      targets: targets.map(t => resolve(base, t)),
    };
  }).sort((a, b) => b.prefix.length - a.prefix.length);
}

const SPEC_RE = [
  /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /import\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /require\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

export function extractSpecifiers(code: string): string[] {
  const out = new Set<string>();
  for (const re of SPEC_RE) { re.lastIndex = 0; let m; while ((m = re.exec(code))) out.add(m[1]); }
  return [...out];
}

export interface PackageTarget { repoId: string; root: string; entry: string | null }

/**
 * Import graph of one repository, refreshed incrementally by mtime.
 * Edges point from importer to imported file (repo-relative paths, or `repoId:path` across repos).
 */
export class ImportGraph {
  private aliases: PathAlias[];
  private cache = new Map<string, { mtime: number; targets: string[] }>();
  private files = new Set<string>();
  imports = new Map<string, Set<string>>();
  importers = new Map<string, Set<string>>();
  /** Packages of this repo's own workspace (monorepo), by name: `@acme/db` -> packages/db. */
  private workspace = new Map<string, { dir: string; json: any }>();
  private workspaceSig = '';

  constructor(public root: string, public repoId: string, private packages: () => Map<string, PackageTarget>) {
    this.aliases = loadAliases(root);
  }

  reloadAliases() { this.aliases = loadAliases(this.root); this.cache.clear(); }

  private exists(abs: string): boolean {
    try { return statSync(abs).isFile(); } catch { return false; }
  }

  private tryFile(abs: string): string | null {
    if (this.exists(abs)) return abs;
    for (const e of EXTS) if (this.exists(abs + e)) return abs + e;
    for (const i of INDEX) if (this.exists(abs + i)) return abs + i;
    if (/\.(m|c)?js$/.test(abs)) {
      const stem = abs.replace(/\.(m|c)?js$/, '');
      for (const e of ['.ts', '.tsx', '.mts', '.cts']) if (this.exists(stem + e)) return stem + e;
    }
    return null;
  }

  /** Resolves a specifier to `path` (same repo) or `repoId:path` (another watched repo). */
  resolveSpec(fromRel: string, spec: string): string | null {
    const fromAbs = join(this.root, fromRel);
    let abs: string | null = null;
    if (spec.startsWith('.')) abs = this.tryFile(resolve(dirname(fromAbs), spec));
    else {
      for (const a of this.aliases) {
        if (a.wildcard ? (spec.startsWith(a.prefix) && spec.endsWith(a.suffix) && spec.length >= a.prefix.length + a.suffix.length) : spec === a.prefix) {
          const mid = a.wildcard ? spec.slice(a.prefix.length, spec.length - a.suffix.length) : '';
          for (const t of a.targets) { abs = this.tryFile(t.replace('*', mid)); if (abs) break; }
          if (abs) break;
        }
      }
      if (!abs) {
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        const ws = this.workspace.get(name);
        if (ws) abs = this.packageFile(ws.dir, ws.json, spec.slice(name.length).replace(/^\//, ''));
      }
      if (!abs) {
        const pkgs = this.packages();
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        const pkg = pkgs.get(name);
        if (pkg && pkg.repoId !== this.repoId) {
          const sub = spec.slice(name.length).replace(/^\//, '');
          let target: string | null = null;
          if (sub) target = this.tryFileIn(pkg.root, join(pkg.root, 'src', sub)) ?? this.tryFileIn(pkg.root, join(pkg.root, sub));
          target ??= pkg.entry;
          return target ? `${pkg.repoId}:${relative(pkg.root, target)}` : null;
        }
      }
    }
    if (!abs) return null;
    const rel = relative(this.root, abs);
    if (rel.startsWith('..')) return null;
    return normalize(rel);
  }

  private tryFileIn(_root: string, abs: string): string | null { return this.tryFile(abs); }

  /** The file a workspace package exposes for `sub` ('' = the package itself): exports, then main/types, then src/. */
  private packageFile(dir: string, json: any, sub: string): string | null {
    const pick = (v: any): string | null => typeof v === 'string' ? v : v && typeof v === 'object' ? pick(v.types ?? v.import ?? v.default ?? v.require ?? v.node ?? Object.values(v)[0]) : null;
    const ex = json.exports;
    const key = sub ? `./${sub}` : '.';
    let target: string | null = null;
    if (ex && typeof ex === 'object' && !Array.isArray(ex) && Object.keys(ex).some(k => k.startsWith('.'))) {
      target = pick(ex[key]);
      if (!target) for (const [k, v] of Object.entries(ex)) {
        const star = k.indexOf('*');
        if (star < 0 || !key.startsWith(k.slice(0, star)) || !key.endsWith(k.slice(star + 1))) continue;
        const mid = key.slice(star, key.length - (k.length - star - 1));
        target = pick(v)?.replace('*', mid) ?? null;
        if (target) break;
      }
    } else if (!sub) target = pick(ex) ?? json.types ?? json.module ?? json.main ?? null;
    const found = target ? this.tryFile(resolve(dir, target)) : null;
    if (found) return found;
    return sub ? this.tryFile(join(dir, 'src', sub)) ?? this.tryFile(join(dir, sub)) : this.tryFile(join(dir, 'src', 'index')) ?? this.tryFile(join(dir, 'index'));
  }

  private async loadWorkspace() {
    const raw = await git(this.root, ['ls-files', '-z', '--', '*package.json']).catch(() => '');
    const next = new Map<string, { dir: string; json: any }>();
    for (const rel of raw.split('\0')) {
      if (!rel || !(rel === 'package.json' || rel.endsWith('/package.json')) || rel.includes('node_modules/')) continue;
      try {
        const json = JSON.parse(readFileSync(join(this.root, rel), 'utf8'));
        if (json.name && !next.has(json.name)) next.set(json.name, { dir: join(this.root, dirname(rel)), json });
      } catch { /* not valid JSON */ }
    }
    const sig = JSON.stringify([...next].map(([n, v]) => [n, v.dir, v.json.exports, v.json.main, v.json.types]));
    if (sig !== this.workspaceSig) { this.workspace = next; this.workspaceSig = sig; this.cache.clear(); }
  }

  private parse(rel: string): string[] {
    const abs = join(this.root, rel);
    let mtime = 0;
    try { mtime = statSync(abs).mtimeMs; } catch { return []; }
    const hit = this.cache.get(rel);
    if (hit && hit.mtime === mtime) return hit.targets;
    let code = '';
    try { code = readFileSync(abs, 'utf8'); } catch { return []; }
    const targets = [...new Set(extractSpecifiers(code).map(s => this.resolveSpec(rel, s)).filter((t): t is string => !!t && t !== rel))];
    this.cache.set(rel, { mtime, targets });
    return targets;
  }

  /** Rescans all source files (cheap thanks to the mtime cache) and rebuilds both edge directions. */
  async refresh(): Promise<void> {
    await this.loadWorkspace();
    const list = await trackedSources(this.root);
    this.files = new Set(list);
    for (const k of [...this.cache.keys()]) if (!this.files.has(k)) this.cache.delete(k);
    this.imports.clear();
    this.importers.clear();
    for (const f of list) {
      const t = this.parse(f);
      this.imports.set(f, new Set(t));
      for (const target of t) {
        if (!this.importers.has(target)) this.importers.set(target, new Set());
        this.importers.get(target)!.add(f);
      }
    }
  }

  has(rel: string) { return this.files.has(rel); }
}

/** Maps package names (from package.json) of watched repos to their source entry file. */
export function packageTarget(repoId: string, root: string): [string, PackageTarget] | null {
  const pj = join(root, 'package.json');
  if (!existsSync(pj)) return null;
  let json: any;
  try { json = JSON.parse(readFileSync(pj, 'utf8')); } catch { return null; }
  if (!json.name) return null;
  const candidates = ['src/index.ts', 'src/index.tsx', 'index.ts', json.source, json.types?.replace(/^\.?\/?dist\//, 'src/').replace(/\.d\.ts$/, '.ts')].filter(Boolean);
  const entry = candidates.map((c: string) => join(root, c)).find((c: string) => existsSync(c)) ?? null;
  return [json.name, { repoId, root, entry }];
}
