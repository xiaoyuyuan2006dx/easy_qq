const path = require('path');
const fs = require('fs');
const { sanitizeFileName, isLikelyHashFileName } = require('./utils');
const { URL, pathToFileURL } = require('url');

function inferFileNameFromRef(ref, fallback = '') {
  const value = String(ref || '').replace(/&amp;/g, '&').trim();
  if (!value) return fallback;
  try {
    if (/^https?:\/\//i.test(value)) {
      const parsed = new URL(value);
      const qName = String(
        parsed.searchParams.get('fname')
        || parsed.searchParams.get('filename')
        || parsed.searchParams.get('name')
        || '',
      ).trim();
      if (qName) return sanitizeFileName(decodeURIComponent(qName), fallback || 'file.bin');
      const tail = decodeURIComponent(path.basename(parsed.pathname || '').trim());
      if (tail) {
        const safeTail = sanitizeFileName(tail, fallback || 'file.bin');
        if (!isLikelyHashFileName(safeTail)) return safeTail;
      }
      return fallback;
    }
  } catch {}
  const tail = String(value.split('?')[0] || '').trim();
  const safeTail = sanitizeFileName(path.basename(tail), fallback || 'file.bin');
  if (isLikelyHashFileName(safeTail)) return fallback;
  return safeTail;
}

function toFileUrl(localPath) {
  const norm = String(localPath || '').trim();
  if (!norm) return '';
  try {
    return pathToFileURL(norm).toString();
  } catch {
    const unixPath = norm.replace(/\\/g, '/');
    return unixPath.startsWith('/') ? `file://${unixPath}` : `file:///${unixPath}`;
  }
}

function saveUploadStream(req, filePath, maxBytes = 120 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(filePath);
    let size = 0;
    let finished = false;
    const fail = (err) => {
      if (finished) return;
      finished = true;
      try { ws.destroy(); } catch {}
      try { fs.unlinkSync(filePath); } catch {}
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        fail(new Error('file too large (max 120MB)'));
      }
    });
    req.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', () => {
      if (finished) return;
      finished = true;
      resolve(size);
    });
    req.pipe(ws);
  });
}

function guessFileNameFromData(data = {}, fallback = 'file.bin') {
  const direct = String(data.name || data.fname || data.filename || data.file_name || '').trim();
  if (direct) return sanitizeFileName(direct, fallback);
  const file = String(data.file || '').trim();
  if (file && !/^https?:\/\//i.test(file)) return sanitizeFileName(file, fallback);
  return inferFileNameFromRef(String(data.url || data.file || '').trim(), fallback);
}

module.exports = { inferFileNameFromRef, toFileUrl, saveUploadStream, guessFileNameFromData };
