'use strict';
const os = require('os');
const path = require('path');

// 把 ~ / %USERPROFILE% / $HOME / ${HOME} 展开成规范化绝对路径
function expandPath(p) {
  if (typeof p !== 'string' || !p) return p;
  const home = os.homedir();
  let out = p;
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = home + out.slice(1);
  }
  out = out
    .replace(/%USERPROFILE%/gi, home)
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME\b/g, home);
  return path.normalize(out);
}

// apply 时用：把命令/路径字符串里作为路径前缀的 ~ 展开成本机 home。保留 / 分隔符。
function expandTildeInValue(s) {
  if (typeof s !== 'string') return s;
  const home = os.homedir();
  return s.replace(/~(?=[\\/]|"|$)/g, home);
}

// capture 时用：把字符串里的本机 home 收缩回 ~，并把 ~ 之后的反斜杠规范成正斜杠，
// 产出跨平台 canonical 形态（如 node "~/.claude/statusline.js"）。
function contractHomeInValue(s) {
  if (typeof s !== 'string') return s;
  const home = os.homedir();
  let out = s.split(home).join('~');
  out = out.replace(/~[^\s"']*/g, (m) => m.replace(/\\/g, '/'));
  return out;
}

module.exports = { expandPath, expandTildeInValue, contractHomeInValue };
