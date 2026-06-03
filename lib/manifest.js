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
