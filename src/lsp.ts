import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/**
 * Language servers for the code views: hover types, occurrences, definitions and references.
 * One server per (repo, language), started on the first request and stopped when idle. The board
 * never edits through LSP; it opens files from disk and resyncs them whenever their text changed.
 */

export type LspOp = 'hover' | 'highlight' | 'definition' | 'references';
export interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface Location { uri: string; range: Range }

interface ServerSpec { name: string; match: RegExp; languageId: (path: string) => string; command: (root: string) => string[] | null }

const which = (bin: string) => Bun.which(bin);
const ZED_VTSLS = join(process.env.HOME ?? '', 'Library/Application Support/Zed/languages/vtsls/node_modules/.bin/vtsls');
const OWN_VTSLS = join(import.meta.dir, '..', 'node_modules', '.bin', 'vtsls');

const SERVERS: ServerSpec[] = [
  {
    name: 'vtsls',
    match: /\.(m|c)?[jt]sx?$/i,
    languageId: p => (/\.(m|c)?tsx?$/i.test(p) ? (p.endsWith('x') ? 'typescriptreact' : 'typescript') : p.endsWith('x') ? 'javascriptreact' : 'javascript'),
    command: () => {
      const bin = process.env.DIFFBOARD_TS_LSP || (existsSync(OWN_VTSLS) ? OWN_VTSLS : existsSync(ZED_VTSLS) ? ZED_VTSLS : which('vtsls'));
      if (bin) return [bin, '--stdio'];
      const tls = which('typescript-language-server');
      return tls ? [tls, '--stdio'] : null;
    },
  },
  {
    name: 'rust-analyzer',
    match: /\.rs$/i,
    languageId: () => 'rust',
    command: () => { const b = which('rust-analyzer'); return b ? [b] : null; },
  },
];

export const lspFor = (path: string) => SERVERS.find(s => s.match.test(path)) ?? null;

class LspClient {
  private proc: ReturnType<typeof Bun.spawn>;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private opened = new Map<string, { version: number; text: string }>();
  private ready: Promise<void>;
  lastUsed = Date.now();
  dead = false;

  constructor(private root: string, private spec: ServerSpec, cmd: string[]) {
    this.proc = Bun.spawn(cmd, { cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
    this.read();
    this.proc.exited.then(() => {
      this.dead = true;
      for (const p of this.pending.values()) p.reject(new Error(`${spec.name} exited`));
      this.pending.clear();
    });
    this.ready = this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: root.split('/').pop() }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: true },
          references: {},
          documentHighlight: {},
          synchronization: { didSave: false },
        },
      },
    }, 60000).then(() => this.notify('initialized', {}));
  }

  private async read() {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    let buf = new Uint8Array(0);
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done || !value) return;
      const next = new Uint8Array(buf.length + value.length); next.set(buf); next.set(value, buf.length); buf = next;
      for (;;) {
        // header and body lengths are in bytes, so the frame is cut on the byte buffer
        const sep = indexOf(buf, [13, 10, 13, 10]);
        if (sep < 0) break;
        const len = Number(/Content-Length: *(\d+)/i.exec(dec.decode(buf.subarray(0, sep)))?.[1] ?? 0);
        if (buf.length < sep + 4 + len) break;
        const body = dec.decode(buf.subarray(sep + 4, sep + 4 + len));
        buf = buf.slice(sep + 4 + len);
        try { this.onMessage(JSON.parse(body)); } catch { /* ignore a malformed frame */ }
      }
    }
  }

  private onMessage(m: any) {
    if (m.id !== undefined && m.method) {
      // requests from the server: answer what lets it work, decline the rest politely
      let result: unknown = null;
      if (m.method === 'workspace/configuration') result = (m.params?.items ?? []).map((i: any) => (i.section === 'vtsls' ? { autoUseWorkspaceTsdk: true } : i.section === 'typescript' || i.section === 'javascript' ? {} : null));
      if (m.method === 'workspace/workspaceFolders') result = [{ uri: pathToFileURL(this.root).href, name: this.root.split('/').pop() }];
      this.send({ jsonrpc: '2.0', id: m.id, result });
      return;
    }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  }

  private send(msg: unknown) {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const sink = this.proc.stdin as import('bun').FileSink;
    sink.write(`Content-Length: ${body.length}\r\n\r\n`);
    sink.write(body);
    sink.flush();
  }

  request(method: string, params: unknown, timeout = 30000): Promise<any> {
    if (this.dead) return Promise.reject(new Error(`${this.spec.name} is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${this.spec.name}: ${method} timed out (the project may still be loading)`)); }, timeout);
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method: string, params: unknown) { if (!this.dead) this.send({ jsonrpc: '2.0', method, params }); }

  /** Opens the file, or resends it when the text on disk changed since the server last saw it. */
  async sync(abs: string) {
    await this.ready;
    const uri = pathToFileURL(abs).href;
    const text = await readFile(abs, 'utf8');
    const doc = this.opened.get(uri);
    if (!doc) {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.spec.languageId(abs), version: 1, text } });
      this.opened.set(uri, { version: 1, text });
    } else if (doc.text !== text) {
      doc.version++; doc.text = text;
      this.notify('textDocument/didChange', { textDocument: { uri, version: doc.version }, contentChanges: [{ text }] });
    }
    return uri;
  }

  stop() {
    if (this.dead) return;
    this.request('shutdown', null, 3000).catch(() => {}).finally(() => { this.notify('exit', null); setTimeout(() => this.proc.kill(), 500); });
  }
}

function indexOf(buf: Uint8Array, seq: number[]) {
  outer: for (let i = 0; i <= buf.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

const IDLE_MS = 10 * 60_000;
const clients = new Map<string, LspClient>();
setInterval(() => {
  for (const [k, c] of clients) if (c.dead || Date.now() - c.lastUsed > IDLE_MS) { c.stop(); clients.delete(k); }
}, 60_000).unref?.();

function clientFor(root: string, path: string) {
  const spec = lspFor(path);
  if (!spec) return { error: 'no language server for this file type' } as const;
  const key = `${spec.name}\0${root}`;
  let c = clients.get(key);
  if (!c || c.dead) {
    const cmd = spec.command(root);
    if (!cmd) return { error: `${spec.name} is not installed` } as const;
    c = new LspClient(root, spec, cmd);
    clients.set(key, c);
  }
  c.lastUsed = Date.now();
  return { client: c, name: spec.name } as const;
}

const toLocations = (r: any): Location[] => {
  if (!r) return [];
  const list = Array.isArray(r) ? r : [r];
  return list.map((l: any) => (l.targetUri ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l)).filter((l: any) => l?.uri && l.range);
};

const hoverText = (h: any): string => {
  const c = h?.contents;
  if (!c) return '';
  const one = (x: any) => (typeof x === 'string' ? x : x.language ? '```' + x.language + '\n' + x.value + '\n```' : x.value ?? '');
  return Array.isArray(c) ? c.map(one).filter(Boolean).join('\n\n---\n\n') : one(c);
};

/** One request against the file's language server; locations come back as absolute paths with their line text. */
export async function lspQuery(root: string, abs: string, op: LspOp, line: number, character: number) {
  const got = clientFor(root, abs);
  if ('error' in got) return { error: got.error };
  const { client, name } = got;
  const uri = await client.sync(abs);
  const at = { textDocument: { uri }, position: { line, character } };
  if (op === 'hover') return { server: name, hover: hoverText(await client.request('textDocument/hover', at)) };
  if (op === 'highlight') {
    const hs = (await client.request('textDocument/documentHighlight', at)) ?? [];
    return { server: name, ranges: hs.map((h: any) => ({ ...h.range, kind: h.kind ?? 1 })) };
  }
  const locs = toLocations(op === 'definition'
    ? await client.request('textDocument/definition', at)
    : await client.request('textDocument/references', { ...at, context: { includeDeclaration: true } }, 60000)).slice(0, 500);
  // the line each location sits on, read once per file
  const texts = new Map<string, string[] | null>();
  const out = [];
  for (const l of locs) {
    const file = l.uri.startsWith('file:') ? fileURLToPath(l.uri) : l.uri;
    if (!texts.has(file)) texts.set(file, await readFile(file, 'utf8').then(t => t.split('\n'), () => null));
    out.push({ file, range: l.range, text: texts.get(file)?.[l.range.start.line]?.slice(0, 400) ?? '' });
  }
  return { server: name, locations: out };
}
