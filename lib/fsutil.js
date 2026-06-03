'use strict';
const fs = require('fs');
const path = require('path');

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

// 原子写：先写临时文件再 rename；若目标已存在，覆盖前备份为 .bak
function atomicWrite(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.copyFileSync(target, target + '.bak');
  const tmp = target + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

module.exports = { readIfExists, atomicWrite, copyDir };
