const { URL } = require('url');
const config = require('./config');
const { state, localIps } = require('./state');
const { saveState } = require('./state');
const { nowSec } = require('./utils');

function parseHost(req) {
  const hostHeader = String(req.headers.host || '').trim();
  const fallbackPort = config.PORT;
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
  const urlObj = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${config.PORT}`}`);
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

function formatShanghaiTime(d) {
  const shanghaiStr = d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${shanghaiStr}.${ms}+08:00`;
}

function appendAuditLog(level, action, req, detail = {}) {
  const parsed = parseHost(req);
  const host = normalizeHost(parsed.host);
  const row = {
    id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    time: formatShanghaiTime(new Date()),
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
  const isLocalFixed = host === '127.0.0.1' && port === config.PORT;
  if (isLocalFixed) {
    touchDevice(req, pathname, true, isUpgrade);
    return { ok: true, rule: config.FIXED_LOCAL_RULE };
  }
  if (port !== config.PORT) {
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
    return { ok: true, rule: { ...config.FIXED_GLOBAL_RULE, token: state.accessToken } };
  }
  const isWsUpgrade = isUpgrade && pathname === '/ws';
  if (!isWsUpgrade && state.accessToken) {
    const token = getAccessToken(req);
    if (token !== state.accessToken) {
      state.loginFailures = (state.loginFailures || 0) + 1;
      saveState();
      touchDevice(req, pathname, false, isUpgrade);
      return { ok: false, code: 401, error: 'invalid access token' };
    }
  }
  // reset failures on successful authenticated access
  if (!isStaticPage && state.accessToken && state.loginFailures > 0) {
    state.loginFailures = 0;
    saveState();
  }
  touchDevice(req, pathname, true, isUpgrade);
  return { ok: true, rule: { ...config.FIXED_GLOBAL_RULE, token: state.accessToken } };
}

module.exports = {
  parseHost, normalizeHost, canManageAccessToken, getAccessToken,
  normalizeIp, extractClientIp, touchDevice, maskToken,
  formatShanghaiTime, appendAuditLog, checkAccess,
};
