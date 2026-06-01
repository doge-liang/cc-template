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

// ---------- ANSI 颜色辅助 ----------
const A = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const dim = (s) => A('2', s);
const bold = (s) => A('1', s);
const cyan = (s) => A('36', s);
const blue = (s) => A('34', s);
const gray = (s) => A('90', s);

// 根据占用百分比给进度条上色：绿 < 50，黄 < 80，红 >= 80
function pctColor(pct) {
  if (pct >= 80) return '31'; // red
  if (pct >= 50) return '33'; // yellow
  return '32';                // green
}

// 渲染一个进度条： [█████░░░░░] 42%
function bar(pct, width = 10) {
  let p = Number(pct);
  if (!isFinite(p) || p < 0) p = 0;
  if (p > 100) p = 100;
  const filled = Math.round((width * p) / 100);
  const empty = width - filled;
  const code = pctColor(p);
  const body = A(code, '█'.repeat(filled)) + dim('░'.repeat(empty));
  const label = A(code, String(Math.round(p)).padStart(2, ' ') + '%');
  return `${dim('[')}${body}${dim(']')} ${label}`;
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

// ---------- 主渲染 ----------
function render(d) {
  const model = (d.model && d.model.display_name) || 'Claude';
  const cwd = (d.workspace && d.workspace.current_dir) || d.cwd || process.cwd();
  const dirName = path.basename(cwd) || cwd;
  const branch = gitBranch(cwd);

  const cw = d.context_window || {};
  const ctxPct =
    cw.used_percentage != null ? cw.used_percentage
    : (cw.context_window_size ? (100 * (cw.total_input_tokens || 0)) / cw.context_window_size : 0);
  const used = cw.total_input_tokens || 0;
  const size = cw.context_window_size || 200000;

  const cost = d.cost && d.cost.total_cost_usd;

  // ----- 第 1 行：模型 · 目录 · git -----
  const sep = gray(' · ');
  let line1 = bold(cyan('◆ ' + model)) + sep + blue('📁 ' + dirName);
  if (branch) line1 += sep + A('35', '⎇ ' + branch);

  // ----- 第 2 行：Context 上下文占用 -----
  let line2 = gray('🧠 Ctx ') + bar(ctxPct) + gray(`  ${fmtTokens(used)}/${fmtTokens(size)}`);
  if (typeof cost === 'number') line2 += gray('   💰 $' + cost.toFixed(2));

  const lines = [line1, line2];

  // ----- 第 3 行：套餐 Usage 进度条（仅 Pro/Max 订阅、且首次 API 响应后才有）-----
  const rl = d.rate_limits;
  if (rl && (rl.five_hour || rl.seven_day)) {
    const now = Date.now() / 1000;
    const seg = (label, w) => {
      if (!w || w.used_percentage == null) return null;
      let s = gray(label + ' ') + bar(w.used_percentage, 8);
      if (w.resets_at) s += gray(' ↺' + fmtRemain(w.resets_at - now));
      return s;
    };
    const parts = [seg('5h', rl.five_hour), seg('7d', rl.seven_day)].filter(Boolean);
    if (parts.length) lines.push(gray('📊 ') + parts.join(gray('   ')));
  }

  return lines.join('\n');
}
