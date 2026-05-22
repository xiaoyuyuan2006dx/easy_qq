const http = require('http');
const https = require('https');
const { URL } = require('url');

function refererForUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return '';
  }
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
          Referer: refererForUrl(urlStr),
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
    try {
      const upstream = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (easy_qq image-proxy)',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          Referer: refererForUrl(targetUrl),
        },
      });
      if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
      return {
        contentType: upstream.headers.get('content-type') || 'image/jpeg',
        buffer: Buffer.from(await upstream.arrayBuffer()),
      };
    } catch (e) {
      // fallback to http module for compatibility
      return downloadByHttp(targetUrl);
    }
  }
  return downloadByHttp(targetUrl);
}

async function downloadBinary(targetUrl) {
  if (typeof fetch === 'function') {
    try {
      const upstream = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (easy_qq file-proxy)',
          Accept: '*/*',
          Referer: refererForUrl(targetUrl),
        },
      });
      if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
      return {
        contentType: upstream.headers.get('content-type') || 'application/octet-stream',
        buffer: Buffer.from(await upstream.arrayBuffer()),
      };
    } catch (e) {
      // fallback to http module for all fetch errors (network issues, Load failed, etc.)
      try {
        return await downloadByHttpBinary(targetUrl);
      } catch (_httpErr) {
        throw e; // throw original fetch error
      }
    }
  }
  return downloadByHttpBinary(targetUrl);
}

function downloadByHttpBinary(targetUrl) {
  return new Promise((resolve, reject) => {
    let current = targetUrl;
    let hops = 0;
    const requestOnce = (urlStr) => {
      const lib = /^https:/i.test(urlStr) ? https : http;
      const req = lib.get(urlStr, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (easy_qq file-proxy)',
          Accept: '*/*',
          Referer: refererForUrl(urlStr),
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
            contentType: String(resp.headers['content-type'] || 'application/octet-stream'),
            buffer: Buffer.concat(chunks),
          });
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('upstream timeout')));
    };
    requestOnce(current);
  });
}

module.exports = { downloadByHttp, downloadByHttpBinary, downloadImage, downloadBinary };
