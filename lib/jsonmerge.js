'use strict';
const { expandTildeInValue, contractHomeInValue } = require('./paths');

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

function getByPath(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setByPath(obj, dotPath, value) {
  const keys = dotPath.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (o[k] == null) o[k] = {};
    else if (typeof o[k] !== 'object') {
      throw new TypeError('setByPath: 中间节点 "' + keys.slice(0, i + 1).join('.') + '" 不是对象');
    }
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}
function hasPath(obj, dotPath) {
  const keys = dotPath.split('.');
  let o = obj;
  for (const k of keys) {
    if (o == null || typeof o !== 'object' || !(k in o)) return false;
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

// apply 用。opts.keys（白名单 dot-path 数组）存在时，只把白名单内的路径从 template 覆盖到 local；
// 否则沿用整体 deepMerge。opts.pathFields 内的路径在取自 template 后做 ~→home 展开。
// 密钥路径保留本地真值（缺失则写占位并收集 reminders）；有白名单时只处理白名单内的密钥。
function mergeForApply(template, local, secrets, opts) {
  opts = opts || {};
  const keys = opts.keys;
  const pathFields = new Set(opts.pathFields || []);
  const localObj = local || {};
  let merged;
  if (keys && keys.length) {
    merged = clone(localObj);
    for (const p of keys) {
      if (!hasPath(template, p)) continue;
      let v = getByPath(template, p);
      if (pathFields.has(p)) v = expandTildeInValue(v);
      setByPath(merged, p, v);
    }
  } else {
    merged = deepMerge(localObj, template);
    for (const p of pathFields) {
      if (hasPath(merged, p)) setByPath(merged, p, expandTildeInValue(getByPath(merged, p)));
    }
  }
  const reminders = [];
  for (const s of (secrets || [])) {
    if (keys && keys.length && !keys.includes(s.path)) continue;
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

// capture 用（白名单项）。从 repoTemplate 克隆起步（保留名单外的 repo 键），
// 再把白名单内的路径从 local 写入：密钥→占位，pathField→contractHomeInValue，其余原值。
function buildCaptureTemplate(repoTemplate, local, secrets, opts) {
  opts = opts || {};
  const keys = opts.keys || [];
  const pathFields = new Set(opts.pathFields || []);
  const secretByPath = new Map((secrets || []).map((s) => [s.path, s]));
  const out = clone(repoTemplate || {});
  for (const p of keys) {
    if (!hasPath(local, p)) continue;
    let v;
    if (secretByPath.has(p)) v = secretByPath.get(p).placeholder;
    else {
      v = getByPath(local, p);
      if (pathFields.has(p)) v = contractHomeInValue(v);
    }
    setByPath(out, p, v);
  }
  return out;
}

module.exports = { getByPath, setByPath, hasPath, deepMerge, mergeForApply, flatten, diffJson, clone, buildCaptureTemplate };
