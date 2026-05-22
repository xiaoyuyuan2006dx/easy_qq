const os = require('os');
const config = require('./config');

function getBaseUrl(req) {
  const host = String(req.headers.host || `127.0.0.1:${config.PORT}`).trim();
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
  const { preferredLanIp } = require('./state');
  if (preferredLanIp) return `http://${preferredLanIp}:${config.PORT}`;
  return getBaseUrl(req);
}

module.exports = { getBaseUrl, getLocalIpv4List, getUploadBaseUrl };
