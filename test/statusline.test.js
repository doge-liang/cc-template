'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { render, vlen, shortenPath, packLine } = require('../statuslines/context-usage-bar/statusline.js');

// ---------- vlen: 可见宽度（剥 ANSI + emoji/CJK 双宽） ----------
test('vlen: 纯 ASCII 每字符 1 列', () => {
  assert.strictEqual(vlen('Opus 4.8'), 8);
});
test('vlen: 剥掉 ANSI 颜色转义后再计宽', () => {
  assert.strictEqual(vlen('\x1b[92m██\x1b[0m'), 2);
});
test('vlen: CJK 全角字符占 2 列', () => {
  assert.strictEqual(vlen('项目'), 4);
});
test('vlen: emoji 占 2 列', () => {
  assert.strictEqual(vlen('🤖'), 2);
});
test('vlen: ⏳ 沙漏 emoji 占 2 列', () => {
  assert.strictEqual(vlen('⏳'), 2);
});
test('vlen: ✓ 对勾按文本呈现占 1 列', () => {
  assert.strictEqual(vlen('✓'), 1);
});
test('vlen: 进度条方块 █░ 各占 1 列', () => {
  assert.strictEqual(vlen('██░░'), 4);
});
test('vlen: 混合 emoji+ASCII', () => {
  assert.strictEqual(vlen('🤖 Opus 4.8'), 11); // 2 + 1 + 8
});

// ---------- shortenPath: 路径压缩 ----------
test('shortenPath: 够宽时原样返回', () => {
  assert.strictEqual(shortenPath('/a/b/c', 100), '/a/b/c');
});
test('shortenPath: budget 为 Infinity 不压缩', () => {
  const p = '/mnt/d/Workspace/project/claude-code';
  assert.strictEqual(shortenPath(p, Infinity), p);
});
test('shortenPath: home 前缀缩成 ~', () => {
  const p = path.join(os.homedir(), '.claude', 'statusline.js');
  assert.strictEqual(shortenPath(p, 23), '~/.claude/statusline.js');
});
test('shortenPath: 过长时中部省略保留首尾', () => {
  assert.strictEqual(shortenPath('/mnt/d/Workspace/project/claude-code', 20), '/…/claude-code');
});
test('shortenPath: 极窄时截断末段并前置 …、不超预算', () => {
  const out = shortenPath('/very/long/directoryname', 8);
  assert.ok(out.startsWith('…'), `out=${out}`);
  assert.ok(vlen(out) <= 8, `vlen=${vlen(out)} out=${out}`);
});

// ---------- packLine: 按宽度贪心装箱 ----------
test('packLine: cols=Infinity 全部并入一行', () => {
  assert.deepStrictEqual(packLine(['a', 'bb', 'ccc'], Infinity, ' · '), ['a · bb · ccc']);
});
test('packLine: 放不下的段逐个换到下一行', () => {
  assert.deepStrictEqual(packLine(['aaa', 'bbb', 'ccc'], 7, ' · '), ['aaa', 'bbb', 'ccc']);
});
test('packLine: 能并则并、超出才换行', () => {
  assert.deepStrictEqual(packLine(['aa', 'bb', 'cc'], 7, ' · '), ['aa · bb', 'cc']);
});
test('packLine: 单段超宽仍独占一行（不拆段内部）', () => {
  assert.deepStrictEqual(packLine(['toolongsegment'], 5, ' · '), ['toolongsegment']);
});

// ---------- render: 按终端宽度折叠 ----------
// 用一个不存在的非 git 目录，避免 gitInfo 真去跑 git status 干扰断言。
const SAMPLE = {
  model: { display_name: 'Opus 4.8' },
  workspace: { current_dir: '/srv/data/workspace/acme/backend/service-api' },
  context_window: { used_percentage: 42, total_input_tokens: 84000, context_window_size: 200000 },
  cost: { total_cost_usd: 0.34 },
};
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }

test('render: 宽终端(Infinity)下模型与目录同在第一行', () => {
  const lines = render(SAMPLE, Infinity).split('\n');
  assert.match(stripAnsi(lines[0]), /Opus 4\.8/);
  assert.match(stripAnsi(lines[0]), /service-api/);
});
test('render: 窄终端比宽终端产生更多物理行', () => {
  const wide = render(SAMPLE, Infinity).split('\n').length;
  const narrow = render(SAMPLE, 30).split('\n').length;
  assert.ok(narrow > wide, `narrow=${narrow} wide=${wide}`);
});
test('render: 窄终端压缩长路径（出现 … 省略号）', () => {
  assert.match(stripAnsi(render(SAMPLE, 30)), /…/);
});
test('render: cols=40 时每个物理行可见宽都不超 40', () => {
  const cols = 40;
  for (const line of render(SAMPLE, cols).split('\n')) {
    assert.ok(vlen(line) <= cols, `vlen=${vlen(line)} > ${cols}: ${stripAnsi(line)}`);
  }
});
