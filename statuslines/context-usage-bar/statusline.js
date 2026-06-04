#!/usr/bin/env node
/*
 * Claude Code 自定义状态栏小组件
 * 显示：模型 / 目录 / git 分支、Context 上下文占用进度条、套餐 Usage(5h/7d) 进度条
 *
 * Claude Code 会把会话 JSON 通过 stdin 喂给本脚本，脚本把渲染结果打印到 stdout。
 * 仅依赖 Node.js，无需 jq / npx，离线可用。
 * 字段参考：https://code.claude.com/docs/en/statusline
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

// 作为命令直接运行时：从 stdin 读会话 JSON、渲染并打印。
// 被 require（测试）时不跑此逻辑，只导出纯函数 —— 避免挂住 stdin。
function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    let d = {};
    try { d = JSON.parse(raw); } catch (_) {}
    try {
      process.stdout.write(render(d) + '\n');
    } catch (e) {
      // 任何异常都不应让状态栏报错，降级输出
      process.stdout.write('');
    }
  });
}

if (require.main === module) main();

// ---------- ANSI 颜色辅助 ----------
// 配色目标：黑色终端高对比。内容文字一律用亮色系(9x/亮白97)，
// 只有"分隔点"和"进度条空槽"用深灰(90)当背景轨道，让亮的填充段更跳。
const A = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const bold = (s) => A('1', s);
const bcyan = (s) => A('96', s);      // 模型
const bblue = (s) => A('94', s);      // 亮蓝(备用)
const bmagenta = (s) => A('95', s);   // 亮品红(备用)
const lblue = (s) => A('38;5;117', s);    // 目录：256 色浅亮蓝(比 94 更亮)
const lmagenta = (s) => A('38;5;213', s); // git 分支：256 色浅亮品红(比 95 更亮)
const bgreen = (s) => A('92', s);     // 花费 / staged / 干净
const bwhite = (s) => A('97', s);     // 主文字：标签、token 数
const muted = (s) => A('37', s);      // 次级文字：?未跟踪、↺重置倒计时
const track = (s) => A('90', s);      // 分隔点 / 进度条空槽(深灰轨道)

// ---------- 显示宽度（按终端宽度折叠时用） ----------
// 计算字符串在终端的"可见列宽"：先剥掉 ANSI 颜色转义；emoji 与 CJK 全角字符算 2 列；
// 变体选择符/零宽连接符/组合附加符号算 0 列；其余算 1 列。
// 区间表参考东亚宽字符 + emoji 主块，足够覆盖本状态栏用到的字符（🤖📁🌿🧠💰📊⏳ 与中文目录名）。
const WIDE_RANGES = [
  [0x1100, 0x115F], [0x2329, 0x232A], [0x2E80, 0x303E],
  [0x3041, 0x33FF], [0x3400, 0x4DBF], [0x4E00, 0x9FFF],
  [0xA000, 0xA4CF], [0xAC00, 0xD7A3], [0xF900, 0xFAFF],
  [0xFE10, 0xFE19], [0xFE30, 0xFE6F], [0xFF00, 0xFF60],
  [0xFFE0, 0xFFE6], [0x231A, 0x231B], [0x23E9, 0x23F3],
  [0x1F300, 0x1FAFF], [0x20000, 0x3FFFD],
];
function isWideCp(cp) {
  for (let i = 0; i < WIDE_RANGES.length; i++) {
    if (cp >= WIDE_RANGES[i][0] && cp <= WIDE_RANGES[i][1]) return true;
  }
  return false;
}
function vlen(s) {
  const clean = String(s).replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of clean) {
    const cp = ch.codePointAt(0);
    if (cp === 0xFE0F || cp === 0x200D || (cp >= 0x0300 && cp <= 0x036F)) continue; // 0 宽
    w += isWideCp(cp) ? 2 : 1;
  }
  return w;
}

// 从字符串尾部截取，使可见宽 ≤ cols（极窄时保留路径末段的尾部）。
function truncTail(s, cols) {
  const chars = Array.from(String(s));
  let w = 0, i = chars.length;
  while (i > 0) {
    const cw = vlen(chars[i - 1]);
    if (w + cw > cols) break;
    w += cw; i--;
  }
  return chars.slice(i).join('');
}

// 把路径压缩到 budget 列以内：① home 前缀→~；② 仍超则中部省略保留根标记+末段；
// ③ 末段仍超则截断末段尾部并前置 …。budget 为 Infinity 或本就够宽时原样返回。
function shortenPath(p, budget) {
  p = String(p);
  if (!isFinite(budget) || vlen(p) <= budget) return p;
  let s = p;
  const home = os.homedir();
  if (home && (s === home || s.startsWith(home + '/') || s.startsWith(home + '\\'))) {
    s = '~' + s.slice(home.length);
  }
  if (vlen(s) <= budget) return s;
  const parts = s.split(/[\/\\]/).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : s;
  const prefix = s[0] === '~' ? '~/…/' : (s[0] === '/' || s[0] === '\\') ? '/…/' : '…/';
  let cand = prefix + last;
  if (vlen(cand) <= budget) return cand;
  cand = '…/' + last;
  if (vlen(cand) <= budget) return cand;
  return '…' + truncTail(last, Math.max(1, budget - 1));
}

// 段间分隔符（带深灰轨道色），render 与 packLine 共用。
const SEP = track('  ·  ');

// 把"自带图标的段"用 sep 贪心装箱到 cols 列内：放不下的段下移成新物理行；
// 单段本身超宽也独占一行（不在段内部断字）。cols=Infinity 时退化为单行（保持原行为）。
function packLine(segments, cols, sep) {
  sep = sep == null ? SEP : sep;
  const sepW = vlen(sep);
  const out = [];
  let cur = segments.length ? segments[0] : '';
  let curW = vlen(cur);
  for (let i = 1; i < segments.length; i++) {
    const segW = vlen(segments[i]);
    if (curW + sepW + segW <= cols) {
      cur += sep + segments[i];
      curW += sepW + segW;
    } else {
      out.push(cur);
      cur = segments[i];
      curW = segW;
    }
  }
  out.push(cur);
  return out;
}

// 根据占用百分比给进度条上色：亮绿 < 50，亮黄 < 80，亮红 >= 80
function pctColor(pct) {
  if (pct >= 80) return '91'; // bright red
  if (pct >= 50) return '93'; // bright yellow
  return '92';                // bright green
}

// 渲染一个进度条： [█████░░░░░] 42%
function bar(pct, width = 10) {
  let p = Number(pct);
  if (!isFinite(p) || p < 0) p = 0;
  if (p > 100) p = 100;
  const filled = Math.round((width * p) / 100);
  const empty = width - filled;
  const code = pctColor(p);
  const body = A(code, '█'.repeat(filled)) + track('░'.repeat(empty));
  const label = A(code, String(Math.round(p)).padStart(2, ' ') + '%');
  return `${track('[')}${body}${track(']')} ${label}`;
}

// 把 token 数格式化为 84k / 1.2M
function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

// 把"距离重置"的秒数格式化为 2h13m / 4d3h / 12m
function fmtRemain(secs) {
  secs = Math.max(0, Math.floor(secs));
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

// 读取当前目录所在 git 仓库的分支名（直接读 .git/HEAD，避免起子进程）
function gitBranch(cwd) {
  try {
    let dir = cwd;
    for (let i = 0; i < 30 && dir; i++) {
      const gitPath = path.join(dir, '.git');
      let stat;
      try { stat = fs.statSync(gitPath); } catch (_) { stat = null; }
      if (stat) {
        let gitDir = gitPath;
        if (stat.isFile()) {
          // worktree: .git 是一个文件，内容形如 "gitdir: /path/to/.git/worktrees/xxx"
          const m = fs.readFileSync(gitPath, 'utf8').match(/gitdir:\s*(.+)/);
          if (m) gitDir = m[1].trim();
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = head.match(/ref:\s*refs\/heads\/(.+)/);
        return ref ? ref[1] : head.slice(0, 7); // detached HEAD 显示短 hash
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch (_) {}
  return null;
}

// 通过一次 `git status --porcelain -b` 拿到分支 + 工作区状态计数。
// 返回 {branch, staged, modified, untracked, ahead, behind}，非 git 仓库返回 null。
function gitInfo(cwd) {
  let out;
  try {
    out = cp.execSync('git status --porcelain=v1 -b', {
      cwd,
      timeout: 800,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (_) {
    // git 不可用或非仓库：退回只读 .git/HEAD 拿分支名（无法给出 dirty 计数）
    const b = gitBranch(cwd);
    return b ? { branch: b, staged: 0, modified: 0, untracked: 0, ahead: 0, behind: 0 } : null;
  }
  let branch = null, ahead = 0, behind = 0, staged = 0, modified = 0, untracked = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      if (head.startsWith('HEAD (no branch)')) {
        branch = gitBranch(cwd) || 'detached'; // detached HEAD：显示短 hash
      } else {
        branch = head.split('...')[0].split(' ')[0];
        const am = head.match(/ahead (\d+)/); if (am) ahead = +am[1];
        const bm = head.match(/behind (\d+)/); if (bm) behind = +bm[1];
      }
    } else if (line.length >= 2) {
      const x = line[0], y = line[1];
      if (x === '?' && y === '?') untracked++;
      else {
        if (x !== ' ' && x !== '?') staged++;   // 已暂存
        if (y !== ' ' && y !== '?') modified++;  // 工作区已修改（未暂存）
      }
    }
  }
  return branch ? { branch, staged, modified, untracked, ahead, behind } : null;
}

// 终端可用列宽：Claude Code 会在运行状态栏前注入 COLUMNS 环境变量（v2.1.153+）。
// 读不到时返回 Infinity —— 即"不折叠"，与历史行为完全一致（向后兼容/降级安全）。
function termWidth() {
  const c = parseInt(process.env.COLUMNS, 10);
  return (Number.isFinite(c) && c > 0) ? c : Infinity;
}

// ---------- 主渲染 ----------
// cols：终端可用列宽，默认取 termWidth()。把每组内容拆成"自带图标的段"交给 packLine：
// 宽终端时各组仍并成一行（与旧版逐字节一致）；窄终端时路径先压缩，放不下的段再下移成独立行。
function render(d, cols) {
  if (cols == null) cols = termWidth();
  const model = (d.model && d.model.display_name) || 'Claude';
  const cwd = (d.workspace && d.workspace.current_dir) || d.cwd || process.cwd();
  const git = gitInfo(cwd);

  const cw = d.context_window || {};
  const ctxPct =
    cw.used_percentage != null ? cw.used_percentage
    : (cw.context_window_size ? (100 * (cw.total_input_tokens || 0)) / cw.context_window_size : 0);
  const used = cw.total_input_tokens || 0;
  const size = cw.context_window_size || 200000;
  const cost = d.cost && d.cost.total_cost_usd;

  // 统一 emoji 图标族(🤖 📁 🌿 🧠 💰 📊 ⏳)；emoji 放在颜色包裹之外，文字才上亮色。
  const lines = [];

  // ----- 第 1 组：模型 · 目录 · git -----
  const modelSeg = '🤖 ' + bold(bcyan(model));
  let gitSeg = null;
  if (git) {
    let g = '🌿 ' + lmagenta(git.branch);
    const marks = [];
    if (git.staged) marks.push(bgreen('+' + git.staged));         // 已暂存：亮绿
    if (git.modified) marks.push(A('93', '~' + git.modified));    // 已修改：亮黄
    if (git.untracked) marks.push(muted('?' + git.untracked));    // 未跟踪：白
    if (marks.length) g += A('93', '*') + ' ' + marks.join(' ');  // dirty 标记
    else g += bgreen(' ✓'); // 干净
    let ab = '';
    if (git.ahead) ab += '↑' + git.ahead;
    if (git.behind) ab += '↓' + git.behind;
    if (ab) g += ' ' + bcyan(ab);
    gitSeg = g;
  }
  // 路径预算：让 模型·路径·git 尽量挤进一行；下限 8 列防止压得过短。
  const sepW = vlen(SEP);
  const fixed = vlen(modelSeg) + sepW + (gitSeg ? sepW + vlen(gitSeg) : 0) + vlen('📁 ');
  const pathBudget = Math.max(8, cols - fixed);
  const pathSeg = '📁 ' + lblue(shortenPath(cwd, pathBudget));
  for (const l of packLine([modelSeg, pathSeg, gitSeg].filter(Boolean), cols)) lines.push(l);

  // ----- 第 2 组：Context 上下文占用 · 花费 -----
  const ctxSeg = '🧠 ' + bold(bwhite('Context: ')) + bar(ctxPct) + bwhite(`  ${fmtTokens(used)}/${fmtTokens(size)}`);
  const costSeg = (typeof cost === 'number') ? '💰 ' + bgreen('$' + cost.toFixed(2)) : null;
  for (const l of packLine([ctxSeg, costSeg].filter(Boolean), cols)) lines.push(l);

  // ----- 第 3 组：套餐 Usage 进度条（仅 Pro/Max 订阅、且首次 API 响应后才有）-----
  const rl = d.rate_limits;
  if (rl && (rl.five_hour || rl.seven_day)) {
    const now = Date.now() / 1000;
    const seg = (label, w) => {
      if (!w || w.used_percentage == null) return null;
      let s = bwhite(label + ' ') + bar(w.used_percentage, 8);
      if (w.resets_at) s += ' ⏳ ' + muted(fmtRemain(w.resets_at - now));
      return s;
    };
    const parts = [seg('5h', rl.five_hour), seg('7d', rl.seven_day)].filter(Boolean);
    if (parts.length) {
      // Usage 段间用 3 空格分隔（保留原视觉）；窄终端则 7d 下移成独立行。
      const usageSegs = ['📊 ' + bold(bwhite('Usage: ')) + parts[0], ...parts.slice(1)];
      for (const l of packLine(usageSegs, cols, '   ')) lines.push(l);
    }
  }

  return lines.join('\n');
}

// 仅当作为命令运行时才执行 main()（见顶部守卫）；此处导出纯函数供测试与复用。
module.exports = { render, vlen, shortenPath, packLine };
