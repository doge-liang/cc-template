#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadManifest } = require('./lib/manifest');
const { expandPath } = require('./lib/paths');
const { readIfExists, atomicWrite, copyDir } = require('./lib/fsutil');
const { mergeForApply, diffJson, buildCaptureTemplate } = require('./lib/jsonmerge');
const { redactForCapture, safetyScan, scanText } = require('./lib/secrets');
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

function readJson(p) {
  const raw = readIfExists(p);
  if (raw == null) return {};
  try { return JSON.parse(raw); }
  catch (e) { throw new Error('JSON 解析失败 ' + p + ': ' + e.message); }
}

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
      const tpl = readJson(repoPath(it));
      const local = readJson(targetPath(it));
      const { merged } = mergeForApply(tpl, local, it.secrets, { keys: it.keys, pathFields: it.pathFields });
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
      const tpl = readJson(rp);
      const local = readJson(tp);
      const { merged, reminders } = mergeForApply(tpl, local, it.secrets, { keys: it.keys, pathFields: it.pathFields });
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
      const local = readJson(tp);
      const repoObj = readJson(rp);
      const redacted = it.keys
        ? buildCaptureTemplate(repoObj, local, it.secrets, { keys: it.keys, pathFields: it.pathFields })
        : redactForCapture(local, it.secrets);
      const known = (it.secrets || []).map((s) => s.placeholder);
      const leaks = safetyScan(redacted, known);
      if (leaks.length && !flags.force) {
        console.error('⛔ 检测到未声明的疑似密钥，已中止 capture：');
        for (const l of leaks) console.error('   ' + l.path);
        console.error('请把它们加入 manifest.secrets，或确知安全后加 ' + FORCE_FLAG);
        process.exitCode = 3;
        continue;
      }
      const rows = diffJson(repoObj, redacted, []);
      console.log(renderJsonDiff(rows, 'capture'));
      if (flags.dryRun) continue;
      if (rows.length && !(await confirm(flags, '写回 repo 模板 ' + it.repo + '?'))) { console.log('跳过'); continue; }
      atomicWrite(rp, JSON.stringify(redacted, null, 2) + '\n');
      console.log('已写回 ' + it.repo);
    } else {
      console.log(fileDiff(rp, tp) || '(无差异)');
      if (flags.dryRun) continue;
      if (it.type === 'file') {
        const leaks = scanText(fs.readFileSync(tp, 'utf8'), []);
        if (leaks.length && !flags.force) {
          console.error('⛔ 文件中检测到疑似密钥，已中止 capture：');
          for (const l of leaks) console.error('   ' + l.path);
          console.error('确知安全后加 ' + FORCE_FLAG);
          process.exitCode = 3;
          continue;
        }
      }
      if (!(await confirm(flags, '用本地覆盖 repo ' + it.repo + '?'))) { console.log('跳过'); continue; }
      if (it.type === 'dir') copyDir(tp, rp);
      else atomicWrite(rp, fs.readFileSync(tp));
      console.log('已写回 ' + it.repo);
    }
  }
}

function usage() {
  console.log('用法: node sync.js <list|diff|apply|capture> [id...] [--yes] [--dry-run] [--force-allow-unredacted]');
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

main().catch((e) => { console.error(e.message); process.exit(1); });
