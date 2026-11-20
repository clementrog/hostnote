#!/usr/bin/env node
// hostnote <port> [--tailnet]: serves localhost:<port> again on another port, with a notes layer
// on every HTML page. Notes go to <project>/.hostnote.md, one per line.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import dns from 'node:dns';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_TAG = Buffer.from('<script src="/__hostnote/overlay.js"></script>');
const HEADER = '<!-- Notes left on the running app with hostnote, one per line: act on each note, then delete its line. -->';

// ---- The notes file -------------------------------------------------------------------------

// A quoted string in a line: "…" with \" and \\ escaped.
const Q = '"((?:[^"\\\\]|\\\\.)*)"';
const LINE = new RegExp(
  '^- (\\S+) · (?:' +
    `text ${Q} in \`([^\`]*)\`` + '|' +
    `\`([^\`]*)\` ${Q}` + '|' +
    'box (-?\\d+),(-?\\d+) (\\d+)×(\\d+) in `([^`]*)`' +
  ') — (.*) <!-- id:([a-z0-9]+) -->\\s*$', 'd');

const quote = (s) => '"' + oneLine(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const unquote = (s) => s.replace(/\\(.)/g, '$1');
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const tick = (s) => '`' + oneLine(s).replace(/`/g, '') + '`';
// The note may hold anything typed; keep it from ending or opening a comment.
const noteText = (s) => oneLine(s).replace(/-->/g, '-- >').replace(/<!--/g, '< !--');

export function parseLine(line) {
  const m = LINE.exec(line);
  if (!m) return null;
  const [, page, tText, tSel, eSel, eText, bx, by, bw, bh, bSel, note, id] = m;
  if (tSel !== undefined) return { id, page, kind: 'text', selector: tSel, text: unquote(tText), note };
  if (eSel !== undefined) return { id, page, kind: 'element', selector: eSel, text: unquote(eText), note };
  return { id, page, kind: 'box', selector: bSel, x: +bx, y: +by, w: +bw, h: +bh, note };
}

export function formatLine(n) {
  const page = String(n.page || '/').replace(/\s/g, '%20');
  let on;
  if (n.kind === 'text') on = `text ${quote(oneLine(n.text).slice(0, 300))} in ${tick(n.selector || 'body')}`;
  else if (n.kind === 'box') on = `box ${Math.round(n.x)},${Math.round(n.y)} ${Math.max(1, Math.round(n.w))}×${Math.max(1, Math.round(n.h))} in ${tick(n.selector || 'body')}`;
  else on = `${tick(n.selector || 'body')} ${quote(oneLine(n.text).slice(0, 60))}`;
  return `- ${page} · ${on} — ${noteText(n.note)} <!-- id:${n.id} -->`;
}

export function store(file) {
  const read = () => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
  return {
    file,
    list: () => read().split('\n').map(parseLine).filter(Boolean),
    add(n) {
      const id = Math.random().toString(36).slice(2, 6);
      const line = formatLine({ ...n, id });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const now = read();
      // Append only: lines an agent edited or removed stay as they are.
      const prefix = now === '' ? HEADER + '\n\n' : now.endsWith('\n') ? '' : '\n';
      fs.appendFileSync(file, prefix + line + '\n');
      return { ...parseLine(line) };
    },
    remove(id) {
      const now = read();
      const lines = now.split('\n');
      const kept = lines.filter((l) => parseLine(l)?.id !== id);
      if (kept.length !== lines.length) fs.writeFileSync(file, kept.join('\n'));
    },
    // Only the note's text changes: the rest of its line and every other line stay as they are.
    edit(id, note) {
      const lines = read().split('\n');
      const i = lines.findIndex((l) => parseLine(l)?.id === id);
      if (i < 0) return null;
      const [start, end] = LINE.exec(lines[i]).indices[11];
      lines[i] = lines[i].slice(0, start) + noteText(note) + lines[i].slice(end);
      fs.writeFileSync(file, lines.join('\n'));
      return parseLine(lines[i]);
    },
  };
}

// ---- The command ----------------------------------------------------------------------------

function projectFolder(port) {
  try {
    const pid = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0];
    const out = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    const dir = out.split('\n').find((l) => l.startsWith('n'))?.slice(1);
    if (dir && dir !== '/' && fs.existsSync(dir)) return dir;
  } catch {}
  return process.cwd();
}

const reachable = (port) => new Promise((done) => {
  const s = net.connect({ host: 'localhost', port });
  s.once('connect', () => { s.destroy(); done(true); });
  s.once('error', () => done(false));
});

const listen = (server, port, host) => new Promise((done, fail) => {
  const onError = (e) => { server.off('listening', onOk); e.code === 'EADDRINUSE' ? done(false) : fail(e); };
  const onOk = () => { server.off('error', onError); done(true); };
  server.once('error', onError).once('listening', onOk).listen(port, host);
});

// This machine's Tailscale addresses: IPv4 in 100.64.0.0/10, IPv6 in fd7a:115c:a1e0::/48.
export function tailnetAddresses(interfaces = os.networkInterfaces()) {
  const all = Object.values(interfaces).flat().filter(Boolean);
  const v4 = all.filter((a) => {
    const [p, q] = a.address.split('.').map(Number);
    return (a.family === 'IPv4' || a.family === 4) && p === 100 && q >= 64 && q < 128;
  });
  const v6 = all.filter((a) => (a.family === 'IPv6' || a.family === 6) && /^fd7a:115c:a1e0:/i.test(a.address));
  return { v4: [...new Set(v4.map((a) => a.address))], v6: [...new Set(v6.map((a) => a.address))] };
}

// The machine's MagicDNS name: a reverse lookup at Tailscale's own resolver, else the CLI (which
// can fail on macOS, depending on the terminal it starts from), else none.
async function magicDNSName(ip) {
  const clean = (name) => (/^[\w.-]+$/.test(name || '') ? name.replace(/\.$/, '').toLowerCase() : null);
  try {
    const resolver = new dns.promises.Resolver({ timeout: 1000, tries: 1 });
    resolver.setServers(['100.100.100.100']);
    const name = clean((await resolver.reverse(ip))[0]);
    if (name) return name;
  } catch {}
  try {
    const status = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }));
    return clean(status.Self?.DNSName);
  } catch {}
  return null;
}

// Only this machine's names (and its MagicDNS name, see start) are served, not a name some
// site's DNS points at 127.0.0.1.
const LOCAL_HOST = /^(localhost|[\w-]+\.localhost|[\d.]+|\[[0-9a-f:.]+\]|[\w-]+)(:\d+)?$/i;
const hostOf = (url) => { try { return new URL(url).host; } catch { return null; } };
// A request the page itself sends; another site's carries its own Origin.
const sameOrigin = (req) => !req.headers.origin || hostOf(req.headers.origin) === req.headers.host;

// Origin and Referer become the dev server's only when they are the proxy's own, so the dev
// server still refuses other sites.
function rewriteHeader(name, value, req, target) {
  const lower = name.toLowerCase();
  if (lower === 'host') return `localhost:${target}`;
  if ((lower === 'origin' || lower === 'referer') && hostOf(value) === req.headers.host) {
    return value.replace(/^https?:\/\/[^/]+/, `http://localhost:${target}`);
  }
  return value;
}

function rewriteRequestHeaders(req, target) {
  const h = {};
  for (const [name, value] of Object.entries(req.headers)) h[name] = rewriteHeader(name, value, req, target);
  return h;
}

function rewriteLocation(loc, target) {
  return loc.replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${target}(?=/|$)`), '') || '/';
}

function inject(html) {
  const at = html.toString('latin1').search(/<\/body>(?![\s\S]*<\/body>)/i);
  return at < 0 ? Buffer.concat([html, SCRIPT_TAG]) : Buffer.concat([html.subarray(0, at), SCRIPT_TAG, html.subarray(at)]);
}

function decode(body, encoding) {
  switch ((encoding || '').trim().toLowerCase()) {
    case '': case 'identity': return body;
    case 'gzip': case 'x-gzip': return zlib.gunzipSync(body);
    case 'deflate': return zlib.inflateSync(body);
    case 'br': return zlib.brotliDecompressSync(body);
    case 'zstd': return zlib.zstdDecompressSync(body);
    default: return null;
  }
}

export async function start({ target, listenFrom = target + 1000, folder = projectFolder(target), quiet = false, tailnet = false, interfaces }) {
  // With --tailnet, the proxy also listens on this machine's Tailscale addresses, and nowhere else.
  const ts = tailnet ? tailnetAddresses(interfaces) : { v4: [], v6: [] };
  if (tailnet && !ts.v4.length) throw new Error('--tailnet: this machine has no Tailscale address. Is Tailscale connected?');
  const tsName = tailnet ? await magicDNSName(ts.v4[0]) : null;
  const names = new Set(tsName ? [tsName] : []);
  const knownHost = (host = '') => LOCAL_HOST.test(host) || names.has(host.replace(/:\d+$/, '').toLowerCase());

  const notes = store(path.join(folder, '.hostnote.md'));
  const overlay = path.join(here, 'overlay.js');
  const clients = new Set();
  const changed = () => { for (const c of clients) c.write('data: change\n\n'); };
  fs.watchFile(notes.file, { interval: 250 }, changed);

  async function own(req, res) {
    const url = new URL(req.url, 'http://x');
    const json = (code, v) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(v)); };
    if (url.pathname === '/__hostnote/overlay.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(overlay));
    }
    if (url.pathname === '/__hostnote/notes' && req.method === 'GET') return json(200, notes.list());
    if (url.pathname === '/__hostnote/notes' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let n;
      try { n = JSON.parse(body); } catch { return json(400, { error: 'bad json' }); }
      if (!oneLine(n.note)) return json(400, { error: 'empty note' });
      return json(200, notes.add(n));
    }
    const del = /^\/__hostnote\/notes\/([a-z0-9]+)$/.exec(url.pathname);
    if (del && req.method === 'DELETE') { notes.remove(del[1]); return json(200, { ok: true }); }
    if (del && req.method === 'PATCH') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let n;
      try { n = JSON.parse(body); } catch { return json(400, { error: 'bad json' }); }
      if (!noteText(n.note)) return json(400, { error: 'empty note' });
      const edited = notes.edit(del[1], n.note);
      return edited ? json(200, edited) : json(404, { error: 'gone' });
    }
    if (url.pathname === '/__hostnote/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': hi\n\n');
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      clients.add(res);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    json(404, { error: 'not found' });
  }

  const handle = (req, res) => {
    if (!knownHost(req.headers.host)) { res.writeHead(403); return res.end('hostnote: unknown host'); }
    if (req.url.startsWith('/__hostnote/')) {
      // Another site in the same browser must not write notes an agent will act on.
      if (!sameOrigin(req)) { res.writeHead(403); return res.end('hostnote: another site'); }
      return own(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); });
    }
    const headers = rewriteRequestHeaders(req, target);
    headers['accept-encoding'] = 'identity';
    const up = http.request({ host: 'localhost', port: target, method: req.method, path: req.url, headers }, (upRes) => {
      const h = { ...upRes.headers };
      if (h.location) h.location = rewriteLocation(h.location, target);
      const isHtml = /text\/html/i.test(h['content-type'] || '') && req.method !== 'HEAD' && ![204, 304].includes(upRes.statusCode);
      if (!isHtml) { res.writeHead(upRes.statusCode, upRes.statusMessage, h); return upRes.pipe(res); }
      const parts = [];
      upRes.on('data', (c) => parts.push(c));
      upRes.on('end', () => {
        let body = Buffer.concat(parts);
        const decoded = decode(body, h['content-encoding']);
        if (decoded) {
          body = inject(decoded);
          delete h['content-encoding'];
          delete h['content-security-policy'];
          delete h['content-security-policy-report-only'];
        }
        delete h['transfer-encoding'];
        h['content-length'] = body.length;
        res.writeHead(upRes.statusCode, upRes.statusMessage, h);
        res.end(body);
      });
      upRes.on('error', () => res.destroy());
    });
    up.on('error', (e) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502);
      res.end(`hostnote: nothing answers on localhost:${target} (${e.code || e.message})`);
    });
    req.pipe(up);
  };

  // WebSockets (hot reload): raw sockets both ways, headers rewritten like a request's.
  const upgrade = (req, socket, head) => {
    if (!knownHost(req.headers.host)) return socket.destroy();
    const up = net.connect({ host: 'localhost', port: target }, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      const raw = req.rawHeaders;
      for (let i = 0; i < raw.length; i += 2) lines.push(`${raw[i]}: ${rewriteHeader(raw[i], raw[i + 1], req, target)}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket).pipe(up);
    });
    const end = () => { up.destroy(); socket.destroy(); };
    up.on('error', end); socket.on('error', end);
    up.on('close', end); socket.on('close', end);
  };

  // One server per address, all on the same port: the first port free on every address.
  let servers, port = listenFrom;
  for (;; port++) {
    servers = [];
    let busy = false;
    for (const [host, optional] of [['127.0.0.1'], ...ts.v4.map((a) => [a]), ...ts.v6.map((a) => [a, true])]) {
      const server = http.createServer(handle).on('upgrade', upgrade);
      let ok;
      try { ok = await listen(server, port, host); } catch (e) { if (optional) continue; for (const s of servers) s.close(); throw e; }
      if (!ok) { busy = true; break; }
      servers.push(server);
    }
    if (!busy) break;
    for (const s of servers) s.close();
  }
  const tailnetUrl = tailnet ? `http://${tsName || ts.v4[0]}:${port}` : null;
  if (!quiet) {
    console.log(`hostnote: localhost:${target} with notes at http://localhost:${port}`);
    if (tailnetUrl) console.log(`tailnet: ${tailnetUrl}`);
    console.log(`notes: ${notes.file}`);
  }
  const close = () => {
    fs.unwatchFile(notes.file, changed);
    for (const c of clients) c.end();
    for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  };
  return { servers, port, tailnetUrl, file: notes.file, close };
}

async function main() {
  const args = process.argv.slice(2);
  const tailnet = args.includes('--tailnet');
  const rest = args.filter((a) => a !== '--tailnet');
  const target = Number(rest[0]);
  if (rest.length !== 1 || !Number.isInteger(target) || target < 1 || target > 65535) {
    console.error('usage: hostnote <port> [--tailnet]');
    process.exit(2);
  }
  if (!(await reachable(target))) {
    console.error(`hostnote: nothing listens on localhost:${target}. Start the dev server first.`);
    process.exit(1);
  }
  try { await start({ target, tailnet }); } catch (e) {
    console.error(`hostnote: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
