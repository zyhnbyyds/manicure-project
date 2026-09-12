// @ts-nocheck
/**
 * 文档链接校验（离线，不依赖构建）。
 *
 * 背景：两套文档站都开着 `ignoreDeadLinks: false`，构建时死链会直接失败；
 * 但构建一次要几十秒，改文档时想快速自检不方便。这个脚本把"死链"提前到秒级：
 *
 *   1. 相对链接按文件所在目录解析，绝对链接按站点根解析（`/guide/` → `guide/index.md`）；
 *   2. 同时接受 `foo.md`、`foo/`（目录 → `foo/index.md`）、`foo`（cleanUrls 省略后缀）；
 *   3. 顺带检查「锚点链接指向的标题是否存在」（`#` 后按 GitHub 风格 slug 比对）；
 *   4. 顺带报告没有 frontmatter `title` 的页面（VitePress 侧边栏用的是手写文案，但浏览器标题会退化）。
 *
 * 用法：
 *   bun scripts/verify-docs-links.mjs            # 校验 docs/ 与 dev-docs/
 *   bun scripts/verify-docs-links.mjs docs       # 只校验一个目录
 *
 * 退出码：0 = 全部通过；1 = 存在死链（可直接接进 CI）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** 扫描时忽略的目录名（node_modules 与构建产物） */
const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'cache',
  '.vitepress',
  '.git',
]);

/**
 * @param {string} dir
 * @param {string[]} [acc]
 * @returns {string[]} 目录下所有 .md 文件的绝对路径
 */
function collectMarkdown(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      collectMarkdown(full, acc);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      acc.push(full);
    }
  }
  return acc;
}

/** 去掉代码块与行内代码，避免把示例里的 `[x](./y.md)` 当成真链接 */
function stripCode(content) {
  return content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');
}

/**
 * 提取所有 markdown 链接与裸 HTML 链接。
 * @returns {{ href: string, line: number }[]}
 */
function extractLinks(content) {
  const links = [];
  const withLines = stripCode(content).split(/\r?\n/);
  withLines.forEach((line, index) => {
    const lineNo = index + 1;
    // [text](href "title")
    for (const m of line.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g)) {
      links.push({ href: m[1], line: lineNo });
    }
    // <a href="...">  /  <img src="...">
    for (const m of line.matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
      links.push({ href: m[1], line: lineNo });
    }
  });
  return links;
}

/** GitHub / VitePress 风格的标题 slug：保留中日韩字符，去掉标点，空格转连字符 */
function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(
      /[\u2000-\u206f\u2e00-\u2e7f\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g,
      '',
    )
    .replace(/[\s\u3000]+/g, '-');
}

/** 收集某个 md 文件里所有标题的 slug（含重复标题的 -1/-2 后缀规则） */
function collectAnchors(file) {
  const seen = new Map();
  const anchors = new Set();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = slugify(m[2]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

/** 判断链接目标是否是一个真实存在的文档（含目录 index、cleanUrls 省略后缀） */
function candidateFiles(fromFile, href, siteRoot) {
  const [rawPath] = href.split('#');
  if (!rawPath) return [fromFile]; // 纯锚点：指向自己

  const decoded = decodeURIComponent(rawPath);
  const isAbsolute = decoded.startsWith('/');
  const base = isAbsolute ? siteRoot : dirname(fromFile);
  const target = resolve(base, isAbsolute ? `.${decoded}` : decoded);

  const candidates = [];
  const push = (p) => {
    if (!candidates.includes(p)) candidates.push(p);
  };

  // 目录 → index.md；无后缀 → 补 .md / index.md
  if (decoded.endsWith('/')) {
    push(join(target, 'index.md'));
  } else {
    push(target);
    push(`${target}.md`);
    push(join(target, 'index.md'));
  }
  return candidates;
}

/**
 * 校验一个文档站。
 * @returns {{ deadLinks: string[], missingAnchors: string[], missingTitle: string[], fileCount: number }}
 */
function verifySite(siteRoot) {
  const files = collectMarkdown(siteRoot);
  const anchorCache = new Map();
  const deadLinks = [];
  const missingAnchors = [];
  const missingTitle = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const rel = relative(REPO_ROOT, file).split(sep).join('/');

    if (!/^\s*---\r?\n[\s\S]*?\btitle\s*:/.test(content)) {
      missingTitle.push(rel);
    }

    for (const { href, line } of extractLinks(content)) {
      // 外链、协议链接、邮件、纯锚点跳过
      if (/^(https?:)?\/\//i.test(href) || /^(mailto|tel|data):/i.test(href))
        continue;
      if (href.startsWith('#')) continue;

      const candidates = candidateFiles(file, href, siteRoot);
      const hit = candidates.find((p) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      });

      if (!hit) {
        deadLinks.push(`${rel}:${line}  →  ${href}`);
        continue;
      }

      // 锚点存在性（只对 .md 目标做，且目标有锚点时）
      const [, anchor] = href.split('#');
      if (!anchor || !hit.toLowerCase().endsWith('.md')) continue;
      const normalized = anchor.toLowerCase();
      if (!anchorCache.has(hit)) anchorCache.set(hit, collectAnchors(hit));
      const anchors = anchorCache.get(hit);
      // VitePress 也支持显式锚点与自定义 id，命中不了就只提示不判死
      if (
        !anchors.has(normalized) &&
        !anchors.has(decodeURIComponent(normalized))
      ) {
        missingAnchors.push(`${rel}:${line}  →  ${href}`);
      }
    }
  }

  return { deadLinks, missingAnchors, missingTitle, fileCount: files.length };
}

const sites = process.argv.slice(2);
const targets = sites.length
  ? sites.map((s) => resolve(REPO_ROOT, s))
  : [join(REPO_ROOT, 'docs'), join(REPO_ROOT, 'dev-docs')];

let failed = false;
for (const site of targets) {
  const name = relative(REPO_ROOT, site).split(sep).join('/') || site;
  let result;
  try {
    result = verifySite(site);
  } catch (error) {
    console.error(`✗ ${name} 扫描失败：${error.message}`);
    failed = true;
    continue;
  }

  const { deadLinks, missingAnchors, missingTitle, fileCount } = result;
  console.log(`\n=== ${name}（${fileCount} 个 markdown 文件）===`);

  if (deadLinks.length) {
    failed = true;
    console.log(`✗ 死链 ${deadLinks.length} 处：`);
    for (const item of deadLinks) console.log(`   ${item}`);
  } else {
    console.log('✓ 死链：0');
  }

  if (missingAnchors.length) {
    console.log(
      `! 锚点未命中 ${missingAnchors.length} 处（可能只是标题改写，人工确认）：`,
    );
    for (const item of missingAnchors) console.log(`   ${item}`);
  } else {
    console.log('✓ 锚点：全部命中');
  }

  if (missingTitle.length) {
    console.log(`! 缺 frontmatter title ${missingTitle.length} 个：`);
    for (const item of missingTitle) console.log(`   ${item}`);
  } else {
    console.log('✓ frontmatter title：齐全');
  }
}

console.log(failed ? '\n结果：存在死链，需要修复。' : '\n结果：通过。');
process.exit(failed ? 1 : 0);
