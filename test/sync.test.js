'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { expandPath } = require('../lib/paths');

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
