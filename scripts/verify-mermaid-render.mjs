// @ts-nocheck
/**
 * 用真实 Chrome（DevTools Protocol）验证 mermaid 图在浏览器里**真的渲染成 SVG**。
 *
 * 背景：`pre.mermaid` 的渲染完全发生在客户端（见 dev-docs/.vitepress/mermaid.ts 的注释），
 * 而构建产物里只有被 CSS 隐藏的源码。所以「构建通过」并不能证明图能看 —— 必须在浏览器里看。
 *
 * 用法（先 `bun run build` 出 dist，或用 `bun run dev` 起服务）：
 *   bun scripts/verify-mermaid-render.mjs                       # 校验 dist 下所有含图的页面
 *   bun scripts/verify-mermaid-render.mjs http://localhost:5180 # 校验本地服务
 *
 * 退出码：0 = 每张图都渲染成 SVG；1 = 有页面渲染失败或残留未处理。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DEV_DOCS = join(REPO_ROOT, 'dev-docs');
const DIST = join(DEV_DOCS, '.vitepress', 'dist');

const candidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const chromePath = candidates.find((p) => existsSync(p));
if (!chromePath) {
  console.error(
    '✗ 找不到 Chrome / Edge，跳过（不影响文档正确性，但请在浏览器里目视确认一次）',
  );
  process.exit(0);
}

/** 收集所有含 mermaid 的页面，换成 file:// 或站点 URL */
function collectTargets() {
  const baseUrl = process.argv[2];
  if (baseUrl) {
    return readdirSync(DIST ? join(DIST) : DEV_DOCS, { recursive: true })
      .filter((f) => typeof f === 'string' && f.endsWith('.html'))
      .map((f) => {
        const rel = f
          .split(sep)
          .join('/')
          .replace(/\.html$/, '');
        return `${baseUrl.replace(/\/$/, '')}/${rel === 'index' ? '' : rel}`;
      });
  }
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) {
        if (readFileSync(full, 'utf8').includes('class="mermaid"')) {
          out.push('file:///' + full.split(sep).join('/'));
        }
      }
    }
  };
  walk(DIST);
  return out;
}

const targets = collectTargets();
if (targets.length === 0) {
  console.error(
    '✗ 没有找到含 mermaid 的构建产物，请先 `cd dev-docs && bun run build`',
  );
  process.exit(1);
}

const port = 9333;
const profile = mkdtempSync(join(tmpdir(), 'dsh-mermaid-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

/** 等 CDP 端口就绪并拿到一个 page target 的 websocket 地址 */
async function waitForTarget(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl,
      );
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Chrome DevTools 端口未就绪');
}

/** 极简 CDP 客户端：只需要 Page.navigate + Runtime.evaluate */
function connect(wsUrl) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();

    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });
    socket.addEventListener('error', () =>
      reject(new Error('CDP socket error')),
    );
    socket.addEventListener('open', () =>
      resolvePromise({
        send(method, params = {}) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) =>
            pending.set(id, { resolve: res, reject: rej }),
          );
        },
        close: () => socket.close(),
      }),
    );
  });
}

const client = await connect(await waitForTarget());

/**
 * 打开一个页面，等 mermaid 把 pre.mermaid 全部换成 SVG。
 * 返回 { total, rendered, unprocessed, errors }
 */
async function inspect(url) {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Page.navigate', { url });

  // 轮询：等「没有未处理的 pre.mermaid」且至少有一个 svg；最多等 15 秒
  const deadline = Date.now() + 15000;
  let state = { total: 0, rendered: 0, unprocessed: 0 };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const { result } = await client.send('Runtime.evaluate', {
      expression: `(() => ({
        total: document.querySelectorAll('pre.mermaid, div.mermaid, .mermaid').length,
        rendered: document.querySelectorAll('.mermaid[data-processed], pre.mermaid[data-processed]').length,
        svg: document.querySelectorAll('.mermaid svg').length,
        unprocessed: document.querySelectorAll('pre.mermaid:not([data-processed])').length,
        err: (window.__mermaidError ? String(window.__mermaidError) : '')
      }))()`,
      returnByValue: true,
    });
    state = result.value ?? state;
    if (state.total > 0 && state.unprocessed === 0 && state.svg === state.total)
      break;
    if (state.total > 0 && state.unprocessed === 0 && state.svg >= 1) break;
  }
  return state;
}

let failed = false;
const rows = [];
for (const url of targets) {
  const short = url.startsWith('file:///')
    ? relative(REPO_ROOT, url.replace('file:///', '').split('/').join(sep))
        .split(sep)
        .join('/')
    : url;
  try {
    const state = await inspect(url);
    // total === 0 说明这个页面本来就没有图（脚本按站点全部页面遍历），不算失败
    const ok =
      state.total === 0 ||
      (state.unprocessed === 0 && state.svg === state.total);
    if (!ok) failed = true;
    rows.push({ short, ...state, ok });
  } catch (error) {
    failed = true;
    rows.push({
      short,
      total: 0,
      rendered: 0,
      svg: 0,
      unprocessed: 0,
      ok: false,
      error: error.message,
    });
  }
}

client.close();
chrome.kill();

const withDiagrams = rows.filter((r) => r.total > 0);
console.log(
  `\n用 ${chromePath.split(/[\\/]/).pop()} 校验 ${rows.length} 个页面（其中 ${withDiagrams.length} 个含图）：\n`,
);
console.log('页面'.padEnd(46) + '图数  SVG  未处理  结果');
for (const r of rows) {
  if (r.total === 0) continue; // 没有图的页面不打印，保持输出可读
  const flag = r.ok ? '✓' : '✗';
  console.log(
    r.short.padEnd(46) +
      String(r.total).padEnd(5) +
      String(r.svg).padEnd(6) +
      String(r.unprocessed).padEnd(8) +
      flag +
      (r.error ? `  ${r.error}` : ''),
  );
}
if (withDiagrams.length === 0) {
  console.log('（没有页面含 mermaid 图，跳过）');
}
console.log(
  failed
    ? '\n结果：有页面渲染失败。'
    : `\n结果：${withDiagrams.length} 个页面的图全部渲染为 SVG。`,
);
process.exit(failed ? 1 : 0);
