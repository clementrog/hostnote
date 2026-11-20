// node check.mjs: the proxy, the notes file and the notes layer, against a tiny server it starts.
// Chrome runs headless; the screenshots land in $TMPDIR/hostnote-check/ to look at.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { start, formatLine, parseLine, tailnetAddresses } from './hostnote.mjs';

const out = path.join(os.tmpdir(), 'hostnote-check');
fs.rmSync(out, { recursive: true, force: true });
const project = path.join(out, 'project');
fs.mkdirSync(project, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>t</title><style>
body { font: 16px system-ui; margin: 40px; } .hero { padding: 20px; border: 1px solid #ccc; }
main { position: relative; height: 900px; background: #f4f4f4; padding: 20px; }
@media (prefers-color-scheme: dark) { body { background: #111; color: #ddd; } main { background: #1a1a1a; } .hero { border-color: #333; } a { color: #8ab4f8; } }
</style></head><body><section class="hero"><h1>Fernway, a Markdown editor — café</h1>
<p>Some <a href="/elsewhere">link</a> text here.</p></section>
<main><div>Pricing for teams</div><div>Second block</div></main></body></html>`;

// ---- The dev server stand-in, on ::1 only, as some dev servers bind -----------------------
const seen = {};
const upstream = http.createServer((req, res) => {
  seen.host = req.headers.host; seen.origin = req.headers.origin; seen.encoding = req.headers['accept-encoding'];
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "script-src 'none'" }); return res.end(PAGE); }
  if (req.url === '/gz') { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(PAGE)); }
  if (req.url === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync('console.log(1)')); }
  if (req.url === '/redirect') { res.writeHead(302, { location: `http://localhost:${upPort}/target?a=1` }); return res.end(); }
  if (req.url === '/host') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(req.headers)); }
  res.writeHead(404); res.end();
});
upstream.on('upgrade', (req, socket) => {
  seen.wsHost = req.headers.host;
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('data', (b) => { // one small masked text frame in, the same text out
    const len = b[1] & 127, mask = b.subarray(2, 6), data = Buffer.from(b.subarray(6, 6 + len).map((x, i) => x ^ mask[i % 4]));
    socket.write(Buffer.concat([Buffer.from([0x81, len]), data]));
  });
});
await new Promise((r) => upstream.listen(0, '::1', r));
const upPort = upstream.address().port;
const proxy = await start({ target: upPort, listenFrom: 40000 + Math.floor(Math.random() * 20000), folder: project, quiet: true });
const base = `http://127.0.0.1:${proxy.port}`;
const file = proxy.file;
const lines = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('- ')) : []);
const tag = '<script src="/__hostnote/overlay.js"></script>';

// ---- The proxy -----------------------------------------------------------------------------
await check('HTML gets the script before </body>, the rest byte-identical, CSP dropped', async () => {
  const res = await fetch(base + '/');
  const body = Buffer.from(await res.arrayBuffer());
  const want = Buffer.from(PAGE.replace('</body>', tag + '</body>'));
  assert.ok(body.equals(want), 'body differs');
  assert.equal(res.headers.get('content-security-policy'), null);
  assert.equal(seen.encoding, 'identity');
});
await check('gzip HTML from upstream is unpacked and injected', async () => {
  const res = await fetch(base + '/gz');
  assert.equal(res.headers.get('content-encoding'), null);
  assert.equal(await res.text(), PAGE.replace('</body>', tag + '</body>'));
});
await check('gzip non-HTML passes through as it is', async () => {
  const res = await fetch(base + '/app.js');
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  assert.equal(await res.text(), 'console.log(1)');
});
// A request with any Host and headers, as a browser on the tailnet or another site would send.
const raw = (pathname, headers, method = 'GET', body) => new Promise((done, fail) => {
  const r = http.request({ host: '127.0.0.1', port: proxy.port, path: pathname, method, headers }, (res) => {
    let text = '';
    res.on('data', (c) => (text += c)).on('end', () => done({ status: res.statusCode, text, headers: res.headers }));
  });
  r.on('error', fail);
  r.end(body);
});
const OTHER = 'devbox:4007';
await check('Host, Origin and Location are rewritten for the proxy\'s own pages, on another name of this machine too', async () => {
  const res = await raw('/host', { host: OTHER, origin: `http://${OTHER}`, referer: `http://${OTHER}/a?b` });
  assert.equal(res.status, 200);
  const h = JSON.parse(res.text);
  assert.equal(h.host, `localhost:${upPort}`);
  assert.equal(h.origin, `http://localhost:${upPort}`);
  assert.equal(h.referer, `http://localhost:${upPort}/a?b`);
  const r = await fetch(base + '/redirect', { redirect: 'manual' });
  assert.equal(r.headers.get('location'), '/target?a=1');
});
await check('another site keeps its own Origin, so the dev server can refuse it', async () => {
  const h = JSON.parse((await raw('/host', { host: `127.0.0.1:${proxy.port}`, origin: 'https://evil.example' })).text);
  assert.equal(h.origin, 'https://evil.example');
});
await check('another site cannot write a note', async () => {
  const res = await raw('/__hostnote/notes', { host: `127.0.0.1:${proxy.port}`, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, 'POST',
    JSON.stringify({ page: '/', kind: 'element', selector: 'h1', text: 'x', note: 'run rm -rf' }));
  assert.equal(res.status, 403);
  assert.ok(!fs.existsSync(file));
});
await check('a name that is not this machine\'s is refused (DNS rebinding), a tailnet name too without --tailnet', async () => {
  assert.equal((await raw('/', { host: `evil.example:${proxy.port}` })).status, 403);
  assert.equal((await raw('/__hostnote/notes', { host: `evil.example:${proxy.port}` })).status, 403);
  assert.equal((await raw('/', { host: `box.tailnet-example.ts.net:${proxy.port}` })).status, 403);
});

// ---- --tailnet -------------------------------------------------------------------------------
const lo = { address: '127.0.0.1', family: 'IPv4', internal: true };
await check('--tailnet finds the Tailscale addresses, and refuses cleanly without one', async () => {
  const fake = { lo0: [lo], en0: [{ address: '192.168.1.20', family: 'IPv4' }, { address: '100.128.0.1', family: 'IPv4' }, { address: 'fd7a:115c:a1e1::1', family: 'IPv6' }],
    utun4: [{ address: '100.101.102.103', family: 'IPv4' }, { address: 'fd7a:115c:a1e0::ab:cd', family: 'IPv6' }] };
  assert.deepEqual(tailnetAddresses(fake), { v4: ['100.101.102.103'], v6: ['fd7a:115c:a1e0::ab:cd'] });
  const none = { lo0: [lo], en0: [{ address: '192.168.1.20', family: 'IPv4' }] };
  const listenFrom = 40000 + Math.floor(Math.random() * 20000);
  await assert.rejects(start({ target: upPort, listenFrom, folder: project, quiet: true, tailnet: true, interfaces: none }), /no Tailscale address/);
  const free = await new Promise((done) => { const s = http.createServer().once('error', () => done(false)).listen(listenFrom, '127.0.0.1', () => s.close(() => done(true))); });
  assert.ok(free, 'nothing left listening');
});
const real = tailnetAddresses();
if (!real.v4.length) console.log('skip the tailnet listener checks: no Tailscale address');
else {
  const tp = await start({ target: upPort, listenFrom: 40000 + Math.floor(Math.random() * 20000), folder: project, quiet: true, tailnet: true });
  const name = new URL(tp.tailnetUrl).hostname;
  const at = (ip, host) => new Promise((done, fail) => {
    http.get({ host: ip, port: tp.port, path: '/', headers: { host } }, (res) => {
      let text = ''; res.on('data', (c) => (text += c)).on('end', () => done({ status: res.statusCode, text }));
    }).on('error', fail);
  });
  await check('--tailnet listens on 127.0.0.1 and the Tailscale addresses only, on one port', async () => {
    const bound = tp.servers.map((s) => s.address().address).sort();
    assert.deepEqual(bound, ['127.0.0.1', ...real.v4, ...real.v6].sort());
    assert.ok(tp.servers.every((s) => s.address().port === tp.port));
  });
  await check('--tailnet: the MagicDNS name and the Tailscale IP are served, with the script; other names are refused', async () => {
    assert.ok(/[a-z]/.test(name), `a MagicDNS name was found (${tp.tailnetUrl})`);
    for (const host of [`${name}:${tp.port}`, `${real.v4[0]}:${tp.port}`]) {
      const res = await at(real.v4[0], host);
      assert.equal(res.status, 200, host);
      assert.ok(res.text.includes(tag), host);
    }
    assert.equal((await at(real.v4[0], `evil.example:${tp.port}`)).status, 403);
    assert.equal((await at(real.v4[0], `other.${name.split('.').slice(1).join('.')}:${tp.port}`)).status, 403);
  });
  tp.close();
}
await check('a WebSocket echo passes through', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/hmr`);
  const got = await new Promise((done, fail) => {
    ws.onopen = () => ws.send('hello');
    ws.onmessage = (m) => done(m.data);
    ws.onerror = () => fail(new Error('ws error'));
    setTimeout(() => fail(new Error('no echo')), 2000);
  });
  ws.close();
  assert.equal(got, 'hello');
  assert.equal(seen.wsHost, `localhost:${upPort}`);
});
await check('hostnote refuses a port with nothing on it', async () => {
  let code = 0, err = '';
  try { execFileSync(process.execPath, ['hostnote.mjs', '1'], { stdio: 'pipe' }); } catch (e) { code = e.status; err = String(e.stderr); }
  assert.equal(code, 1);
  assert.match(err, /nothing listens on localhost:1/);
});

// ---- The notes file ------------------------------------------------------------------------
await check('a line round-trips, whatever is typed', async () => {
  const cases = [
    { id: 'a1', page: '/p', kind: 'text', selector: 'section > h1', text: 'a "quoted" \\ back — dash `tick`', note: 'say "hi" `x` --> end\nnext <!-- no' },
    { id: 'b2', page: '/', kind: 'element', selector: 'main > div:nth-of-type(2)', text: 'Pricing — for "teams"', note: 'too much space — really' },
    { id: 'c3', page: '/', kind: 'box', selector: 'main', x: 40, y: -12, w: 480, h: 200, note: 'heavy' },
  ];
  for (const n of cases) {
    const line = formatLine(n);
    assert.ok(!line.includes('\n'), 'one line');
    const back = parseLine(line);
    assert.ok(back, 'parses: ' + line);
    for (const k of ['id', 'page', 'kind', 'selector', 'x', 'y', 'w', 'h']) assert.equal(back[k], n[k], k);
    if (n.kind !== 'box') assert.equal(back.text, n.text);
  }
  assert.equal(parseLine(formatLine(cases[0])).note, 'say "hi" `x` -- > end next < !-- no');
  assert.equal(parseLine(formatLine(cases[0])).text, cases[0].text);
});
await check('adding a note writes its line, with the header', async () => {
  const res = await fetch(base + '/__hostnote/notes', { method: 'POST', body: JSON.stringify({ page: '/', kind: 'element', selector: 'h1', text: 'Fernway', note: 'first' }) });
  const n = await res.json();
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^<!-- .+ -->\n\n- \/ · `h1` "Fernway" — first <!-- id:[a-z0-9]+ -->\n$/);
  assert.equal(n.note, 'first');
});
await check('a line edited by hand, and a line that does not parse, survive the next add and delete', async () => {
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('— first', '— first, edited by hand') + 'a stray line\n');
  const n = await (await fetch(base + '/__hostnote/notes', { method: 'POST', body: JSON.stringify({ page: '/', kind: 'box', selector: 'main', x: 1, y: 2, w: 30, h: 40, note: 'second' }) })).json();
  assert.ok(fs.readFileSync(file, 'utf8').includes('first, edited by hand'));
  await fetch(base + '/__hostnote/notes/' + n.id, { method: 'DELETE' });
  const now = fs.readFileSync(file, 'utf8');
  assert.ok(now.includes('first, edited by hand') && now.includes('a stray line\n') && !now.includes('second'));
});
await check('deleting a line on disk fires the event stream', async () => {
  const ctrl = new AbortController();
  const res = await fetch(base + '/__hostnote/events', { signal: ctrl.signal });
  const reader = res.body.getReader();
  await reader.read(); // the hello
  await sleep(300);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.includes('edited by hand')).join('\n'));
  const got = await Promise.race([reader.read().then((r) => new TextDecoder().decode(r.value)), sleep(1500).then(() => '')]);
  ctrl.abort();
  assert.match(got, /data: change/);
});
await check('the file deleted and made again still fires the event stream', async () => {
  const ctrl = new AbortController();
  const res = await fetch(base + '/__hostnote/events', { signal: ctrl.signal });
  const reader = res.body.getReader();
  await reader.read();
  fs.rmSync(file);
  let got = await Promise.race([reader.read().then((r) => new TextDecoder().decode(r.value)), sleep(1500).then(() => '')]);
  assert.match(got, /data: change/, 'on delete');
  fs.writeFileSync(file, '- / · `h1` "x" — again <!-- id:zz11 -->\n');
  got = await Promise.race([reader.read().then((r) => new TextDecoder().decode(r.value)), sleep(1500).then(() => '')]);
  ctrl.abort();
  assert.match(got, /data: change/, 'on create');
});

await check('editing a note changes only its text; empty is refused, a gone line is not made again', async () => {
  const before = ['<!-- h -->', '', '- / · `h1` "a — b" — one — two <!-- id:aa11 -->', 'a stray line', '- /p · box 1,2 3×4 in `main` — keep <!-- id:bb22 -->  ', ''].join('\n');
  fs.writeFileSync(file, before);
  const patch = (id, note) => fetch(base + '/__hostnote/notes/' + id, { method: 'PATCH', body: JSON.stringify({ note }) });
  let res = await patch('bb22', 'new\ntext "q" --> x');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).note, 'new text "q" -- > x');
  assert.equal(fs.readFileSync(file, 'utf8'), before.replace('— keep <!--', '— new text "q" -- > x <!--'));
  res = await patch('aa11', '  \n ');
  assert.equal(res.status, 400);
  res = await patch('zz99', 'nothing');
  assert.equal(res.status, 404);
  assert.equal(fs.readFileSync(file, 'utf8'), before.replace('— keep <!--', '— new text "q" -- > x <!--'));
});

// ---- The notes layer in headless Chrome ----------------------------------------------------
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(CHROME)) { console.log('skip the browser checks: no Chrome'); }
else {
  fs.writeFileSync(file, [
    '<!-- seeded -->', '',
    '- / · text "Markdown editor" in `h1` — shorter title <!-- id:t1t1 -->',
    '- / · `main > div:nth-of-type(1)` "Pricing for teams" — too much space here <!-- id:e1e1 -->',
    '- / · box 300,60 360×140 in `main` — this whole block feels heavy <!-- id:b1b1 -->',
    '- / · `#gone` "Old" — lost one <!-- id:g1g1 -->',
    '- /other · `h1` "Fernway, a Markdown editor — café" — another page <!-- id:o1o1 -->', '',
  ].join('\n'));
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(out, 'chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=1000,700', 'about:blank'], { stdio: 'ignore' });
  try {
    let version;
    for (let i = 0; i < 50 && !version; i++) { await sleep(200); version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((r) => r.json()).catch(() => null); }
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let seq = 0;
    const waiting = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) waiting.get(d.id)?.(d); };
    const send = (method, params = {}) => new Promise((done, fail) => {
      const id = ++seq;
      waiting.set(id, (d) => (d.error ? fail(new Error(method + ': ' + d.error.message)) : done(d.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
    const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
    const layer = (expr) => js(`(() => { const r = document.querySelector('hostnote-layer').shadowRoot; return ${expr}; })()`);
    const ALT = 1, META = 4;
    const key = async (code, k, modifiers = 0) => {
      const vk = code.startsWith('Key') ? code.charCodeAt(3) : { Enter: 13, Escape: 27 }[code];
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: k, windowsVirtualKeyCode: vk, modifiers });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: k, windowsVirtualKeyCode: vk, modifiers });
    };
    const mouse = (type, x, y, modifiers = 0) => send('Input.dispatchMouseEvent', { type, x, y, modifiers, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    const shot = async (name) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name), Buffer.from(data, 'base64')); };
    const type = async (text) => { await send('Input.insertText', { text }); await key('Enter', 'Enter'); await sleep(300); };
    // A key that types its character, as a real key press does.
    const typeKey = async (code, k) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: k, text: k, windowsVirtualKeyCode: code.charCodeAt(3) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: k, windowsVirtualKeyCode: code.charCodeAt(3) });
    };
    const click = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(100); };
    const centre = (expr) => layer(`(() => { const b = (${expr}).getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
    const cardBg = () => layer(`getComputedStyle(r.querySelector('.card')).backgroundColor`);

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 2, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await send('Page.navigate', { url: base + '/' });
    await sleep(800);

    await check('the page shows its notes: 3 marks, 1 rectangle, "1 note not placed"', async () => {
      assert.equal(await layer(`[...r.querySelectorAll('.mark')].filter(m => m.style.display !== 'none').length`), 3);
      assert.equal(await layer(`r.querySelectorAll('.box').length`), 1);
      assert.equal(await layer(`r.querySelector('.pill')?.textContent`), '1 note not placed');
    });
    await check('with every card closed: the text note is underlined, the element note faintly outlined', async () => {
      assert.equal(await layer(`r.querySelector('.card')`), null);
      const [lines, outline] = await layer(`[
        [...r.querySelectorAll('.line')].filter(l => l.style.display !== 'none').map(l => { const b = l.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; }),
        (() => { const o = r.querySelector('.outline'); return [o.style.display, getComputedStyle(o).opacity, getComputedStyle(o).pointerEvents]; })(),
      ]`);
      const want = await js(`(() => { const t = document.querySelector('h1').firstChild; const i = t.data.indexOf('Markdown editor'); const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 15); const b = r.getClientRects()[0]; return [b.left, b.bottom, b.width]; })()`);
      assert.equal(lines.length, 1, JSON.stringify(lines));
      assert.ok(Math.abs(lines[0][0] - want[0]) < 1 && Math.abs(lines[0][1] + 1 - want[1]) < 1 && Math.abs(lines[0][2] - want[2]) < 1 && lines[0][3] === 2, JSON.stringify([lines, want]));
      assert.deepEqual(outline, ['', '0.5', 'none']);
      await shot('closed.png');
      // Hidden and shown again, as an accordion does: the outline comes back with its mark.
      await js(`document.querySelector('main > div').style.display = 'none'`);
      await sleep(150);
      assert.equal(await layer(`r.querySelector('.outline').style.display`), 'none');
      await js(`document.querySelector('main > div').style.display = ''`);
      await sleep(150);
      assert.equal(await layer(`r.querySelector('.outline').style.display`), '');
    });
    await check('N opens the first note\'s card, pinned, dark on the light page; again goes to the next', async () => {
      await key('KeyN', 'n');
      await sleep(100);
      assert.equal(await layer(`r.querySelector('.card .text')?.textContent`), 'shorter title');
      assert.equal(await cardBg(), 'rgb(30, 30, 30)');
      assert.equal(await layer(`r.querySelector('.line').className`), 'line lit');
      await shot('light.png');
      await key('KeyN', 'n');
      await sleep(100);
      assert.equal(await layer(`r.querySelector('.card .text')?.textContent`), 'too much space here');
      await shot('light-element.png');
    });
    await check('⇧N goes back, and round from the first to the last', async () => {
      await key('KeyN', 'N', 8);
      await key('KeyN', 'N', 8);
      await sleep(100);
      assert.equal(await layer(`r.querySelector('.card .text')?.textContent`), 'this whole block feels heavy');
    });
    await check('the page turning dark turns the card light and back, with no DOM change', async () => {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await sleep(400);
      await shot('dark.png');
      assert.equal(await cardBg(), 'rgb(255, 255, 255)');
      assert.equal(await layer(`getComputedStyle(r.querySelector('.card')).color`), 'rgb(29, 29, 31)');
      assert.ok(await layer(`r.querySelector('.mark').classList.contains('on-dark')`), 'dark-page amber');
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
      await sleep(400);
      assert.equal(await cardBg(), 'rgb(30, 30, 30)');
    });
    await check('a dark background set on the page (oklch, as Tailwind writes it) turns the card light', async () => {
      await js(`document.querySelector('main').style.background = 'oklch(0.2 0 0)'`);
      await sleep(150);
      assert.equal(await cardBg(), 'rgb(255, 255, 255)');
      await js(`document.querySelector('main').style.background = ''`);
      await sleep(150);
      assert.equal(await cardBg(), 'rgb(30, 30, 30)');
    });
    await check('another key closes the pinned card', async () => {
      await key('Escape', 'Escape');
      assert.equal(await layer(`r.querySelector('.card')`), null);
    });
    await check('click a mark, click its text, type, Return: only that line\'s text changes; C and N type', async () => {
      const before = fs.readFileSync(file, 'utf8');
      await click(...await centre(`r.querySelector('.mark[data-id="t1t1"]')`));
      assert.equal(await layer(`r.querySelector('.card .text')?.textContent`), 'shorter title');
      await click(...await centre(`r.querySelector('.card .text')`));
      assert.deepEqual(await layer(`(() => { const i = r.querySelector('.card .edit'); return [r.activeElement === i, i.value, i.selectionStart]; })()`), [true, 'shorter title', 13]);
      assert.equal(await layer(`getComputedStyle(r.querySelector('.card .edit')).color`), await layer(`getComputedStyle(r.querySelector('.card')).color`));
      await typeKey('KeyC', 'c');
      await typeKey('KeyN', 'n');
      assert.equal(await layer(`r.querySelector('.card .edit').value`), 'shorter titlecn');
      assert.equal(await layer(`r.querySelector('.field')`), null);
      await shot('edit.png');
      await type(' now');
      assert.equal(fs.readFileSync(file, 'utf8'), before.replace('— shorter title <!--', '— shorter titlecn now <!--'));
      assert.equal(await layer(`r.querySelector('.card .edit')`), null);
      assert.equal(await layer(`r.querySelector('.card .text').textContent`), 'shorter titlecn now');
    });
    await check('Escape, a click elsewhere, or empty text on Return change nothing', async () => {
      const before = fs.readFileSync(file, 'utf8');
      const text = () => layer(`r.querySelector('.card .text')?.textContent`);
      await click(...await centre(`r.querySelector('.card .text')`));
      await send('Input.insertText', { text: ' zzz' });
      await key('Escape', 'Escape');
      await sleep(100);
      assert.equal(await layer(`r.querySelector('.card .edit')`), null);
      assert.equal(await text(), 'shorter titlecn now');
      await click(...await centre(`r.querySelector('.card .text')`));
      await layer(`r.querySelector('.card .edit').value = ''`);
      await key('Enter', 'Enter');
      await sleep(300);
      assert.equal(await text(), 'shorter titlecn now');
      await click(...await centre(`r.querySelector('.card .text')`));
      await send('Input.insertText', { text: ' yyy' });
      await click(500, 650);
      await sleep(100);
      assert.equal(await layer(`r.querySelector('.card')`), null);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    });
    await check('select text, C, type, Return: a note on that text', async () => {
      await js(`(() => { const t = document.querySelector('p').firstChild; const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 4); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
      await key('KeyC', 'c');
      await sleep(100);
      assert.equal(await layer(`r.querySelector('.field input')?.placeholder`), 'Note for the agent');
      assert.equal(await layer(`getComputedStyle(r.querySelector('.field')).backgroundColor`), 'rgb(30, 30, 30)');
      await type('say more');
      assert.ok(lines().some((l) => /^- \/ · text "Some" in `p` — say more <!-- id:\w+ -->$/.test(l)), lines().join('\n'));
    });
    await check('C and N typed in a field of the page stay the page\'s', async () => {
      await js(`(() => { getSelection().removeAllRanges(); const i = document.createElement('input'); i.id = 'typing'; i.style.cssText = 'position:fixed;left:0;bottom:0'; document.body.append(i); i.focus({ preventScroll: true }); })()`);
      await key('KeyC', 'c');
      await key('KeyN', 'n');
      await sleep(100);
      assert.equal(await layer(`r.querySelector('.field')`), null);
      assert.equal(await layer(`r.querySelector('.card')`), null);
      await js(`document.getElementById('typing').remove()`);
    });
    await check('⌥-click on a link: no navigation, a note on the link', async () => {
      const [x, y] = await js(`(() => { const b = document.querySelector('a').getBoundingClientRect(); return [b.right - 3, b.y + 5]; })()`);
      await mouse('mousePressed', x, y, ALT);
      await mouse('mouseReleased', x, y, ALT);
      await sleep(300);
      assert.equal(await js('location.pathname'), '/');
      await type('link here');
      assert.ok(lines().some((l) => l.includes('· `a` "link" — link here')), lines().join('\n'));
    });
    await check('⌥-drag: a rectangle, kept relative to the element that holds it', async () => {
      const [x, y] = await js(`(() => { const b = document.querySelector('main').getBoundingClientRect(); return [b.x + 400, b.y + 250]; })()`);
      await mouse('mousePressed', x, y, ALT);
      await mouse('mouseMoved', x + 60, y + 30, ALT);
      await mouse('mouseMoved', x + 200, y + 90, ALT);
      await mouse('mouseReleased', x + 200, y + 90, ALT);
      await sleep(100);
      await type('drawn box');
      assert.ok(lines().some((l) => /· box 400,250 200×90 in `main` — drawn box/.test(l)), lines().join('\n'));
      assert.equal(await layer(`r.querySelectorAll('.box').length`), 2);
    });
    await check('C with nothing selected: pick mode outlines, a click opens the field, Escape adds nothing', async () => {
      await js('getSelection().removeAllRanges()');
      const before = lines().length;
      await key('KeyC', 'c');
      const [x, y] = await js(`(() => { const b = document.querySelectorAll('main div')[1].getBoundingClientRect(); return [b.x + 10, b.y + 5]; })()`);
      await mouse('mouseMoved', x, y);
      await sleep(50);
      assert.ok(await layer(`!!r.querySelector('.outline.hover')`), 'hover outline');
      await shot('pick.png');
      await mouse('mousePressed', x, y);
      await mouse('mouseReleased', x, y);
      await sleep(100);
      assert.ok(await layer(`!!r.querySelector('.field input')`), 'field');
      await key('Escape', 'Escape');
      await sleep(200);
      assert.equal(await layer(`r.querySelector('.field')`), null);
      assert.equal(lines().length, before);
    });
    await check('a line deleted on disk goes from the page within a second, no reload', async () => {
      await js('window.__stay = 1');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.includes('id:t1t1')).join('\n'));
      await sleep(900);
      assert.equal(await js('window.__stay'), 1);
      assert.equal(await layer(`[...r.querySelectorAll('.mark')].filter(m => m.style.display !== 'none').length`), 5);
    });
    await check('Delete on the card removes the line', async () => {
      await key('KeyN', 'n');
      await sleep(100);
      const text = await layer(`r.querySelector('.card .text').textContent`);
      await layer(`r.querySelector('.card .del').click()`);
      await sleep(300);
      assert.ok(!lines().some((l) => l.includes('— ' + text + ' <!--')), lines().join('\n'));
      assert.ok(lines().some((l) => l.includes('another page')), 'other page kept');
    });
    await check('an element note follows its text when siblings move, and is not placed when it has gone', async () => {
      const pill = () => layer(`r.querySelector('.pill')?.textContent || ''`);
      const markOf = () => layer(`(() => { const m = [...r.querySelectorAll('.mark')].filter(m => m.style.display !== 'none').map(m => m.getBoundingClientRect().top); return m; })()`);
      await js(`document.querySelector('main').insertAdjacentHTML('afterbegin', '<div>New first block</div>')`);
      await sleep(200);
      const pricingTop = await js(`[...document.querySelectorAll('main div')].find(d => d.textContent === 'Pricing for teams').getBoundingClientRect().top`);
      assert.ok((await markOf()).some((t) => Math.abs(t + 10 - pricingTop) < 2), 'mark on the moved block');
      assert.equal(await pill(), '1 note not placed');
      await js(`[...document.querySelectorAll('main div')].find(d => d.textContent === 'Pricing for teams').remove()`);
      await sleep(200);
      assert.equal(await pill(), '2 notes not placed');
    });
    await check('a URL change without reload draws that page\'s notes', async () => {
      await js(`history.pushState(null, '', '/other')`);
      await sleep(400);
      assert.equal(await layer(`[...r.querySelectorAll('.mark')].filter(m => m.style.display !== 'none').length`), 1);
    });
    ws.close();
  } finally {
    chrome.kill();
  }
}

proxy.close();
upstream.close();
console.log(failed ? `\n${failed} failed` : `\nall passed; screenshots in ${out}`);
process.exit(failed ? 1 : 0);
