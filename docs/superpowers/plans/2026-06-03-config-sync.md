# cc-template 配置同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 cc-template 升级为多设备 Claude Code 配置模板仓，提供单文件零依赖 Node CLI（`sync.js`），支持单项 `apply`/`capture`/`diff`/`list`，密钥走模板占位，capture 时安全扫描兜底。

**Architecture:** manifest 驱动的注册表（`manifest.json`）+ 纯函数 `lib/` 模块（路径展开、原子写、JSON 键级合并保密钥、密钥脱敏与扫描、diff）+ 薄 CLI 编排层（`sync.js`）。apply 时密钥保留本地真值、capture 时密钥写回占位，本地独有键永不删除。

**Tech Stack:** Node.js（v18+，用内置 `node:test`/`assert`/`fs`/`readline`/`child_process`），零外部 npm 依赖。子进程一律用 `execFileSync(file, argsArray)`（不经 shell，避免注入与空格问题）。

参考 spec：`docs/superpowers/specs/2026-06-03-cc-template-config-sync-design.md`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `lib/paths.js` | 路径展开：`~` / `%USERPROFILE%` / `$HOME` → 绝对路径 |
| `lib/fsutil.js` | `readIfExists`、`atomicWrite`（临时文件+rename，覆盖前 `.bak`）、`copyDir` |
| `lib/jsonmerge.js` | `getByPath`/`setByPath`/`hasPath`、`mergeForApply`（键级合并+保密钥）、`diffJson` |
| `lib/secrets.js` | `redactForCapture`（真值→占位）、`safetyScan`（结构）、`scanText`（裸文件） |
| `lib/manifest.js` | `loadManifest` + `validate` |
| `lib/diff.js` | `itemStatus`、`fileDiff`（git 优先+naive 降级）、`renderJsonDiff` |
| `sync.js` | CLI：`list`/`diff`/`apply`/`capture`，参数解析，readline 确认 |
| `manifest.json` | 同步注册表 |
| `configs/settings.template.json` | 脱敏 settings 模板 |
| `test/sync.test.js` | node:test 测试 |

每个 `lib/*` 是无副作用纯函数（`fsutil` 除外），可单独测试。

---

## Task 1: `lib/paths.js` — 路径展开

**Files:**
- Create: `lib/paths.js`
- Test: `test/sync.test.js`

- [ ] **Step 1: Write the failing test**

在 `test/sync.test.js` 写入：

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sync.test.js`
Expected: FAIL，`Cannot find module '../lib/paths'`

- [ ] **Step 3: Write minimal implementation**

`lib/paths.js`：

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sync.test.js`
Expected: PASS（4 个 expandPath 用例通过）

- [ ] **Step 5: Commit**

```bash
git add lib/paths.js test/sync.test.js
git commit -m "feat(sync): add path expansion (lib/paths.js)"
```

---

## Task 2: `lib/fsutil.js` — 原子写 + 备份 + 目录拷贝

**Files:**
- Create: `lib/fsutil.js`
- Test: `test/sync.test.js`（追加）

- [ ] **Step 1: Write the failing test**

在 `test/sync.test.js` 顶部 require 处追加：

```js
const fs = require('fs');
const { readIfExists, atomicWrite, copyDir } = require('../lib/fsutil');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cct-'));
}
```

追加测试：

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sync.test.js`
Expected: FAIL，`Cannot find module '../lib/fsutil'`

- [ ] **Step 3: Write minimal implementation**

`lib/fsutil.js`：

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sync.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/fsutil.js test/sync.test.js
git commit -m "feat(sync): add fs utils (atomic write, backup, copyDir)"
```

---

## Task 3: `lib/jsonmerge.js` — 键级合并保密钥 + JSON diff

**Files:**
- Create: `lib/jsonmerge.js`
- Test: `test/sync.test.js`（追加）

- [ ] **Step 1: Write the failing test**

require 处追加：

```js
const { mergeForApply, diffJson, getByPath } = require('../lib/jsonmerge');
```

追加测试：

```js
test('mergeForApply: 采纳 repo 新增键、保留本地独有键', () => {
  const template = { a: 1, shared: 'repo' };
  const local = { shared: 'local', localOnly: true };
  const { merged } = mergeForApply(template, local, []);
  assert.strictEqual(merged.a, 1);              // repo 新增
  assert.strictEqual(merged.shared, 'repo');     // repo 覆盖
  assert.strictEqual(merged.localOnly, true);    // 本地独有保留
});

test('mergeForApply: 密钥路径保留本地真值', () => {
  const template = { env: { ZOTERO_API_KEY: '<占位>' }, x: 1 };
  const local = { env: { ZOTERO_API_KEY: 'REAL-KEY-123' } };
  const secrets = [{ path: 'env.ZOTERO_API_KEY', placeholder: '<占位>' }];
  const { merged, reminders } = mergeForApply(template, local, secrets);
  assert.strictEqual(getByPath(merged, 'env.ZOTERO_API_KEY'), 'REAL-KEY-123');
  assert.strictEqual(reminders.length, 0);       // 本地已有真值，无需提醒
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
  assert.ok(!('keep' in byPath));  // 相等项不出现
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sync.test.js`
Expected: FAIL，`Cannot find module '../lib/jsonmerge'`

- [ ] **Step 3: Write minimal implementation**

`lib/jsonmerge.js`：

```js
'use strict';

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

function getByPath(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setByPath(obj, dotPath, value) {
  const keys = dotPath.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isObj(o[keys[i]])) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}
function hasPath(obj, dotPath) {
  const keys = dotPath.split('.');
  let o = obj;
  for (const k of keys) {
    if (!isObj(o) || !(k in o)) return false;
    o = o[k];
  }
  return true;
}

// over 覆盖 base：对象递归合并，数组/标量整体替换
function deepMerge(base, over) {
  if (!isObj(over)) return clone(over);
  const out = isObj(base) ? clone(base) : {};
  for (const k of Object.keys(over)) {
    out[k] = isObj(over[k]) && isObj(out[k]) ? deepMerge(out[k], over[k]) : clone(over[k]);
  }
  return out;
}

// apply 用：template 覆盖 local（local 独有键保留），密钥路径保留本地真值。
// 本地缺密钥（无/等于占位）则写占位并收集到 reminders。
function mergeForApply(template, local, secrets) {
  const localObj = local || {};
  const merged = deepMerge(localObj, template);
  const reminders = [];
  for (const s of (secrets || [])) {
    const localVal = getByPath(localObj, s.path);
    if (localVal != null && localVal !== s.placeholder) {
      setByPath(merged, s.path, localVal);
    } else {
      setByPath(merged, s.path, s.placeholder);
      reminders.push(s);
    }
  }
  return { merged, reminders };
}

function flatten(obj, prefix, out) {
  out = out || {};
  if (isObj(obj)) {
    for (const k of Object.keys(obj)) flatten(obj[k], prefix ? prefix + '.' + k : k, out);
  } else {
    out[prefix] = obj;
  }
  return out;
}

// 返回 [{path, kind, from?, to?}]，kind ∈ added|changed|local-only|secret；相等项省略
function diffJson(local, merged, secretPaths) {
  const secret = new Set(secretPaths || []);
  const a = flatten(local || {}, '');
  const b = flatten(merged || {}, '');
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const rows = [];
  for (const k of keys) {
    if (secret.has(k)) { rows.push({ path: k, kind: 'secret' }); continue; }
    const inA = k in a, inB = k in b;
    if (inA && !inB) rows.push({ path: k, kind: 'local-only', from: a[k] });
    else if (!inA && inB) rows.push({ path: k, kind: 'added', to: b[k] });
    else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) rows.push({ path: k, kind: 'changed', from: a[k], to: b[k] });
  }
  return rows;
}

module.exports = { getByPath, setByPath, hasPath, deepMerge, mergeForApply, flatten, diffJson, clone };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sync.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/jsonmerge.js test/sync.test.js
git commit -m "feat(sync): add json merge with secret preservation + diff"
```

---

## Task 4: `lib/secrets.js` — 脱敏 + 安全扫描

**Files:**
- Create: `lib/secrets.js`
- Test: `test/sync.test.js`（追加）

- [ ] **Step 1: Write the failing test**

require 处追加：

```js
const { redactForCapture, safetyScan, scanText } = require('../lib/secrets');
```

追加测试：

```js
test('redactForCapture: 声明的密钥真值→占位', () => {
  const local = { env: { ZOTERO_API_KEY: 'REAL', other: 'keep' } };
  const secrets = [{ path: 'env.ZOTERO_API_KEY', placeholder: '<占位>' }];
  const out = redactForCapture(local, secrets);
  assert.strictEqual(out.env.ZOTERO_API_KEY, '<占位>');
  assert.strictEqual(out.env.other, 'keep');
  assert.strictEqual(local.env.ZOTERO_API_KEY, 'REAL'); // 不改原对象
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sync.test.js`
Expected: FAIL，`Cannot find module '../lib/secrets'`

- [ ] **Step 3: Write minimal implementation**

`lib/secrets.js`：

```js
'use strict';
const { hasPath, setByPath, clone } = require('./jsonmerge');

const SECRET_KEY_RE = /(_KEY|_TOKEN|_SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|CLIENT_SECRET)/i;

function isPlaceholder(v) {
  return typeof v === 'string' && /^\s*<.*>\s*$/.test(v);
}
// 高熵长串：≥20 位、含字母+数字、无空白
function looksSecretValue(v) {
  return typeof v === 'string' && v.length >= 20 && /[A-Za-z]/.test(v) && /[0-9]/.test(v) && !/\s/.test(v);
}

// capture：把声明的密钥路径替换成占位（不改原对象）
function redactForCapture(obj, secrets) {
  const out = clone(obj);
  for (const s of (secrets || [])) {
    if (hasPath(out, s.path)) setByPath(out, s.path, s.placeholder);
  }
  return out;
}

// 结构化对象扫描：返回 [{path, value}] 疑似未声明密钥
function safetyScan(obj, knownPlaceholders) {
  const known = new Set(knownPlaceholders || []);
  const found = [];
  (function walk(o, prefix) {
    if (Array.isArray(o)) { o.forEach((v, i) => walk(v, prefix + '[' + i + ']')); return; }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        const p = prefix ? prefix + '.' + k : k;
        const v = o[k];
        if (v && typeof v === 'object') { walk(v, p); continue; }
        if (isPlaceholder(v) || known.has(v)) continue;
        if (SECRET_KEY_RE.test(k) || looksSecretValue(v)) found.push({ path: p, value: v });
      }
    }
  })(obj, '');
  return found;
}

// 裸文本扫描：逐行找 KEY=VALUE / "KEY": "VALUE" 形式的疑似密钥
function scanText(text, knownPlaceholders) {
  const known = new Set(knownPlaceholders || []);
  const found = [];
  const lines = String(text).split(/\r?\n/);
  const re = /([A-Za-z0-9_]+)\s*[:=]\s*["']?([^"'\s]+)["']?/;
  lines.forEach((line, i) => {
    const m = line.match(re);
    if (!m) return;
    const key = m[1], val = m[2];
    if (isPlaceholder(val) || known.has(val)) return;
    if (SECRET_KEY_RE.test(key) || looksSecretValue(val)) found.push({ path: 'line ' + (i + 1), value: val });
  });
  return found;
}

module.exports = { redactForCapture, safetyScan, scanText, isPlaceholder, looksSecretValue };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sync.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/secrets.js test/sync.test.js
git commit -m "feat(sync): add secret redaction + safety scan"
```

---

## Task 5: `lib/manifest.js` — 加载与校验

**Files:**
- Create: `lib/manifest.js`
- Test: `test/sync.test.js`（追加）

- [ ] **Step 1: Write the failing test**

require 处追加：

```js
const { validate } = require('../lib/manifest');
```

追加测试：

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sync.test.js`
Expected: FAIL，`Cannot find module '../lib/manifest'`

- [ ] **Step 3: Write minimal implementation**

`lib/manifest.js`：

```js
'use strict';
const fs = require('fs');
const path = require('path');

function validate(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.items)) {
    throw new Error('manifest 缺少 items 数组');
  }
  const ids = new Set();
  for (const it of m.items) {
    if (!it.id) throw new Error('item 缺少 id');
    if (ids.has(it.id)) throw new Error('item id 重复: ' + it.id);
    ids.add(it.id);
    if (!['file', 'dir', 'json-merge'].includes(it.type)) {
      throw new Error('item ' + it.id + ' type 非法: ' + it.type);
    }
    if (!it.repo || !it.target) throw new Error('item ' + it.id + ' 缺少 repo/target');
    if (it.type === 'json-merge' && it.secrets) {
      for (const s of it.secrets) {
        if (!s.path || s.placeholder == null) {
          throw new Error('item ' + it.id + ' secret 缺少 path/placeholder');
        }
      }
    }
  }
  return true;
}

function loadManifest(repoRoot) {
  const p = path.join(repoRoot, 'manifest.json');
  let m;
  try { m = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error('manifest.json 解析失败: ' + e.message); }
  validate(m);
  return m;
}

module.exports = { loadManifest, validate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sync.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/manifest.js test/sync.test.js
git commit -m "feat(sync): add manifest loader + validator"
```

---

## Task 6: `lib/diff.js` — 状态判定与 diff 渲染

**Files:**
- Create: `lib/diff.js`
- Test: `test/sync.test.js`（追加）

> 注意：子进程用 `execFileSync('git', [...])`（数组参数、不经 shell），避免命令注入与路径空格问题。

- [ ] **Step 1: Write the failing test**

require 处追加：

```js
const { itemStatus, renderJsonDiff } = require('../lib/diff');
```

追加测试：

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sync.test.js`
Expected: FAIL，`Cannot find module '../lib/diff'`

- [ ] **Step 3: Write minimal implementation**

`lib/diff.js`：

```js
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

function renderJsonDiff(rows) {
  if (!rows.length) return '(无差异)';
  return rows.map((r) => {
    if (r.kind === 'added') return '  + ' + r.path + '    新增 = ' + JSON.stringify(r.to);
    if (r.kind === 'changed') return '  ~ ' + r.path + '    ' + JSON.stringify(r.from) + ' → ' + JSON.stringify(r.to);
    if (r.kind === 'local-only') return '  · ' + r.path + '    [本地独有·保留]';
    if (r.kind === 'secret') return '  = ' + r.path + '    [密钥·保留本地]';
    return '  ? ' + r.path;
  }).join('\n');
}

module.exports = { itemStatus, fileDiff, naiveDiff, renderJsonDiff };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sync.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/diff.js test/sync.test.js
git commit -m "feat(sync): add status detection + diff renderers"
```

---

## Task 7: `manifest.json` + `configs/settings.template.json` + 带入新版 statusline

**Files:**
- Create: `manifest.json`
- Create: `configs/settings.template.json`
- Modify: `statuslines/context-usage-bar/statusline.js`（替换为本地已迭代的新视觉版）

- [ ] **Step 1: 写 `manifest.json`**

```json
{
  "version": 1,
  "items": [
    {
      "id": "statusline",
      "type": "file",
      "repo": "statuslines/context-usage-bar/statusline.js",
      "target": "~/.claude/statusline.js",
      "description": "上下文+套餐进度条状态栏"
    },
    {
      "id": "settings",
      "type": "json-merge",
      "repo": "configs/settings.template.json",
      "target": "~/.claude/settings.json",
      "secrets": [
        { "path": "env.ZOTERO_API_KEY", "placeholder": "<填你的 Zotero API Key>",
          "hint": "https://www.zotero.org/settings/keys → New Private Key" },
        { "path": "env.ZOTERO_USER_ID", "placeholder": "<你的 Zotero numeric userID>",
          "hint": "同页 'Your userID for use in API calls'" }
      ]
    }
  ]
}
```

> 说明：skills/keybindings 项等后续有实际内容时再加。本计划先交付 statusline + settings 两项，保证可端到端验证。

- [ ] **Step 2: 写 `configs/settings.template.json`**

从作者本地 `~/.claude/settings.json` 脱敏而来；密钥用占位：

```json
{
  "env": {
    "ZOTERO_LOCAL": "false",
    "ZOTERO_USER_ID": "<你的 Zotero numeric userID>",
    "ZOTERO_API_KEY": "<填你的 Zotero API Key>",
    "PYTHONIOENCODING": "utf-8"
  },
  "permissions": {
    "defaultMode": "auto"
  },
  "statusLine": {
    "type": "command",
    "command": "node \"~/.claude/statusline.js\"",
    "padding": 0
  }
}
```

- [ ] **Step 3: 用本地新版覆盖 repo 的 statusline.js**

```bash
cp ~/.claude/statusline.js statuslines/context-usage-bar/statusline.js
```

Run（确认渲染正常）:
```bash
node -e "const o={model:{display_name:'Opus 4.8'},workspace:{current_dir:'C:/x/proj'},context_window:{used_percentage:42,total_input_tokens:84000,context_window_size:200000},cost:{total_cost_usd:0.34}};process.stdout.write(JSON.stringify(o))" | node statuslines/context-usage-bar/statusline.js
```
Expected: 两行彩色输出，emoji 🤖 📁 🧠、`Context:` 文案、完整路径。

- [ ] **Step 4: 校验 manifest + template 合法**

Run:
```bash
node -e "require('./lib/manifest').loadManifest('.'); JSON.parse(require('fs').readFileSync('configs/settings.template.json','utf8')); console.log('ok')"
```
Expected: 打印 `ok`

- [ ] **Step 5: Commit**

```bash
git add manifest.json configs/settings.template.json statuslines/context-usage-bar/statusline.js
git commit -m "feat(sync): add manifest + sanitized settings template + updated statusline"
```

---

## Task 8: `sync.js` — CLI 编排

**Files:**
- Create: `sync.js`
- Test: `test/sync.test.js`（追加集成测试）

- [ ] **Step 1: Write the failing test**

require 处追加（用 child_process 跑 CLI；spawnSync 用数组参数，安全）：

```js
const cp = require('child_process');
const REPO_ROOT = path.join(__dirname, '..');

function runCli(args, opts) {
  return cp.spawnSync('node', [path.join(REPO_ROOT, 'sync.js'), ...args],
    { encoding: 'utf8', ...opts });
}
```

追加测试：

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sync.test.js`
Expected: FAIL（`sync.js` 不存在 → spawn 返回非 0 / 无匹配输出）

- [ ] **Step 3: Write minimal implementation**

`sync.js`：

```js
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadManifest } = require('./lib/manifest');
const { expandPath } = require('./lib/paths');
const { readIfExists, atomicWrite, copyDir } = require('./lib/fsutil');
const { mergeForApply, diffJson } = require('./lib/jsonmerge');
const { redactForCapture, safetyScan } = require('./lib/secrets');
const { itemStatus, fileDiff, renderJsonDiff } = require('./lib/diff');

const REPO = __dirname;
const FORCE_FLAG = '--force-allow-unredacted';

function parseArgs(argv) {
  const flags = { yes: false, dryRun: false, force: false };
  const ids = [];
  for (const a of argv) {
    if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === FORCE_FLAG) flags.force = true;
    else ids.push(a);
  }
  return { ids, flags };
}

function selectItems(manifest, ids) {
  if (!ids.length) return manifest.items;
  const byId = new Map(manifest.items.map((it) => [it.id, it]));
  return ids.map((id) => {
    if (!byId.has(id)) { console.error('未知 item: ' + id); process.exit(2); }
    return byId.get(id);
  });
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => { rl.close(); resolve(ans.trim().toLowerCase()); });
  });
}
async function confirm(flags, prompt) {
  if (flags.yes) return true;
  const ans = await ask(prompt + ' [y/N] ');
  return ans === 'y' || ans === 'yes';
}

function repoPath(it) { return path.join(REPO, it.repo); }
function targetPath(it) { return expandPath(it.target); }
function secretPaths(it) { return (it.secrets || []).map((s) => s.path); }

function cmdList(manifest) {
  for (const it of manifest.items) {
    const st = itemStatus(repoPath(it), targetPath(it));
    console.log(st.padEnd(14) + it.id + (it.description ? '  — ' + it.description : ''));
  }
}

function cmdDiff(items) {
  for (const it of items) {
    console.log('\n=== ' + it.id + ' (' + it.type + ') ===');
    if (it.type === 'json-merge') {
      const tpl = JSON.parse(readIfExists(repoPath(it)) || '{}');
      const local = JSON.parse(readIfExists(targetPath(it)) || '{}');
      const { merged } = mergeForApply(tpl, local, it.secrets);
      console.log(renderJsonDiff(diffJson(local, merged, secretPaths(it))));
    } else {
      console.log(fileDiff(targetPath(it), repoPath(it)) || '(无差异)');
    }
  }
}

async function cmdApply(items, flags) {
  for (const it of items) {
    console.log('\n=== apply ' + it.id + ' ===');
    const rp = repoPath(it), tp = targetPath(it);
    if (!fs.existsSync(rp)) { console.error('repo 缺少 ' + it.repo + '，跳过'); continue; }
    if (it.type === 'json-merge') {
      const tpl = JSON.parse(readIfExists(rp) || '{}');
      const local = JSON.parse(readIfExists(tp) || '{}');
      const { merged, reminders } = mergeForApply(tpl, local, it.secrets);
      const rows = diffJson(local, merged, secretPaths(it));
      console.log(renderJsonDiff(rows));
      if (flags.dryRun) continue;
      if (rows.length && !(await confirm(flags, '写入 ' + tp + '?'))) { console.log('跳过'); continue; }
      atomicWrite(tp, JSON.stringify(merged, null, 2) + '\n');
      console.log('已写入 ' + tp);
      for (const r of reminders) {
        console.log('  ⚠ 待填密钥 ' + r.path + ' = ' + r.placeholder + (r.hint ? '  (' + r.hint + ')' : ''));
      }
    } else {
      console.log(fileDiff(tp, rp) || '(无差异)');
      if (flags.dryRun) continue;
      if (!(await confirm(flags, '用 repo 覆盖本地 ' + tp + '?'))) { console.log('跳过'); continue; }
      if (it.type === 'dir') copyDir(rp, tp);
      else atomicWrite(tp, fs.readFileSync(rp));
      console.log('已写入 ' + tp);
    }
  }
}

async function cmdCapture(items, flags) {
  for (const it of items) {
    console.log('\n=== capture ' + it.id + ' ===');
    const rp = repoPath(it), tp = targetPath(it);
    if (!fs.existsSync(tp)) { console.error('本地缺少 ' + tp + '，跳过'); continue; }
    if (it.type === 'json-merge') {
      const local = JSON.parse(readIfExists(tp) || '{}');
      const redacted = redactForCapture(local, it.secrets);
      const known = (it.secrets || []).map((s) => s.placeholder);
      const leaks = safetyScan(redacted, known);
      if (leaks.length && !flags.force) {
        console.error('⛔ 检测到未声明的疑似密钥，已中止 capture：');
        for (const l of leaks) console.error('   ' + l.path);
        console.error('请把它们加入 manifest.secrets，或确知安全后加 ' + FORCE_FLAG);
        process.exitCode = 3;
        continue;
      }
      const repoObj = JSON.parse(readIfExists(rp) || '{}');
      const rows = diffJson(repoObj, redacted, []);
      console.log(renderJsonDiff(rows));
      if (flags.dryRun) continue;
      if (rows.length && !(await confirm(flags, '写回 repo 模板 ' + it.repo + '?'))) { console.log('跳过'); continue; }
      atomicWrite(rp, JSON.stringify(redacted, null, 2) + '\n');
      console.log('已写回 ' + it.repo);
    } else {
      console.log(fileDiff(rp, tp) || '(无差异)');
      if (flags.dryRun) continue;
      if (!(await confirm(flags, '用本地覆盖 repo ' + it.repo + '?'))) { console.log('跳过'); continue; }
      if (it.type === 'dir') copyDir(tp, rp);
      else atomicWrite(rp, fs.readFileSync(tp));
      console.log('已写回 ' + it.repo);
    }
  }
}

function usage() {
  console.log('用法: node sync.js <list|diff|apply|capture> [id...] [--yes] [--dry-run]');
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { ids, flags } = parseArgs(rest);
  let manifest;
  try { manifest = loadManifest(REPO); }
  catch (e) { console.error(e.message); process.exit(1); }

  if (cmd === 'list') return cmdList(manifest);
  const items = selectItems(manifest, ids);
  if (cmd === 'diff') return cmdDiff(items);
  if (cmd === 'apply') return cmdApply(items, flags);
  if (cmd === 'capture') return cmdCapture(items, flags);
  usage();
  process.exit(2);
}

main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sync.test.js`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add sync.js test/sync.test.js
git commit -m "feat(sync): add CLI (list/diff/apply/capture)"
```

---

## Task 9: README 更新（statusline 数据来源 + 顶层配置同步章）

**Files:**
- Modify: `statuslines/context-usage-bar/README.md`
- Modify: `README.md`

- [ ] **Step 1: statusline README 加「数据来源 / 运行依赖」章节**

在 `statuslines/context-usage-bar/README.md` 的「依赖」章节后插入：

````markdown
## 数据来源 / 运行依赖

Claude Code 每次刷新状态栏时，把当前会话 JSON 经 **stdin** 传给本脚本。各显示项的来源：

| 显示项 | 来源字段 | 由谁提供 |
|--------|----------|----------|
| 模型名 | `model.display_name` | 当前会话选定模型 |
| 目录 | `workspace.current_dir` / `cwd` | 会话工作区 |
| 上下文占用 | `context_window.used_percentage` / `total_input_tokens` / `context_window_size` | Claude Code 的 token 计量（来自 API usage） |
| 本次花费 | `cost.total_cost_usd` | 会话成本（API token × 定价） |
| 套餐 5h/7d | `rate_limits.five_hour` / `seven_day` 的 `used_percentage` + `resets_at` | **仅 Claude.ai Pro/Max 订阅**，来自 API 限流响应头，**首次 API 响应后**才有；API-key/Console 计费用户无此字段 |
| git 分支/dirty | —— 不来自 Claude Code | 脚本自跑 `git status` / 读 `.git/HEAD` |

**安装条件：** ① Node.js 在 PATH；② `settings.json` 已注册 `statusLine`；③ 数据依赖 Claude Code 的 statusLine stdin 契约（见[官方文档](https://code.claude.com/docs/en/statusline)）；④ 第 3 行仅在订阅账户、且本次会话已有过 API 响应后出现。
````

- [ ] **Step 2: 顶层 README 加「配置同步」章节**

在 `README.md` 的「仓库内容」表后插入：

````markdown
## 🔄 配置同步（多设备）

用 `sync.js`（纯 Node、零依赖）在多设备间分发本仓配置。以 `manifest.json` 为注册表，密钥走**模板占位**——真密钥永不进仓。

```bash
node sync.js list                 # 看有哪些项、各自同步状态
node sync.js diff [id...]          # 只看差异，不改文件
node sync.js apply [id...]         # repo → 本地（带 diff 确认；保留本地真密钥）
node sync.js capture [id...]       # 本地 → repo（自动把真密钥剥离成占位；写前安全扫描）
```

**新机部署：** `git clone` → `node sync.js apply` → 按提示填入各密钥（脚本会列出去哪取）。
**回灌改动：** 改完本地配置 → `node sync.js capture` → `git commit`。

> `capture` 写回前会扫描"未声明的疑似密钥"，命中即中止，避免真值漏进公开仓。
````

- [ ] **Step 3: 跑全量测试 + CLI 冒烟**

Run:
```bash
node --test test/sync.test.js && node sync.js list
```
Expected: 测试全 PASS；`list` 打出 statusline / settings 两项及状态。

- [ ] **Step 4: Commit**

```bash
git add README.md statuslines/context-usage-bar/README.md
git commit -m "docs: document statusline data sources + config-sync workflow"
```

---

## Self-Review 结论

- **Spec 覆盖**：密钥模板占位→Task 4/7；双向 apply/capture→Task 8；单文件 Node CLI→Task 8；键级合并保密钥→Task 3；安全扫描→Task 4/8；diff→Task 6；原子写+备份→Task 2；测试→Task 1-8；README 数据来源+同步章→Task 9；`lib/` 拆分→Task 1-6。
- **占位扫描**：无 TBD/TODO；每个 code step 含完整代码。
- **类型一致性**：`mergeForApply`→`{merged, reminders}`、`diffJson`→`[{path,kind,from?,to?}]`、`safetyScan`/`scanText`→`[{path,value}]`、`itemStatus`→字符串枚举、`renderJsonDiff(rows)`→字符串——全计划一致引用。
- **安全**：所有子进程用 `execFileSync`/`spawnSync` 数组参数，不经 shell。
- **已知裁剪**：skills/keybindings 项推迟到有实际内容时再进 manifest（Task 7 说明），不影响端到端验证。
```
