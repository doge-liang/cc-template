'use strict';
const fs = require('fs');
const cp = require('child_process');
const { readIfExists } = require('./fsutil');

function itemStatus(repoPath, targetPath) {
  if (!fs.existsSync(repoPath)) return 'repo-missing';
  if (!fs.existsSync(targetPath)) return 'local-missing';
  try {
    const a = fs.readFileSync(repoPath);
    const b = fs.readFileSync(targetPath);
    return a.equals(b) ? 'in-sync' : 'differs';
  } catch (_) { return 'differs'; }
}

// 文件 diff（方向：本地→repo 内容）。优先 git --no-index，失败退回 naive。
// 用 execFileSync(数组参数)：不经 shell，路径含空格/元字符也安全。
function fileDiff(localPath, repoPath) {
  try {
    return cp.execFileSync(
      'git',
      ['--no-pager', 'diff', '--no-index', '--color', '--', localPath, repoPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch (e) {
    // git diff --no-index 在有差异时退出码=1，但 stdout 仍带 diff 内容
    if (e && typeof e.stdout === 'string' && e.stdout) return e.stdout;
    return naiveDiff(localPath, repoPath);
  }
}

function naiveDiff(localPath, repoPath) {
  const a = (readIfExists(localPath) || '').split('\n');
  const b = (readIfExists(repoPath) || '').split('\n');
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) {
      if (a[i] !== undefined) out.push('- ' + a[i]);
      if (b[i] !== undefined) out.push('+ ' + b[i]);
    }
  }
  return out.join('\n');
}

function renderJsonDiff(rows, direction) {
  if (!rows.length) return '(无差异)';
  // apply(默认): repo→本地，local-only = 本地独有、合并时保留；
  // capture: 本地→repo，local-only = 仅在 repo 模板、整文件回灌后将被移除。
  const localOnlyLabel = direction === 'capture' ? '[仅在 repo 模板·回灌后移除]' : '[本地独有·保留]';
  return rows.map((r) => {
    if (r.kind === 'added') return '  + ' + r.path + '    新增 = ' + JSON.stringify(r.to);
    if (r.kind === 'changed') return '  ~ ' + r.path + '    ' + JSON.stringify(r.from) + ' → ' + JSON.stringify(r.to);
    if (r.kind === 'local-only') return '  · ' + r.path + '    ' + localOnlyLabel;
    if (r.kind === 'secret') return '  = ' + r.path + '    [密钥·保留本地]';
    return '  ? ' + r.path;
  }).join('\n');
}

module.exports = { itemStatus, fileDiff, naiveDiff, renderJsonDiff };
