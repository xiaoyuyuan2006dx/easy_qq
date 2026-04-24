const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { URL } = require('url');

const PORT = 18080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');
const FIXED_LOCAL_RULE = { host: '127.0.0.1', port: PORT, token: '', fixed: true };
const FIXED_GLOBAL_RULE = { host: '0.0.0.0', port: PORT, token: '', fixed: true };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

const state = loadState();
const sseClients = new Set();
let napcatSocket = null;
let napcatInfo = { connected: false, since: 0, selfId: '', name: '' };
const pendingRpc = new Map();
let rpcSeq = 1;
const localIps = getLocalIpv4List();
const preferredLanIp = localIps[0] || '';

function nowSec() { return Math.floor(Date.now() / 1000); }
function convKey(type, id) { return `${type}:${String(id)}`; }
function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sanitizeFileName(name, fallback = 'file.bin') {
  const base = String(name || '').split('/').pop().split('\\').pop().trim();
  const safe = base.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  return safe || fallback;
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

function getBaseUrl(req) {
  const host = String(req.headers.host || `127.0.0.1:${PORT}`).trim();
  return `http://${host}`;
}

function getLocalIpv4List() {
  const out = [];
  const nets = os.networkInterfaces ? os.networkInterfaces() : {};
  for (const key of Object.keys(nets || {})) {
    const rows = Array.isArray(nets[key]) ? nets[key] : [];
    for (const row of rows) {
      if (!row || row.internal) continue;
      const family = String(row.family || '');
      if (!(family === 'IPv4' || family === '4')) continue;
      const address = String(row.address || '').trim();
      if (!address || address.startsWith('169.254.')) continue;
      out.push(address);
    }
  }
  return Array.from(new Set(out));
}

function getUploadBaseUrl(req) {
  if (preferredLanIp) return `http://${preferredLanIp}:${PORT}`;
  return getBaseUrl(req);
}

function downloadByHttp(targetUrl) {
  return new Promise((resolve, reject) => {
    let current = targetUrl;
    let hops = 0;
    const requestOnce = (urlStr) => {
      const lib = /^https:/i.test(urlStr) ? https : http;
      const req = lib.get(urlStr, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (easy_qq image-proxy)',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          Referer: (() => {
            try {
              const u = new URL(urlStr);
              return `${u.protocol}//${u.host}/`;
            } catch {
              return '';
            }
          })(),
        },
      }, (resp) => {
        const status = Number(resp.statusCode || 0);
        const location = String(resp.headers.location || '');
        if ([301, 302, 303, 307, 308].includes(status) && location && hops < 3) {
          hops += 1;
          try {
            current = new URL(location, urlStr).toString();
            resp.resume();
            requestOnce(current);
            return;
          } catch (e) {
            reject(e);
            return;
          }
        }
        if (status < 200 || status >= 300) {
          reject(new Error(`upstream ${status || 500}`));
          resp.resume();
          return;
        }
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => {
          resolve({
            contentType: String(resp.headers['content-type'] || 'image/jpeg'),
            buffer: Buffer.concat(chunks),
          });
        });
      });
      req.on('error', reject);
      req.setTimeout(12000, () => req.destroy(new Error('upstream timeout')));
    };
    requestOnce(current);
  });
}

async function downloadImage(targetUrl) {
  if (typeof fetch === 'function') {
    const upstream = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (easy_qq image-proxy)',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: (() => {
          try {
            const u = new URL(targetUrl);
            return `${u.protocol}//${u.host}/`;
          } catch {
            return '';
          }
        })(),
      },
    });
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    return {
      contentType: upstream.headers.get('content-type') || 'image/jpeg',
      buffer: Buffer.from(await upstream.arrayBuffer()),
    };
  }
  return downloadByHttp(targetUrl);
}

function defaultState() {
  return {
    wsToken: 'napcat_ws_token',
    accessToken: '',
    uiSettings: { bgImageUrl: '', selfMsgColor: '#dbeafe' },
    activeProfile: 'default',
    profiles: {
      default: { whitelist: [], realtimeSet: {}, unread: {}, conversationKeys: [] },
    },
    whitelist: [],
    conversations: [],
    messages: {},
    devices: [],
    auditLogs: [],
  };
}

function getAccessRules() {
  return [
    { ...FIXED_LOCAL_RULE },
    { ...FIXED_GLOBAL_RULE, token: String(state.accessToken || '').trim() },
  ];
}

function loadState() {
  if (!fs.existsSync(DATA_FILE)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const rules = Array.isArray(parsed.accessRules) ? parsed.accessRules : [];
    const legacyRule = rules.find((x) => String((x && x.host) || '').toLowerCase() === '0.0.0.0' && Number((x && x.port)) === PORT);
    return {
      wsToken: String(parsed.wsToken || 'napcat_ws_token'),
      accessToken: String(parsed.accessToken || (legacyRule && legacyRule.token) || '').trim(),
      uiSettings: parsed.uiSettings && typeof parsed.uiSettings === 'object'
        ? {
          bgImageUrl: String(parsed.uiSettings.bgImageUrl || ''),
          selfMsgColor: String(parsed.uiSettings.selfMsgColor || '#dbeafe'),
        }
        : { bgImageUrl: '', selfMsgColor: '#dbeafe' },
      activeProfile: String(parsed.activeProfile || 'default'),
      profiles: parsed.profiles && typeof parsed.profiles === 'object'
        ? parsed.profiles
        : { default: { whitelist: [], realtimeSet: {}, unread: {}, conversationKeys: [] } },
      whitelist: Array.isArray(parsed.whitelist) ? parsed.whitelist : [],
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
      messages: parsed.messages && typeof parsed.messages === 'object' ? parsed.messages : {},
      devices: Array.isArray(parsed.devices) ? parsed.devices.slice(0, 200) : [],
      auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs.slice(-2000) : [],
    };
  } catch {
    return defaultState();
  }
}

function saveState() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) client.write(line);
}

function isWhitelisted(type, id) {
  return state.whitelist.some((w) => w.type === type && String(w.id) === String(id));
}

function ensureConversation(type, id, name = '') {
  const keyId = String(id);
  const idx = state.conversations.findIndex((c) => c.type === type && String(c.id) === keyId);
  if (idx >= 0) {
    if (name && !state.conversations[idx].name) state.conversations[idx].name = name;
  } else {
    state.conversations.push({ type, id: keyId, name });
  }
}

function upsertConversationsFromList(type, list, idKey, nameKey) {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    const id = item && item[idKey];
    if (id === undefined || id === null) continue;
    const name = String((item && item[nameKey]) || '');
    ensureConversation(type, id, name);
  }
}

function normalizeSegmentsToText(segments, raw) {
  if (typeof raw === 'string' && raw) return raw;
  if (!Array.isArray(segments)) return '';
  return segments.map((seg) => {
    if (seg.type === 'text') return (seg.data && seg.data.text) || '';
    if (seg.type === 'at') return `@${(seg.data && (seg.data.qq || seg.data.id)) || ''}`;
    if (seg.type === 'image') return '[图片]';
    if (seg.type === 'file') return '[文件]';
    return `[${seg.type || 'segment'}]`;
  }).join('');
}

function parseCqData(rawData) {
  const out = {};
  String(rawData || '').split(',').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) return;
    out[key] = decodeURIComponent(value.replace(/&#44;/g, ',').replace(/&amp;/g, '&'));
  });
  return out;
}

function normalizeIncomingSegments(message, rawMessage) {
  if (Array.isArray(message)) return message;
  const raw = String(rawMessage || '');
  if (!raw) return [];
  const out = [];
  const regex = /\[CQ:([a-zA-Z0-9_]+),([^\]]*)\]/g;
  let last = 0;
  let match;
  while ((match = regex.exec(raw))) {
    const before = raw.slice(last, match.index);
    if (before) out.push({ type: 'text', data: { text: before } });
    const cqType = String(match[1] || '').toLowerCase();
    const data = parseCqData(match[2] || '');
    if (cqType === 'image') out.push({ type: 'image', data });
    else if (cqType === 'file') out.push({ type: 'file', data });
    else out.push({ type: cqType || 'segment', data });
    last = match.index + match[0].length;
  }
  if (last < raw.length) out.push({ type: 'text', data: { text: raw.slice(last) } });
  if (!out.length) out.push({ type: 'text', data: { text: raw } });
  return out;
}

function appendMessage(msg) {
  const key = convKey(msg.type, msg.id);
  if (!state.messages[key]) state.messages[key] = [];
  if (msg && msg.message_id) {
    const dup = state.messages[key].some((m) => String(m.message_id || '') === String(msg.message_id));
    if (dup) return;
  }
  state.messages[key].push(msg);
  if (state.messages[key].length > 2000) state.messages[key] = state.messages[key].slice(-2000);
  saveState();
  if (isWhitelisted(msg.type, msg.id)) broadcast({ type: 'message', payload: msg });
}

function parseHistory(res, type, id) {
  const arr = (res && res.data && res.data.messages) || (res && res.messages) || (res && res.data) || [];
  if (!Array.isArray(arr)) return [];
  return arr.map((m) => ({
    message_id: m.message_id,
    time: m.time || nowSec(),
    type,
    id: String(id),
    user_id: String((m && m.user_id) || ''),
    sender: (m.sender && m.sender.card) || (m.sender && m.sender.nickname) || String(m.user_id || 'unknown'),
    segments: normalizeIncomingSegments(m.message, m.raw_message),
    text: normalizeSegmentsToText(normalizeIncomingSegments(m.message, m.raw_message), m.raw_message),
  }));
}

function wsSendText(socket, text) {
  const payload = Buffer.from(text);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function decodeFrames(socket, chunk) {
  socket._buf = socket._buf ? Buffer.concat([socket._buf, chunk]) : Buffer.from(chunk);
  while (socket._buf.length >= 2) {
    const b1 = socket._buf[0];
    const b2 = socket._buf[1];
    const opcode = b1 & 0x0f;
    const masked = (b2 & 0x80) !== 0;
    let len = b2 & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (socket._buf.length < offset + 2) return;
      len = socket._buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (socket._buf.length < offset + 8) return;
      const v = socket._buf.readBigUInt64BE(offset);
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) return;
      len = Number(v);
      offset += 8;
    }

    const maskLen = masked ? 4 : 0;
    if (socket._buf.length < offset + maskLen + len) return;

    let payload = socket._buf.subarray(offset + maskLen, offset + maskLen + len);
    if (masked) {
      const mask = socket._buf.subarray(offset, offset + 4);
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
      payload = out;
    }

    socket._buf = socket._buf.subarray(offset + maskLen + len);

    if (opcode === 0x8) {
      socket.end();
      return;
    }
    if (opcode === 0x9) {
      socket.write(Buffer.from([0x8a, 0x00]));
      continue;
    }
    if (opcode === 0x1) {
      handleNapcatData(payload.toString('utf8'));
    }
  }
}

function handleNapcatData(text) {
  let data;
  try { data = JSON.parse(text); } catch { return; }

  if (data.echo && pendingRpc.has(String(data.echo))) {
    const handler = pendingRpc.get(String(data.echo));
    pendingRpc.delete(String(data.echo));
    handler.resolve(data);
    return;
  }

  if (data.post_type === 'meta_event' && data.meta_event_type === 'lifecycle') {
    napcatInfo.selfId = String(data.self_id || napcatInfo.selfId || '');
    broadcast({ type: 'system', text: 'napcat_lifecycle', selfId: napcatInfo.selfId });
    return;
  }

  if (data.post_type === 'message') {
    const type = data.message_type === 'group' ? 'group' : 'private';
    const id = type === 'group' ? data.group_id : data.user_id;
    const sender = (data.sender && data.sender.card) || (data.sender && data.sender.nickname) || String(data.user_id || 'unknown');
    const incomingSegments = normalizeIncomingSegments(data.message, data.raw_message);
    ensureConversation(type, id, type === 'group' ? `群${id}` : `QQ${id}`);
    const msg = {
      message_id: data.message_id,
      time: data.time || nowSec(),
      type,
      id: String(id),
      user_id: String(data.user_id || ''),
      sender,
      segments: incomingSegments,
      text: normalizeSegmentsToText(incomingSegments, data.raw_message),
    };
    appendMessage(msg);
  }
}

function buildUploadFileParams(type, id, fileSeg) {
  const source = String((fileSeg && fileSeg.data && fileSeg.data.file) || '').trim();
  if (!source) return null;
  let name = String((fileSeg && fileSeg.data && fileSeg.data.name) || '').trim();
  if (!name) {
    try {
      if (/^https?:\/\//i.test(source)) {
        const pathname = new URL(source).pathname || '';
        name = path.basename(pathname) || `file_${Date.now()}`;
      } else {
        name = path.basename(source) || `file_${Date.now()}`;
      }
    } catch {
      name = `file_${Date.now()}`;
    }
  }
  if (type === 'group') return { action: 'upload_group_file', params: { group_id: Number(id), file: source, name } };
  return { action: 'upload_private_file', params: { user_id: Number(id), file: source, name } };
}

function callOneBot(action, params = {}) {
  return new Promise((resolve, reject) => {
    if (!napcatSocket) return reject(new Error('NapCat reverse WS 未连接'));
    const echo = `e_${rpcSeq++}_${Date.now()}`;
    const timer = setTimeout(() => {
      pendingRpc.delete(echo);
      reject(new Error(`调用超时: ${action}`));
    }, 8000);

    pendingRpc.set(echo, {
      resolve: (data) => {
        clearTimeout(timer);
        const status = String((data && data.status) || '').toLowerCase();
        const retcode = Number((data && data.retcode) || 0);
        if (status === 'failed' || retcode !== 0) {
          const msg = String((data && (data.msg || data.wording || data.message)) || '').trim();
          reject(new Error(msg || `OneBot 调用失败: ${action} (retcode=${retcode || 'unknown'})`));
          return;
        }
        resolve(data);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    wsSendText(napcatSocket, JSON.stringify({ action, params, echo }));
  });
}

function extractUrlFromRpcData(data) {
  if (!data) return '';
  if (typeof data === 'string' && /^https?:\/\//i.test(data)) return data;
  const candidates = [
    data.url,
    data.file_url,
    data.download_url,
    data.downloadUrl,
    data.fileUrl,
  ];
  for (const value of candidates) {
    const v = String(value || '').replace(/&amp;/g, '&').trim();
    if (/^https?:\/\//i.test(v)) return v;
  }
  return '';
}

async function resolveFileUrl(type, id, fileData = {}) {
  const direct = String(fileData.url || fileData.file || '').replace(/&amp;/g, '&').trim();
  if (/^https?:\/\//i.test(direct)) return direct;
  const fileId = String(fileData.file_id || fileData.fileId || fileData.fileid || '').trim();
  if (!fileId) throw new Error('file_id 缺失，无法向 NapCat 取下载链接');

  const attempts = [];
  if (type === 'private') {
    attempts.push({ action: 'get_private_file_url', params: { user_id: Number(id), file_id: fileId } });
  }
  if (type === 'group') {
    attempts.push({
      action: 'get_group_file_url',
      params: {
        group_id: Number(id),
        file_id: fileId,
        busid: Number(fileData.busid || fileData.file_busid || fileData.fileBusid || 0),
      },
    });
  }
  attempts.push({ action: 'get_file', params: { file_id: fileId } });
  attempts.push({ action: 'get_file_url', params: { file_id: fileId } });

  let lastErr = new Error('无法解析文件下载链接');
  for (const attempt of attempts) {
    try {
      const rpc = await callOneBot(attempt.action, attempt.params);
      const url = extractUrlFromRpcData(rpc && rpc.data);
      if (url) return url;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function parseHost(req) {
  const hostHeader = String(req.headers.host || '').trim();
  const fallbackPort = PORT;
  if (!hostHeader) return { host: '', port: fallbackPort };
  if (hostHeader.startsWith('[')) {
    const idx = hostHeader.indexOf(']');
    const host = idx > 0 ? hostHeader.slice(1, idx) : hostHeader;
    const rest = hostHeader.slice(idx + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : fallbackPort;
    return { host, port: Number.isInteger(port) && port > 0 ? port : fallbackPort };
  }
  const parts = hostHeader.split(':');
  if (parts.length >= 2) {
    const port = Number(parts[parts.length - 1]);
    const host = parts.slice(0, -1).join(':');
    return { host, port: Number.isInteger(port) && port > 0 ? port : fallbackPort };
  }
  return { host: hostHeader, port: fallbackPort };
}

function normalizeHost(host) {
  const value = String(host || '').toLowerCase();
  if (value === 'localhost' || value === '::1' || value === '[::1]') return '127.0.0.1';
  return String(host || '');
}

function canManageAccessToken(req) {
  const parsed = parseHost(req);
  const host = normalizeHost(parsed.host);
  const clientIp = extractClientIp(req);
  const hostAllowed = host === '127.0.0.1' || localIps.includes(host);
  const clientAllowed = clientIp === '127.0.0.1' || clientIp === '::1' || localIps.includes(clientIp);
  return hostAllowed && clientAllowed;
}

function getAccessToken(req) {
  const urlObj = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  return String(
    urlObj.searchParams.get('access_token') ||
    req.headers['x-access-token'] ||
    req.headers['access_token'] ||
    ''
  ).trim();
}

function normalizeIp(ip) {
  const value = String(ip || '').trim();
  if (!value) return '';
  if (value.startsWith('::ffff:')) return value.slice(7);
  if (value === '::1') return '127.0.0.1';
  const percent = value.indexOf('%');
  return percent > 0 ? value.slice(0, percent) : value;
}

function extractClientIp(req) {
  const candidates = [
    String(req.headers['cf-connecting-ip'] || '').trim(),
    String(req.headers['x-real-ip'] || '').trim(),
    String(req.headers['x-client-ip'] || '').trim(),
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(),
    String(req.socket.remoteAddress || '').trim(),
  ].map(normalizeIp).filter(Boolean);
  return candidates[0] || '';
}

function touchDevice(req, pathname, accepted, viaWs = false) {
  const parsed = parseHost(req);
  const host = normalizeHost(parsed.host);
  const port = parsed.port;
  const ip = extractClientIp(req);
  const ua = String(req.headers['user-agent'] || 'unknown');
  const key = `${ip}|${host}|${port}|${ua}`;
  let row = state.devices.find((d) => d.key === key);
  if (!row) {
    row = { key, ip, host, port, ua, lastPath: pathname, lastSeen: nowSec(), count: 0, accepted: false, viaWs: false };
    state.devices.unshift(row);
  }
  row.lastPath = pathname;
  row.lastSeen = nowSec();
  row.count += 1;
  row.accepted = accepted;
  row.viaWs = row.viaWs || viaWs;
  state.devices = state.devices.slice(0, 200);
  saveState();
}

function maskToken(token) {
  const value = String(token || '');
  if (!value) return '';
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function appendAuditLog(level, action, req, detail = {}) {
  const parsed = parseHost(req);
  const host = normalizeHost(parsed.host);
  const row = {
    id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    time: new Date().toISOString(),
    level: String(level || 'info').toLowerCase(),
    action: String(action || 'unknown'),
    ip: extractClientIp(req),
    host,
    port: parsed.port,
    ua: String(req.headers['user-agent'] || 'unknown'),
    detail,
  };
  state.auditLogs.push(row);
  if (state.auditLogs.length > 2000) state.auditLogs = state.auditLogs.slice(-2000);
  saveState();
}

function checkAccess(req, pathname, isUpgrade = false) {
  const parsed = parseHost(req);
  const host = normalizeHost(parsed.host);
  const port = parsed.port;
  const isLocalFixed = host === '127.0.0.1' && port === PORT;
  if (isLocalFixed) {
    touchDevice(req, pathname, true, isUpgrade);
    return { ok: true, rule: FIXED_LOCAL_RULE };
  }
  if (port !== PORT) {
    touchDevice(req, pathname, false, isUpgrade);
    return { ok: false, code: 403, error: `invalid target port: ${host}:${port}` };
  }
  const isStaticPage = !isUpgrade && req.method === 'GET' && (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/app.js' ||
    pathname === '/styles.css' ||
    pathname === '/favicon.ico' ||
    !pathname.startsWith('/backend/')
  );
  if (isStaticPage) {
    touchDevice(req, pathname, true, isUpgrade);
    return { ok: true, rule: { ...FIXED_GLOBAL_RULE, token: state.accessToken } };
  }
  const isWsUpgrade = isUpgrade && pathname === '/ws';
  if (!isWsUpgrade && state.accessToken) {
    const token = getAccessToken(req);
    if (token !== state.accessToken) {
      touchDevice(req, pathname, false, isUpgrade);
      return { ok: false, code: 401, error: 'invalid access token' };
    }
  }
  touchDevice(req, pathname, true, isUpgrade);
  return { ok: true, rule: { ...FIXED_GLOBAL_RULE, token: state.accessToken } };
}

function serveStatic(req, res) {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const safePath = path.normalize(reqPath).replace(/^\.\.(\/|\\|$)/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = req.url.split('?')[0];
    const access = checkAccess(req, pathname);
    if (!access.ok) return json(res, access.code || 403, { error: access.error || 'forbidden' });

    if (req.method === 'GET' && pathname.startsWith('/files/')) {
      const rawName = pathname.slice('/files/'.length);
      const safeName = sanitizeFileName(rawName, '');
      if (!safeName || safeName !== rawName) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      const filePath = path.join(UPLOAD_DIR, safeName);
      if (!filePath.startsWith(UPLOAD_DIR) || !fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType =
        MIME[ext] ||
        ({
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.bmp': 'image/bmp',
          '.svg': 'image/svg+xml',
          '.pdf': 'application/pdf',
          '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }[ext] || 'application/octet-stream');
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (req.method === 'GET' && pathname === '/backend/image-proxy') {
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
      const params = new URLSearchParams(query);
      const raw = params.get('url') || '';
      const target = raw.replace(/&amp;/g, '&');
      if (!target || !/^https?:\/\//i.test(target)) {
        return json(res, 400, { error: 'invalid image url' });
      }
      try {
        const downloaded = await downloadImage(target);
        res.writeHead(200, {
          'Content-Type': downloaded.contentType,
          'Cache-Control': 'no-store',
        });
        res.end(downloaded.buffer);
      } catch (e) {
        return json(res, 502, { error: e.message || 'image proxy failed' });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/backend/health') {
      const clientIp = extractClientIp(req);
      const tokenManageAllowed = canManageAccessToken(req);
      return json(res, 200, {
        ok: true,
        mode: 'napcat-reverse-ws',
        napcat: napcatInfo,
        port: PORT,
        localIp: preferredLanIp,
        localIps,
        clientIp,
        clientIpRaw: String(req.socket.remoteAddress || ''),
        wsToken: state.wsToken,
        accessToken: tokenManageAllowed ? state.accessToken : '',
        tokenManageAllowed,
        uiSettings: state.uiSettings || { bgImageUrl: '', selfMsgColor: '#dbeafe' },
        accessRules: getAccessRules(),
      });
    }

    if (req.method === 'GET' && pathname === '/backend/ui-settings') {
      return json(res, 200, { data: state.uiSettings || { bgImageUrl: '', selfMsgColor: '#dbeafe' } });
    }

    if (req.method === 'POST' && pathname === '/backend/ui-settings') {
      const body = await readBody(req);
      const bgImageUrl = String((body && body.bgImageUrl) || '').trim();
      const selfMsgColor = String((body && body.selfMsgColor) || '#dbeafe').trim();
      state.uiSettings = { bgImageUrl, selfMsgColor: /^#[0-9a-fA-F]{6}$/.test(selfMsgColor) ? selfMsgColor : '#dbeafe' };
      saveState();
      return json(res, 200, { ok: true, data: state.uiSettings });
    }

    if (req.method === 'GET' && pathname === '/backend/profiles') {
      return json(res, 200, {
        data: state.profiles && typeof state.profiles === 'object'
          ? state.profiles
          : { default: { whitelist: [], realtimeSet: {}, unread: {}, conversationKeys: [] } },
        activeProfile: String(state.activeProfile || 'default'),
      });
    }

    if (req.method === 'POST' && pathname === '/backend/profiles') {
      const body = await readBody(req);
      const incoming = body && typeof body.profiles === 'object' ? body.profiles : {};
      const normalized = {};
      for (const [name, profile] of Object.entries(incoming)) {
        const key = String(name || '').trim();
        if (!key) continue;
        const p = profile && typeof profile === 'object' ? profile : {};
        normalized[key] = {
          whitelist: Array.isArray(p.whitelist) ? p.whitelist : [],
          realtimeSet: p.realtimeSet && typeof p.realtimeSet === 'object' ? p.realtimeSet : {},
          unread: p.unread && typeof p.unread === 'object' ? p.unread : {},
          conversationKeys: Array.isArray(p.conversationKeys) ? p.conversationKeys.map(String) : [],
        };
      }
      if (!normalized.default) {
        normalized.default = { whitelist: [], realtimeSet: {}, unread: {}, conversationKeys: [] };
      }
      const activeProfile = String(body.activeProfile || state.activeProfile || 'default');
      state.profiles = normalized;
      state.activeProfile = normalized[activeProfile] ? activeProfile : 'default';
      saveState();
      return json(res, 200, { ok: true, data: state.profiles, activeProfile: state.activeProfile });
    }

    if (req.method === 'GET' && pathname === '/backend/devices') {
      const tokenManageAllowed = canManageAccessToken(req);
      return json(res, 200, {
        data: state.devices,
        rules: getAccessRules(),
        accessToken: tokenManageAllowed ? state.accessToken : '',
        tokenManageAllowed,
      });
    }

    if (req.method === 'GET' && pathname === '/backend/logs/audit') {
      return json(res, 200, { data: Array.isArray(state.auditLogs) ? state.auditLogs.slice(-1000) : [] });
    }

    if (req.method === 'POST' && pathname === '/backend/access-token') {
      if (!canManageAccessToken(req)) {
        appendAuditLog('warn', 'access_token_update_denied', req, {
          reason: 'forbidden host',
        });
        return json(res, 403, { error: 'forbidden: only localhost or local-ip host can manage access token' });
      }
      const body = await readBody(req);
      const token = String(body.token || '').trim();
      const oldToken = state.accessToken;
      state.accessToken = token;
      appendAuditLog('info', 'access_token_updated', req, {
        oldToken: maskToken(oldToken),
        newToken: maskToken(token),
      });
      saveState();
      return json(res, 200, { ok: true, accessToken: state.accessToken, rules: getAccessRules() });
    }

    if ((req.method === 'POST' || req.method === 'DELETE') && pathname === '/backend/access-rules') {
      return json(res, 410, { error: 'access-rules removed, use /backend/access-token' });
    }

    if (req.method === 'POST' && pathname === '/backend/ws-token') {
      const body = await readBody(req);
      const token = String(body.token || '').trim();
      if (!token) return json(res, 400, { error: 'token required' });
      const changed = token !== state.wsToken;
      state.wsToken = token;
      saveState();
      if (changed && napcatSocket) {
        try { napcatSocket.end(); } catch {}
        try { napcatSocket.destroy(); } catch {}
        napcatSocket = null;
        napcatInfo.connected = false;
        for (const [k, p] of pendingRpc.entries()) {
          pendingRpc.delete(k);
          p.reject(new Error('NapCat WS 已断开（wsToken已更新）'));
        }
        broadcast({ type: 'system', text: 'napcat_disconnected' });
      }
      return json(res, 200, { ok: true, wsToken: state.wsToken });
    }

    if (req.method === 'GET' && pathname === '/backend/whitelist') {
      return json(res, 200, { data: state.whitelist });
    }

    if (req.method === 'POST' && pathname === '/backend/whitelist') {
      const body = await readBody(req);
      const list = Array.isArray(body.data) ? body.data : [];
      state.whitelist = list
        .filter((x) => x && (x.type === 'group' || x.type === 'private') && String(x.id).trim())
        .map((x) => ({ type: x.type, id: String(x.id) }));
      saveState();
      return json(res, 200, { ok: true, data: state.whitelist });
    }

    if (req.method === 'GET' && pathname === '/backend/conversations') {
      return json(res, 200, { data: state.conversations });
    }

    if (req.method === 'GET' && pathname === '/backend/friends') {
      const rpc = await callOneBot('get_friend_list', {});
      const data = Array.isArray(rpc && rpc.data) ? rpc.data : [];
      upsertConversationsFromList('private', data, 'user_id', 'nickname');
      saveState();
      return json(res, 200, { data, raw: rpc });
    }

    if (req.method === 'GET' && pathname === '/backend/groups') {
      const rpc = await callOneBot('get_group_list', {});
      const data = Array.isArray(rpc && rpc.data) ? rpc.data : [];
      upsertConversationsFromList('group', data, 'group_id', 'group_name');
      saveState();
      return json(res, 200, { data, raw: rpc });
    }

    if (req.method === 'POST' && pathname === '/backend/search') {
      const body = await readBody(req);
      const type = body.type;
      const keyword = String(body.keyword || '').trim().toLowerCase();
      if (!(type === 'group' || type === 'private')) {
        return json(res, 400, { error: 'invalid type' });
      }
      const filtered = state.conversations.filter((c) => {
        if (c.type !== type) return false;
        if (!keyword) return true;
        return String(c.id).toLowerCase().includes(keyword) || String(c.name || '').toLowerCase().includes(keyword);
      });
      return json(res, 200, { data: filtered });
    }

    if (req.method === 'POST' && pathname === '/backend/conversations') {
      const body = await readBody(req);
      const type = body.type;
      const id = String(body.id || '').trim();
      const name = String(body.name || '');
      if (!(type === 'group' || type === 'private') || !id) return json(res, 400, { error: 'invalid conversation' });
      ensureConversation(type, id, name);
      saveState();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/backend/messages/pull') {
      const body = await readBody(req);
      const type = body.type;
      const id = String(body.id || '').trim();
      const limit = Math.max(1, Math.min(200, Number(body.limit || 30)));
      if (!(type === 'group' || type === 'private') || !id) return json(res, 400, { error: 'invalid conversation' });

      let rpc;
      if (type === 'group') rpc = await callOneBot('get_group_msg_history', { group_id: Number(id), count: limit });
      else rpc = await callOneBot('get_friend_msg_history', { user_id: Number(id), count: limit });

      const parsed = parseHistory(rpc, type, id);
      state.messages[convKey(type, id)] = parsed;
      ensureConversation(type, id, type === 'group' ? `群${id}` : `QQ${id}`);
      saveState();
      return json(res, 200, { data: parsed, raw: rpc });
    }

    if (req.method === 'POST' && pathname === '/backend/messages/send') {
      const body = await readBody(req);
      const type = body.type;
      const id = String(body.id || '').trim();
      const segments = Array.isArray(body.segments) ? body.segments : [];
      if (!(type === 'group' || type === 'private') || !id || segments.length === 0) {
        return json(res, 400, { error: 'invalid message payload' });
      }

      const fileSegs = segments.filter((seg) => seg && seg.type === 'file');
      const msgSegs = segments.filter((seg) => seg && seg.type !== 'file');
      const sent = [];
      const raw = { message: null, files: [] };

      if (msgSegs.length) {
        if (type === 'group') raw.message = await callOneBot('send_group_msg', { group_id: Number(id), message: msgSegs });
        else raw.message = await callOneBot('send_private_msg', { user_id: Number(id), message: msgSegs });
        sent.push({
          message_id: (raw.message && raw.message.data && raw.message.data.message_id) || `local_${Date.now()}`,
          time: nowSec(),
          type,
          id: String(id),
          user_id: String(napcatInfo.selfId || ''),
          sender: 'me',
          segments: msgSegs,
          text: normalizeSegmentsToText(msgSegs),
        });
      }

      for (const fileSeg of fileSegs) {
        const upload = buildUploadFileParams(type, id, fileSeg);
        if (!upload) continue;
        let rpcFile = null;
        let lastErr = null;
        const fileSendAttempts = [];
        fileSendAttempts.push({ action: upload.action, params: upload.params });
        if (type === 'group') {
          fileSendAttempts.push({
            action: 'send_group_msg',
            params: {
              group_id: Number(id),
              message: [{ type: 'file', data: { file: upload.params.file, name: upload.params.name } }],
            },
          });
        } else {
          fileSendAttempts.push({
            action: 'send_private_msg',
            params: {
              user_id: Number(id),
              message: [{ type: 'file', data: { file: upload.params.file, name: upload.params.name } }],
            },
          });
        }
        for (const attempt of fileSendAttempts) {
          try {
            rpcFile = await callOneBot(attempt.action, attempt.params);
            break;
          } catch (err) {
            lastErr = err;
          }
        }
        if (!rpcFile) throw (lastErr || new Error('文件发送失败'));
        raw.files.push(rpcFile);
        sent.push({
          message_id: `local_file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          time: nowSec(),
          type,
          id: String(id),
          user_id: String(napcatInfo.selfId || ''),
          sender: 'me',
          segments: [{ type: 'file', data: { file: upload.params.file, name: upload.params.name } }],
          text: '[文件]',
        });
      }

      ensureConversation(type, id, type === 'group' ? `群${id}` : `QQ${id}`);
      sent.forEach((msg) => appendMessage(msg));
      return json(res, 200, { ok: true, data: sent[sent.length - 1] || null, list: sent, raw });
    }

    if (req.method === 'POST' && pathname === '/backend/upload') {
      const urlObj = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
      const kind = String(urlObj.searchParams.get('kind') || '').trim().toLowerCase();
      const filenameHint = String(urlObj.searchParams.get('name') || '').trim();
      const fallback = kind === 'image' ? 'image.bin' : 'file.bin';
      const safeName = sanitizeFileName(filenameHint, fallback);
      const ext = path.extname(safeName);
      const finalName = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext || ''}`;
      const filePath = path.join(UPLOAD_DIR, finalName);
      await saveUploadStream(req, filePath);
      return json(res, 200, {
        ok: true,
        name: safeName,
        stored: finalName,
        url: `${getUploadBaseUrl(req)}/files/${finalName}`,
        relativeUrl: `/files/${finalName}`,
      });
    }

    if (req.method === 'POST' && pathname === '/backend/files/url') {
      const body = await readBody(req);
      const type = body.type;
      const id = String(body.id || '').trim();
      const data = body.data && typeof body.data === 'object' ? body.data : {};
      if (!(type === 'group' || type === 'private') || !id) {
        return json(res, 400, { error: 'invalid conversation' });
      }
      const url = await resolveFileUrl(type, id, data);
      return json(res, 200, { ok: true, url });
    }

    if (req.method === 'POST' && pathname === '/backend/logs/export') {
      const body = await readBody(req);
      const logs = Array.isArray(body.logs) ? body.logs : [];
      const levelSet = new Set(['debug', 'info', 'warn', 'error', 'system']);
      const lines = logs.map((row) => {
        const ts = String((row && row.time) || new Date().toISOString());
        const levelRaw = String((row && row.level) || 'info').toLowerCase();
        const level = levelSet.has(levelRaw) ? levelRaw : 'info';
        const text = String((row && row.text) || '');
        return `[${ts}] [${level.toUpperCase()}] ${text}`;
      });
      const fname = `logs_${Date.now()}.txt`;
      const fpath = path.join(EXPORT_DIR, fname);
      fs.writeFileSync(fpath, `${lines.join('\n')}\n`, 'utf8');
      return json(res, 200, { ok: true, file: `data/exports/${fname}` });
    }

    if (req.method === 'GET' && pathname === '/backend/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      sseClients.add(res);
      res.write(`data: ${JSON.stringify({ type: 'system', text: 'connected' })}\n\n`);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    return serveStatic(req, res);
  } catch (err) {
    return json(res, 500, { error: err.message || 'internal error' });
  }
});

server.on('upgrade', (req, socket) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlObj.pathname;
    const access = checkAccess(req, pathname, true);
    if (!access.ok) {
      socket.write(`HTTP/1.1 ${access.code || 403} Forbidden\r\n\r\n`);
      socket.destroy();
      return;
    }

    if (pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const auth = req.headers['authorization'] || '';
    const bearer = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : '';
    const token =
      urlObj.searchParams.get('access_token') ||
      req.headers['x-self-token'] ||
      req.headers['access_token'] ||
      bearer ||
      '';
    if (String(token) !== String(state.wsToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    if (napcatSocket && napcatSocket !== socket) {
      try { napcatSocket.destroy(); } catch {}
    }

    napcatSocket = socket;
    napcatInfo = { connected: true, since: nowSec(), selfId: napcatInfo.selfId || '', name: napcatInfo.name || '' };
    broadcast({ type: 'system', text: 'napcat_connected' });

    socket.on('data', (chunk) => decodeFrames(socket, chunk));
    socket.on('close', () => {
      if (napcatSocket === socket) napcatSocket = null;
      napcatInfo.connected = false;
      for (const [k, p] of pendingRpc.entries()) {
        pendingRpc.delete(k);
        p.reject(new Error('NapCat WS 已断开'));
      }
      broadcast({ type: 'system', text: 'napcat_disconnected' });
    });
    socket.on('error', () => {});
  } catch {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`easy_qq running at http://0.0.0.0:${PORT}`);
  console.log(`fixed local access: http://127.0.0.1:${PORT}`);
  console.log(`reverse ws endpoint: ws://127.0.0.1:${PORT}/ws?access_token=${state.wsToken}`);
});
