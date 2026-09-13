/**
 * WXML 标签配对自检（离线、秒级、无依赖）。
 *
 * 为什么需要它：小程序侧唯一的自动化检查是 `tsc -p miniapp/tsconfig.json`，
 * 而 **WXML 不在 TS 的检查范围里** —— 写坏一个标签，本地全绿，
 * 直到开发者工具编译时才报错，而且**报错行号常常不是出错行**。
 *
 * 真实踩过的例子（2026-09）：一条 WXML 注释被写成了 CSS 的收尾符号（星号加斜杠），
 * 而 WXML 注释必须以 `--` `>` 收尾。于是注释一直没闭合，把紧跟其后的
 * `<view class="page-body">` 一起吞掉了 —— 编译器在**文件最后一行**报
 * 「get tag end without start / unexpected end tag: view」，
 * 真正的错却在 24 行之前。人眼盯着最后一行找，永远找不到。
 *
 * 用法：
 * ```bash
 * bun scripts/verify-wxml-tags.mjs                      # 默认查 miniapp/miniprogram
 * bun scripts/verify-wxml-tags.mjs some/dir another.wxml
 * ```
 * 退出码非 0 表示有问题，可直接挂进 CI / 提交前检查。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** 不需要闭合的标签（WXML 里这些是空元素） */
const VOID_TAGS = new Set([
  'image',
  'input',
  'icon',
  'progress',
  'slot',
  'import',
  'include',
  'wxs',
]);

function collect(target, out = []) {
  const stat = statSync(target);
  if (stat.isFile()) {
    if (target.endsWith('.wxml')) out.push(target);
    return out;
  }
  for (const name of readdirSync(target)) {
    if (name === 'node_modules') continue;
    collect(join(target, name), out);
  }
  return out;
}

/**
 * 注释先按「保留换行」的方式挖空 —— 这样后面的行号与原文一致。
 *
 * WXML 注释的结束符必须是 `--` + `>`（HTML 规则）；一旦误写成 CSS 的星号加斜杠，
 * 这个正则就匹配不到完整的注释，后面的标签会被当成注释内容 —— 正是要报的那种情况：
 * 这里挖不空 → 栈里少一个开标签 → 最后必然报「多余的结束标签」，并指出真实位置。
 */
function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (block) =>
    block.replace(/[^\n]/g, ' '),
  );
}

/** 按栈配对；返回第一个出错点（含行号），没问题返回 null */
function checkFile(file) {
  const text = stripComments(readFileSync(file, 'utf8'));
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const stack = [];
  let match;
  while ((match = tagRe.exec(text)) !== null) {
    const name = match[2];
    const line = text.slice(0, match.index).split('\n').length;
    if (match[4] === '/' || VOID_TAGS.has(name)) continue;
    if (match[1] !== '/') {
      stack.push({ name, line });
      continue;
    }
    const top = stack.pop();
    if (!top)
      return {
        line,
        message: `多余的结束标签 </${name}> —— 往上找：多半是某个 <!-- 注释没闭合（WXML 要用 --> 而不是 */）`,
      };
    if (top.name !== name)
      return {
        line,
        message: `结束标签 </${name}> 与第 ${top.line} 行的开始标签 <${top.name}> 不匹配`,
      };
  }
  if (stack.length) {
    const top = stack[stack.length - 1];
    return {
      line: top.line,
      message: `标签 <${top.name}> 没有闭合（栈里还剩 ${stack.length} 个）`,
    };
  }
  return null;
}

const targets = process.argv.slice(2);
const roots = targets.length ? targets : ['miniapp/miniprogram'];
const files = roots.flatMap((target) => collect(target));

let bad = 0;
for (const file of files) {
  const result = checkFile(file);
  if (!result) continue;
  bad += 1;
  console.error(
    `✗ ${relative(process.cwd(), file)}:${result.line} → ${result.message}`,
  );
}

if (bad) {
  console.error(`\nWXML 自检失败：${bad}/${files.length} 个文件有问题`);
  process.exit(1);
}
console.log(`√ WXML 自检通过（${files.length} 个文件）`);
