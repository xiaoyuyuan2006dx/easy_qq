const path = require('path');
const fs = require('fs');

const PORT = 18080;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');
const LOCAL_FILES_DIR = path.join(DATA_DIR, 'local_files');
const LOCAL_FILE_ROOT = process.env.LOCAL_FILE_ROOT || LOCAL_FILES_DIR;
const FIXED_LOCAL_RULE = { host: '127.0.0.1', port: PORT, token: '', fixed: true };
const FIXED_GLOBAL_RULE = { host: '0.0.0.0', port: PORT, token: '', fixed: true };
const VERSION_DATE = '2026-05-22';
const VERSION_REVISION = 38;
const VERSION_STAMP = `v${VERSION_DATE}.${VERSION_REVISION}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// ensure data directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });
if (!fs.existsSync(LOCAL_FILES_DIR)) fs.mkdirSync(LOCAL_FILES_DIR, { recursive: true });

let PINYIN_DICT = {};
try {
  const raw = fs.readFileSync(path.join(PUBLIC_DIR, 'pinyin_dict.json'), 'utf8');
  const parsed = JSON.parse(raw);
  PINYIN_DICT = parsed && typeof parsed === 'object' ? parsed : {};
} catch {
  PINYIN_DICT = {};
}

module.exports = {
  PORT, PUBLIC_DIR, DATA_DIR, DATA_FILE, UPLOAD_DIR, EXPORT_DIR,
  LOCAL_FILES_DIR, LOCAL_FILE_ROOT, FIXED_LOCAL_RULE, FIXED_GLOBAL_RULE,
  VERSION_DATE, VERSION_REVISION, VERSION_STAMP, MIME, PINYIN_DICT,
};
