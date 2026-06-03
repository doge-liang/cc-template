'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { expandPath, expandTildeInValue, contractHomeInValue } = require('../lib/paths');
const fs = require('fs');
const { readIfExists, atomicWrite, copyDir } = require('../lib/fsutil');
const { mergeForApply, diffJson, getByPath, setByPath, hasPath } = require('../lib/jsonmerge');
const { redactForCapture, safetyScan, scanText } = require('../lib/secrets');
const { validate } = require('../lib/manifest');
const { itemStatus, renderJsonDiff } = require('../lib/diff');

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

test('itemStatus: repo-missing / local-missing / in-sync / differs', () => {
  const d = tmpdir();
  const repo = path.join(d, 'repo.txt');
  const local = path.join(d, 'local.txt');
  assert.strictEqual(itemStatus(repo, local), 'repo-missing');
  fs.writeFileSync(repo, 'same');
  assert.strictEqual(itemStatus(repo, local), 'local-missing');
  fs.writeFileSync(local, 'same');
  assert.strictEqual(itemStatus(repo, local), 'in-sync');
  fs.writeFileSync(local, 'different');
  assert.strictEqual(itemStatus(repo, local), 'differs');
});

test('renderJsonDiff: 含各类标记', () => {
  const rows = [
    { path: 'added', kind: 'added', to: 2 },
    { path: 'change', kind: 'changed', from: 'a', to: 'b' },
    { path: 'env.K', kind: 'secret' },
  ];
  const s = renderJsonDiff(rows);
  assert.match(s, /\+ added/);
  assert.match(s, /~ change/);
  assert.match(s, /env\.K/);
  assert.match(s, /密钥/);
});

const cp = require('child_process');
const REPO_ROOT = path.join(__dirname, '..');

function runCli(args, opts) {
  return cp.spawnSync('node', [path.join(REPO_ROOT, 'sync.js'), ...args],
    { encoding: 'utf8', ...opts });
}

test('CLI list: 列出 manifest 项', () => {
  const r = runCli(['list']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /statusline/);
  assert.match(r.stdout, /settings/);
});

test('CLI diff statusline: 可运行', () => {
  const r = runCli(['diff', 'statusline']);
  assert.strictEqual(r.status, 0);
});

test('CLI 未知命令: 非零退出 + 用法', () => {
  const r = runCli(['frobnicate']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /用法|usage/i);
});

test('renderJsonDiff: capture 方向 local-only 标签不同', () => {
  const rows = [{ path: 'x', kind: 'local-only', from: 1 }];
  assert.match(renderJsonDiff(rows, 'capture'), /回灌后移除/);
  assert.match(renderJsonDiff(rows), /本地独有/);
});

test('CLI capture statusline --dry-run: file 类不报假阳、可运行', () => {
  const r = runCli(['capture', 'statusline', '--dry-run']);
  assert.strictEqual(r.status, 0);
});

// Part 1: paths.js helpers
test('expandTildeInValue: 命令中的 ~ 展开为 home，保留斜杠', () => {
  const os = require('os');
  const out = expandTildeInValue('node "~/.claude/statusline.js"');
  assert.ok(out.includes(os.homedir()));
  assert.ok(!out.includes('~'));
});
test('contractHomeInValue: home 收缩回 ~ 且反斜杠归一为 /', () => {
  const os = require('os'), path = require('path');
  const cmd = 'node "' + path.join(os.homedir(), '.claude', 'statusline.js') + '"';
  const out = contractHomeInValue(cmd);
  assert.strictEqual(out, 'node "~/.claude/statusline.js"');
});
test('expandTilde/contractHome round-trip 跨平台 canonical', () => {
  const canonical = 'node "~/.claude/statusline.js"';
  assert.strictEqual(contractHomeInValue(expandTildeInValue(canonical)), canonical);
});

// Part 2: jsonmerge.js whitelist + buildCaptureTemplate
const { buildCaptureTemplate } = require('../lib/jsonmerge');

test('mergeForApply: 白名单只覆盖名单内键，名单外本地键不动', () => {
  const template = { a: 1, b: 2, keepLocalOnly: 'TPL' };
  const local = { a: 0, b: 0, keepLocalOnly: 'LOCAL', untouched: 'X' };
  const { merged } = mergeForApply(template, local, [], { keys: ['a', 'b'] });
  assert.strictEqual(merged.a, 1);
  assert.strictEqual(merged.b, 2);
  assert.strictEqual(merged.keepLocalOnly, 'LOCAL'); // 不在白名单 → 不覆盖
  assert.strictEqual(merged.untouched, 'X');
});
test('mergeForApply: pathField 在 apply 时展开 ~', () => {
  const os = require('os');
  const template = { statusLine: { command: 'node "~/.claude/statusline.js"' } };
  const { merged } = mergeForApply(template, {}, [], { keys: ['statusLine.command'], pathFields: ['statusLine.command'] });
  assert.ok(getByPath(merged, 'statusLine.command').includes(os.homedir()));
  assert.ok(!getByPath(merged, 'statusLine.command').includes('~'));
});
test('mergeForApply: 白名单外的密钥不处理', () => {
  const template = { env: { K: '<p>' } };
  const local = {};
  const secrets = [{ path: 'env.K', placeholder: '<p>' }];
  const { merged, reminders } = mergeForApply(template, local, secrets, { keys: ['somethingElse'] });
  assert.strictEqual(reminders.length, 0); // env.K 不在白名单 → 不提醒
  assert.ok(!('env' in merged) || merged.env.K === undefined);
});
test('buildCaptureTemplate: 只写白名单键，密钥→占位，pathField→canonical', () => {
  const os = require('os'), path = require('path');
  const repoTemplate = { existingRepoOnly: 'KEEP' };
  const local = {
    env: { K: 'REALSECRET' },
    statusLine: { command: 'node "' + path.join(os.homedir(), '.claude', 'statusline.js') + '"' },
    personal: 'SHOULD_NOT_LEAK',
  };
  const secrets = [{ path: 'env.K', placeholder: '<p>' }];
  const out = buildCaptureTemplate(repoTemplate, local, secrets,
    { keys: ['env.K', 'statusLine.command'], pathFields: ['statusLine.command'] });
  assert.strictEqual(out.env.K, '<p>');                       // 密钥脱敏
  assert.strictEqual(out.statusLine.command, 'node "~/.claude/statusline.js"'); // canonical
  assert.strictEqual(out.existingRepoOnly, 'KEEP');           // 名单外 repo 键保留
  assert.ok(!('personal' in out));                            // 名单外 local 键不泄露
});

test('CLI diff settings: 白名单外的键(skipDangerous)不出现', () => {
  const r = runCli(['diff', 'settings']);
  assert.strictEqual(r.status, 0);
  assert.ok(!/skipDangerousModePermissionPrompt/.test(r.stdout));
});
test('CLI capture settings --dry-run: 无泄露、可运行', () => {
  const r = runCli(['capture', 'settings', '--dry-run']);
  assert.strictEqual(r.status, 0);
});
