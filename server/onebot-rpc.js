const path = require('path');
const fs = require('fs');
const config = require('./config');
const { runtime } = require('./state');
const { sanitizeFileName, normalizeAsciiFileName, hasNonAscii } = require('./utils');
const { inferFileNameFromRef, toFileUrl } = require('./file-utils');
const { getUploadBaseUrl } = require('./network');

function buildUploadFileParams(type, id, fileSeg) {
  const source = String((fileSeg && fileSeg.data && fileSeg.data.file) || '').replace(/&amp;/g, '&').trim();
  if (!source) return null;
  let resolvedSource = source;
  let localPath = '';
  if (source.startsWith('/files/')) {
    const safeName = sanitizeFileName(source.slice('/files/'.length), '');
    if (safeName) {
      const localFilePath = path.join(config.UPLOAD_DIR, safeName);
      if (localFilePath.startsWith(config.UPLOAD_DIR) && fs.existsSync(localFilePath)) {
        localPath = localFilePath;
      }
    }
  }
  if (/^https?:\/\//i.test(source)) {
    resolvedSource = source;
  } else if (source.startsWith('/files/')) {
    resolvedSource = source;
  } else if (path.isAbsolute(resolvedSource)) {
    if (fs.existsSync(resolvedSource)) {
      localPath = resolvedSource;
      resolvedSource = toFileUrl(resolvedSource);
    } else {
      return null;
    }
  }
  let originalName = String((fileSeg && fileSeg.data && fileSeg.data.name) || '').trim();
  if (!originalName) {
    const dataFile = String((fileSeg && fileSeg.data && fileSeg.data.file) || '').trim();
    const prefer = dataFile && !/^https?:\/\//i.test(dataFile) ? dataFile : source;
    originalName = inferFileNameFromRef(prefer, `file_${Date.now()}`);
  }
  const safeOriginal = sanitizeFileName(originalName, `file_${Date.now()}`);
  const asciiName = normalizeAsciiFileName(safeOriginal, `file_${Date.now()}`);
  const encodedName = hasNonAscii(safeOriginal) ? encodeURIComponent(safeOriginal) : '';
  const nameVariants = hasNonAscii(safeOriginal)
    ? Array.from(new Set([encodedName, safeOriginal, asciiName].filter(Boolean)))
    : Array.from(new Set([safeOriginal, asciiName].filter(Boolean)));
  const name = nameVariants[0] || asciiName || `file_${Date.now()}`;
  if (type === 'group') return { action: 'upload_group_file', params: { group_id: Number(id), file: resolvedSource, name }, localPath, nameVariants };
  return { action: 'upload_private_file', params: { user_id: Number(id), file: resolvedSource, name }, localPath, nameVariants };
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

function callOneBot(action, params = {}) {
  return new Promise((resolve, reject) => {
    if (!runtime.napcatSocket) return reject(new Error('NapCat reverse WS 未连接'));
    const echo = `e_${runtime.rpcSeq++}_${Date.now()}`;
    const timer = setTimeout(() => {
      runtime.pendingRpc.delete(echo);
      reject(new Error(`调用超时: ${action}`));
    }, 8000);

    runtime.pendingRpc.set(echo, {
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

    wsSendText(runtime.napcatSocket, JSON.stringify({ action, params, echo }));
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

module.exports = { buildUploadFileParams, wsSendText, callOneBot, extractUrlFromRpcData, resolveFileUrl };
