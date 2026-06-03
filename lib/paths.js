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

module.exports = { expandPath };
