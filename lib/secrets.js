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
