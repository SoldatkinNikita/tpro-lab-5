import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep the original StarUML SVGs as sources; generated vector assets stay in build.
const root = fileURLToPath(new URL('../', import.meta.url));
const sources = path.join(root, 'figures', 'analysis');
const output = path.join(root, 'build', 'staruml');
const ids = ['05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '19', '20'];
const filenames = await readdir(sources);
const diagrams = await Promise.all(ids.map(async (id) => {
  const matches = filenames.filter((name) => name.startsWith(`${id}. `) && name.endsWith('.svg'));
  if (matches.length !== 1) throw new Error(`Expected one StarUML SVG for diagram ${id}.`);
  const svg = await readFile(path.join(sources, matches[0]), 'utf8');
  const tag = svg.match(/<svg\b[^>]*>/)?.[0];
  const width = Number(tag?.match(/\bwidth="([\d.]+)"/)?.[1]);
  const height = Number(tag?.match(/\bheight="([\d.]+)"/)?.[1]);
  if (!(width > 0 && height > 0)) throw new Error(`Invalid SVG size: ${matches[0]}`);
  return { id, svg, width, height };
}));

const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
let executable;
for (const candidate of candidates) {
  try { await access(candidate); executable = candidate; break; } catch {}
}
if (!executable) throw new Error('Chrome/Chromium is required to render StarUML SVGs. Set CHROME_PATH.');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'trpo-staruml-'));
const browser = spawn(executable, [
  '--headless=new', '--disable-gpu', '--disable-extensions',
  '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Browser startup timed out: ${stderr.slice(-1000)}`)), 30000);
    browser.once('error', (error) => { clearTimeout(timer); reject(error); });
    browser.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Browser exited: ${code}`)); });
    browser.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const address = new URL(endpoint);
  const target = await fetch(`http://${address.host}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  const { frameTree } = await send('Page.getFrameTree');
  for (const { id, svg, width, height } of diagrams) {
    const html = `<!doctype html><meta charset="utf-8"><style>@page{size:${width}px ${height}px;margin:0}html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden}svg{display:block}</style>${svg}`;
    await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
    const fontCheck = await send('Runtime.evaluate', {
      expression: 'document.fonts.ready.then(() => ({times:document.fonts.check("13px \\\"Times New Roman\\\""),arial:document.fonts.check("13px Arial")}))',
      awaitPromise: true, returnByValue: true,
    });
    if (fontCheck.exceptionDetails) throw new Error(`Font check failed for diagram ${id}.`);
    const pdf = await send('Page.printToPDF', {
      printBackground: true, displayHeaderFooter: false, preferCSSPageSize: true,
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
      paperWidth: width / 96, paperHeight: height / 96,
    });
    await writeFile(path.join(output, `${id}.pdf`), Buffer.from(pdf.data, 'base64'));
    console.log(`StarUML ${id}: ${width} x ${height}`);
  }
} finally {
  socket?.close();
  browser.kill();
  await new Promise((resolve) => {
    if (browser.exitCode !== null) resolve();
    else { browser.once('exit', resolve); setTimeout(resolve, 5000).unref(); }
  });
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
