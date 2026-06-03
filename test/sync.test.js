'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { expandPath } = require('../lib/paths');
const fs = require('fs');
const { readIfExists, atomicWrite, copyDir } = require('../lib/fsutil');
const { mergeForApply, diffJson, getByPath, setByPath, hasPath } = require('../lib/jsonmerge');
const { redactForCapture, safetyScan, scanText } = require('../lib/secrets');
const { validate } = require('../lib/manifest');

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

test('mergeForApply: 采纳 repo 新增键、保留本地独有键', () => {
  const template = { a: 1, shared: 'repo' };
  const local = { shared: 'local', localOnly: true };
  const { merged } = mergeForApply(template, local, []);
  assert.strictEqual(merged.a, 1);
  assert.strictEqual(merged.shared, 'repo');
  assert.strictEqual(merged.localOnly, true);
});

test('mergeForApply: 密钥路径保留本地真值', () => {
  const template = { env: { ZOTERO_API_KEY: '<占位>' }, x: 1 };
  const local = { env: { ZOTERO_API_KEY: 'REAL-KEY-123' } };
  const secrets = [{ path: 'env.ZOTERO_API_KEY', placeholder: '<占位>' }];
  const { merged, reminders } = mergeForApply(template, local, secrets);
  assert.strictEqual(getByPath(merged, 'env.ZOTERO_API_KEY'), 'REAL-KEY-123');
  assert.strictEqual(reminders.length, 0);
});

test('mergeForApply: 本地缺密钥时写占位并提醒', () => {
  const template = { env: { ZOTERO_API_KEY: '<占位>' } };
  const local = {};
  const secrets = [{ path: 'env.ZOTERO_API_KEY', placeholder: '<占位>', hint: 'go-here' }];
  const { merged, reminders } = mergeForApply(template, local, secrets);
  assert.strictEqual(getByPath(merged, 'env.ZOTERO_API_KEY'), '<占位>');
  assert.strictEqual(reminders.length, 1);
  assert.strictEqual(reminders[0].hint, 'go-here');
});

test('diffJson: 分类 added/changed/local-only/secret', () => {
  const local = { keep: 1, change: 'a', env: { K: 'real' } };
  const merged = { keep: 1, change: 'b', added: 2, env: { K: 'real' } };
  const rows = diffJson(local, merged, ['env.K']);
  const byPath = Object.fromEntries(rows.map(r => [r.path, r.kind]));
  assert.strictEqual(byPath['change'], 'changed');
  assert.strictEqual(byPath['added'], 'added');
  assert.strictEqual(byPath['env.K'], 'secret');
  assert.ok(!('keep' in byPath));
});

test('mergeForApply: local 仍为占位时触发 reminder', () => {
  const template = { env: { KEY: '<placeholder>' } };
  const local    = { env: { KEY: '<placeholder>' } };
  const secrets  = [{ path: 'env.KEY', placeholder: '<placeholder>' }];
  const { merged, reminders } = mergeForApply(template, local, secrets);
  assert.strictEqual(getByPath(merged, 'env.KEY'), '<placeholder>');
  assert.strictEqual(reminders.length, 1);
});

test('setByPath: 撞到标量中间节点时抛错', () => {
  assert.throws(() => setByPath({ a: 'scalar' }, 'a.b', 1), /不是对象/);
});

test('hasPath/getByPath: 数组路径行为一致', () => {
  const o = { a: [{ k: 'v' }] };
  assert.strictEqual(hasPath(o, 'a.0.k'), true);
  assert.strictEqual(getByPath(o, 'a.0.k'), 'v');
});

test('redactForCapture: 声明的密钥真值→占位', () => {
  const local = { env: { ZOTERO_API_KEY: 'REAL', other: 'keep' } };
  const secrets = [{ path: 'env.ZOTERO_API_KEY', placeholder: '<占位>' }];
  const out = redactForCapture(local, secrets);
  assert.strictEqual(out.env.ZOTERO_API_KEY, '<占位>');
  assert.strictEqual(out.env.other, 'keep');
  assert.strictEqual(local.env.ZOTERO_API_KEY, 'REAL');
});

test('safetyScan: 拦下未声明的疑似密钥（key 名命中）', () => {
  const obj = { env: { SOME_TOKEN: 'abc123xyz' } };
  const found = safetyScan(obj, ['<占位>']);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].path, 'env.SOME_TOKEN');
});

test('safetyScan: 已声明占位 / 已知占位不报', () => {
  const obj = { env: { ZOTERO_API_KEY: '<占位>', NORMAL: 'hello' } };
  const found = safetyScan(obj, ['<占位>']);
  assert.strictEqual(found.length, 0);
});

test('safetyScan: 高熵长串值即使 key 名普通也命中', () => {
  const obj = { foo: 'Ab3kZ9qP2wL7nR4tX1mD8vC0' };
  const found = safetyScan(obj, []);
  assert.strictEqual(found.length, 1);
});

test('scanText: 裸文件中的密钥赋值', () => {
  const txt = 'API_KEY=Ab3kZ9qP2wL7nR4tX1mD8vC0\nname=hello\n';
  const found = scanText(txt, []);
  assert.strictEqual(found.length, 1);
});

test('safetyScan: 数组里的裸高熵串也命中', () => {
  const found = safetyScan({ creds: ['Ab3kZ9qP2wL7nR4tX1mD8vC0'] }, []);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].path, 'creds[0]');
});

test('scanText: JSON 形式 "KEY": "VALUE" 也命中', () => {
  const txt = '  "API_KEY": "Ab3kZ9qP2wL7nR4tX1mD8vC0",\n  "name": "hello"\n';
  const found = scanText(txt, []);
  assert.strictEqual(found.length, 1);
});

test('safetyScan: 密钥名但值为 null/数字 不误报', () => {
  const found = safetyScan({ env: { SOME_TOKEN: null, COUNT: 12345 } }, []);
  assert.strictEqual(found.length, 0);
});

test('validate: 合法 manifest 通过', () => {
  const m = { version: 1, items: [
    { id: 'a', type: 'file', repo: 'r', target: 't' },
    { id: 'b', type: 'json-merge', repo: 'r2', target: 't2',
      secrets: [{ path: 'env.K', placeholder: '<p>' }] },
  ]};
  assert.strictEqual(validate(m), true);
});
test('validate: 缺 items 报错', () => {
  assert.throws(() => validate({}), /items/);
});
test('validate: id 重复报错', () => {
  const m = { items: [
    { id: 'x', type: 'file', repo: 'r', target: 't' },
    { id: 'x', type: 'file', repo: 'r', target: 't' },
  ]};
  assert.throws(() => validate(m), /重复/);
});
test('validate: 非法 type 报错', () => {
  assert.throws(() => validate({ items: [{ id: 'x', type: 'bad', repo: 'r', target: 't' }] }), /type/);
});
