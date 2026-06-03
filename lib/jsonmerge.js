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
