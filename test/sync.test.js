'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { expandPath } = require('../lib/paths');
const fs = require('fs');
const { readIfExists, atomicWrite, copyDir } = require('../lib/fsutil');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cct-'));
}

const HOME = os.homedir();

test('expandPath: ~ 前缀展开为 home', () => {
  assert.strictEqual(expandPath('~/.claude/x'), path.normalize(path.join(HOME, '.claude/x')));
});
test('expandPath: %USERPROFILE% 大小写无关', () => {
  assert.strictEqual(expandPath('%USERPROFILE%\\\\.claude'), path.normalize(path.join(HOME, '.claude')));
});
test('expandPath: $HOME / ${HOME}', () => {
  assert.strictEqual(expandPath('$HOME/.claude'), path.normalize(path.join(HOME, '.claude')));
  assert.strictEqual(expandPath('${HOME}/.claude'), path.normalize(path.join(HOME, '.claude')));
});
test('expandPath: 绝对路径原样', () => {
  assert.strictEqual(expandPath(path.normalize('/tmp/x')), path.normalize('/tmp/x'));
});

test('readIfExists: 不存在返回 null', () => {
  assert.strictEqual(readIfExists(path.join(tmpdir(), 'nope')), null);
});
test('atomicWrite: 写入新文件', () => {
  const d = tmpdir();
  const f = path.join(d, 'a.txt');
  atomicWrite(f, 'hello');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'hello');
});
test('atomicWrite: 覆盖前备份 .bak', () => {
  const d = tmpdir();
  const f = path.join(d, 'a.txt');
  atomicWrite(f, 'old');
  atomicWrite(f, 'new');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'new');
  assert.strictEqual(fs.readFileSync(f + '.bak', 'utf8'), 'old');
});
test('copyDir: 递归拷贝', () => {
  const d = tmpdir();
  const src = path.join(d, 'src');
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'sub', 'x.txt'), 'X');
  const dest = path.join(d, 'dest');
  copyDir(src, dest);
  assert.strictEqual(fs.readFileSync(path.join(dest, 'sub', 'x.txt'), 'utf8'), 'X');
});
