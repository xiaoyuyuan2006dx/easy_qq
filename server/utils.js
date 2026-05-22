const config = require('./config');

function nowSec() { return Math.floor(Date.now() / 1000); }
function convKey(type, id) { return `${type}:${String(id)}`; }
function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sanitizeFileName(name, fallback = 'file.bin') {
  const base = String(name || '').split('/').pop().split('\\').pop().trim();
  const safe = base.replace(/[^\w.\-一-龥]/g, '_');
  return safe || fallback;
}

function isLikelyHashFileName(name) {
  const value = String(name || '').trim();
  if (!value) return false;
  if (value.includes('.')) return false;
  return /^[a-f0-9]{40,}$/i.test(value);
}

function normalizeAsciiFileName(name, fallback = `file_${Date.now()}`) {
  const raw = String(name || '').trim();
  const safe = sanitizeFileName(raw, fallback);
  const dot = safe.lastIndexOf('.');
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  const pinyinBase = Array.from(base).map((ch) => {
    if (/[\x00-\x7F]/.test(ch)) return ch;
    return config.PINYIN_DICT[ch] || 'Zi';
  }).join('_');
  const asciiBase = pinyinBase
    .replace(/[^\x00-\x7F]+/g, '_')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const finalBase = String(asciiBase || '')
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('') || `File${Date.now()}`;
  return `${finalBase}${ext}`.slice(0, 180);
}

function hasNonAscii(text) {
  return /[^\x00-\x7F]/.test(String(text || ''));
}

module.exports = { nowSec, convKey, json, sanitizeFileName, isLikelyHashFileName, normalizeAsciiFileName, hasNonAscii };
