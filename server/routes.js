const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const config = require('./config');
const { state, sseClients, runtime } = require('./state');
const { saveState, getAccessRules } = require('./state');
const { nowSec, convKey, json, sanitizeFileName } = require('./utils');
const { saveUploadStream, toFileUrl, guessFileNameFromData } = require('./file-utils');
const { getUploadBaseUrl } = require('./network');
const { downloadImage, downloadBinary } = require('./download');
const { readBody, broadcast } = require('./request');
const { isWhitelisted, ensureConversation, upsertConversationsFromList, normalizeSegmentsToText, parseHistory, appendMessage } = require('./message');
const { buildUploadFileParams, callOneBot, resolveFileUrl } = require('./onebot-rpc');
const { canManageAccessToken, maskToken, formatShanghaiTime, appendAuditLog, checkAccess, extractClientIp } = require('./access');
const { serveStatic } = require('./static');

function createRequestHandler() {
  return async (req, res) => {
    try {
      const pathname = req.url.split('?')[0];
      const access = checkAccess(req, pathname);
      if (!access.ok) return json(res, access.code || 403, { error: access.error || 'forbidden' });

      // --- static /files/ serving (uploads + local_files, auth-free) ---
      if (req.method === 'GET' && pathname.startsWith('/files/')) {
        const rawName = decodeURIComponent(pathname.slice('/files/'.length));
        // allow plain filenames and simple relative paths; reject traversal
        const segments = rawName.replace(/\\/g, '/').split('/').filter(Boolean);
        if (!segments.length || segments.some((s) => s === '.' || s === '..' || !s.trim())) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }
        const safeRel = segments.join('/');
        // try uploads first (flat), then local_files (may have subdirs)
        let filePath = path.join(config.UPLOAD_DIR, segments[segments.length - 1]);
        if (!fs.existsSync(filePath)) {
          const altPath = path.join(config.LOCAL_FILE_ROOT, safeRel);
          const rootResolved = path.resolve(config.LOCAL_FILE_ROOT);
          if (altPath.startsWith(rootResolved) && fs.existsSync(altPath) && !fs.statSync(altPath).isDirectory()) {
            filePath = altPath;
          }
        }
        if (!filePath.startsWith(path.resolve(config.UPLOAD_DIR)) && !filePath.startsWith(path.resolve(config.LOCAL_FILE_ROOT))) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }
        if (!fs.existsSync(filePath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const contentType =
          config.MIME[ext] ||
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
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      // --- /backend/image-proxy ---
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

      // --- /backend/health ---
      if (req.method === 'GET' && pathname === '/backend/health') {
        const clientIp = extractClientIp(req);
        return json(res, 200, {
          ok: true,
          mode: 'napcat-reverse-ws',
          napcat: runtime.napcatInfo,
          port: config.PORT,
          localIp: require('./state').preferredLanIp,
          localIps: require('./state').localIps,
          clientIp,
          clientIpRaw: String(req.socket.remoteAddress || ''),
          wsToken: state.wsToken,
          versionStamp: config.VERSION_STAMP,
          accessToken: state.accessToken,
          loginFailures: state.loginFailures || 0,
          tokenManageAllowed: true,
          uiSettings: state.uiSettings || { bgImageUrl: '/files/default.png', bgOpacity: 100, bgPosX: 50, bgPosY: 20, selfMsgColor: '#ffe4a8' },
          accessRules: getAccessRules(),
        });
      }

      // --- /backend/ui-settings ---
      if (req.method === 'GET' && pathname === '/backend/ui-settings') {
        const settings = state.uiSettings && typeof state.uiSettings === 'object'
          ? { bgImageUrl: String(state.uiSettings.bgImageUrl || '/files/default.png'), bgOpacity: Number(state.uiSettings.bgOpacity || 100), bgPosX: Number(state.uiSettings.bgPosX || 50), bgPosY: Number(state.uiSettings.bgPosY || 20), selfMsgColor: String(state.uiSettings.selfMsgColor || '#ffe4a8'), chatTheme: String(state.uiSettings.chatTheme || '柔和') }
          : { bgImageUrl: '/files/default.png', bgOpacity: 100, bgPosX: 50, bgPosY: 20, selfMsgColor: '#ffe4a8', chatTheme: '柔和' };
        return json(res, 200, { data: settings });
      }

      if (req.method === 'POST' && pathname === '/backend/ui-settings') {
        const body = await readBody(req);
        const bgImageUrl = String((body && body.bgImageUrl) || '').trim();
        const bgOpacity = Math.max(5, Math.min(100, Number((body && body.bgOpacity) || 100)));
        const bgPosX = Math.max(0, Math.min(100, Number((body && body.bgPosX) || 50)));
        const bgPosY = Math.max(0, Math.min(100, Number((body && body.bgPosY) || 20)));
        const selfMsgColor = String((body && body.selfMsgColor) || '#ffe4a8').trim();
        state.uiSettings = {
          bgImageUrl,
          bgOpacity,
          bgPosX,
          bgPosY,
          selfMsgColor: /^#[0-9a-fA-F]{6}$/.test(selfMsgColor) ? selfMsgColor : '#ffe4a8',
        };
        saveState();
        return json(res, 200, { ok: true, data: state.uiSettings });
      }

      // --- /backend/profiles ---
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

      // --- /backend/devices ---
      if (req.method === 'GET' && pathname === '/backend/devices') {
        return json(res, 200, {
          data: state.devices,
          rules: getAccessRules(),
          accessToken: state.accessToken,
          tokenManageAllowed: true,
        });
      }

      // --- /backend/logs/audit ---
      if (req.method === 'GET' && pathname === '/backend/logs/audit') {
        return json(res, 200, { data: Array.isArray(state.auditLogs) ? state.auditLogs.slice(-1000) : [] });
      }

      // --- /backend/access-token ---
      if (req.method === 'POST' && pathname === '/backend/access-token') {
        const body = await readBody(req);
        const token = String(body.token || '').trim();
        if (!token || token.length < 4) return json(res, 400, { error: 'token must be at least 4 characters' });
        const oldToken = state.accessToken;
        state.accessToken = token;
        appendAuditLog('info', 'access_token_updated', req, {
          oldToken: maskToken(oldToken),
          newToken: maskToken(token),
        });
        saveState();
        return json(res, 200, { ok: true, accessToken: state.accessToken, rules: getAccessRules() });
      }

      // --- /backend/access-rules (deprecated) ---
      if ((req.method === 'POST' || req.method === 'DELETE') && pathname === '/backend/access-rules') {
        return json(res, 410, { error: 'access-rules removed, use /backend/access-token' });
      }

      // --- /backend/ws-token ---
      if (req.method === 'POST' && pathname === '/backend/ws-token') {
        const body = await readBody(req);
        const token = String(body.token || '').trim();
        if (!token) return json(res, 400, { error: 'token required' });
        const changed = token !== state.wsToken;
        state.wsToken = token;
        saveState();
        if (changed && runtime.napcatSocket) {
          try { runtime.napcatSocket.end(); } catch {}
          try { runtime.napcatSocket.destroy(); } catch {}
          runtime.napcatSocket = null;
          runtime.napcatInfo.connected = false;
          for (const [k, p] of runtime.pendingRpc.entries()) {
            runtime.pendingRpc.delete(k);
            p.reject(new Error('NapCat WS 已断开（wsToken已更新）'));
          }
          broadcast({ type: 'system', text: 'napcat_disconnected' });
        }
        return json(res, 200, { ok: true, wsToken: state.wsToken });
      }

      // --- /backend/whitelist ---
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

      // --- /backend/conversations ---
      if (req.method === 'GET' && pathname === '/backend/conversations') {
        return json(res, 200, { data: state.conversations });
      }

      // --- /backend/friends ---
      if (req.method === 'GET' && pathname === '/backend/friends') {
        const rpc = await callOneBot('get_friend_list', {});
        const data = Array.isArray(rpc && rpc.data) ? rpc.data : [];
        upsertConversationsFromList('private', data, 'user_id', 'nickname');
        saveState();
        return json(res, 200, { data, raw: rpc });
      }

      // --- /backend/groups ---
      if (req.method === 'GET' && pathname === '/backend/groups') {
        const rpc = await callOneBot('get_group_list', {});
        const data = Array.isArray(rpc && rpc.data) ? rpc.data : [];
        upsertConversationsFromList('group', data, 'group_id', 'group_name');
        saveState();
        return json(res, 200, { data, raw: rpc });
      }

      // --- /backend/search ---
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

      // --- /backend/conversations (POST) ---
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

      // --- /backend/messages/pull ---
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

      // --- /backend/messages/send ---
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
          const selfName = runtime.napcatInfo.nickname || runtime.napcatInfo.selfId || 'self';
          sent.push({
            message_id: (raw.message && raw.message.data && raw.message.data.message_id) || `local_${Date.now()}`,
            time: nowSec(),
            type,
            id: String(id),
            user_id: String(runtime.napcatInfo.selfId || ''),
            sender: selfName,
            segments: msgSegs,
            text: normalizeSegmentsToText(msgSegs),
          });
        }

        for (const fileSeg of fileSegs) {
          const upload = buildUploadFileParams(type, id, fileSeg);
          if (!upload) continue;
          const displayData = fileSeg && fileSeg.data && typeof fileSeg.data === 'object'
            ? { ...fileSeg.data }
            : { file: upload.params.file, name: upload.params.name };
          let rpcFile = null;
          let lastErr = null;
          const fileData = fileSeg && fileSeg.data && typeof fileSeg.data === 'object' ? fileSeg.data : {};
          const originFileId = String(fileData.file_id || fileData.fileId || fileData.fileid || '').trim();
          appendAuditLog('info', 'file_send_prepare', req, {
            type, id: String(id), name: upload.params.name,
            source: String((fileData.file || '')).trim(),
            sourceUrl: String((fileData.url || '')).trim(),
            fileId: originFileId,
          });
          const fileSendAttempts = [];
          const nameCandidates = Array.isArray(upload.nameVariants) && upload.nameVariants.length
            ? upload.nameVariants
            : [String(upload.params.name || '').trim()].filter(Boolean);
          const fileCandidates = [];
          fileCandidates.push(String(upload.params.file || ''));
          if (upload.localPath) {
            fileCandidates.push(String(upload.localPath));
            fileCandidates.push(toFileUrl(upload.localPath));
            fileCandidates.push(String(upload.localPath).replace(/\\/g, '/'));
            const baseUrl = getUploadBaseUrl(req);
            if (upload.localPath.startsWith(config.LOCAL_FILE_ROOT)) {
              const relPath = path.relative(config.LOCAL_FILE_ROOT, upload.localPath);
              fileCandidates.push(`${baseUrl}/files/${encodeURIComponent(relPath)}`);
            }
            if (upload.localPath.startsWith(config.UPLOAD_DIR)) {
              const fname = path.basename(upload.localPath);
              fileCandidates.push(`${baseUrl}/files/${encodeURIComponent(fname)}`);
            }
          }
          const seenFileRef = new Set();
          for (const fileRefRaw of fileCandidates) {
            const fileRef = String(fileRefRaw || '').trim();
            if (!fileRef || seenFileRef.has(fileRef)) continue;
            seenFileRef.add(fileRef);
            for (const nameCandidateRaw of nameCandidates) {
              const nameCandidate = String(nameCandidateRaw || '').trim();
              if (!nameCandidate) continue;
              fileSendAttempts.push({
                action: upload.action,
                params: { ...upload.params, file: fileRef, name: nameCandidate },
              });
            }
          }
          appendAuditLog('info', 'file_send_attempt_plan', req, {
            type, id: String(id), name: upload.params.name, fileId: originFileId,
            attempts: fileSendAttempts.map((x) => ({
              action: x.action,
              file: String(x.params && x.params.file || ''),
              name: String(x.params && x.params.name || ''),
            })),
          });
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
              appendAuditLog('info', 'file_send_try', req, {
                type, id: String(id), action: attempt.action, name: upload.params.name, fileId: originFileId,
                file: String((attempt.params && attempt.params.file) || ''),
                name: String((attempt.params && attempt.params.name) || ''),
              });
              rpcFile = await callOneBot(attempt.action, attempt.params);
              appendAuditLog('info', 'file_send_success', req, {
                type, id: String(id), action: attempt.action, name: upload.params.name, fileId: originFileId,
                file: String((attempt.params && attempt.params.file) || ''),
                name: String((attempt.params && attempt.params.name) || ''),
                retcode: Number((rpcFile && rpcFile.retcode) || 0),
              });
              break;
            } catch (err) {
              lastErr = err;
              appendAuditLog('error', 'file_send_attempt_failed', req, {
                type, id: String(id), action: attempt.action, name: upload.params.name, fileId: originFileId,
                file: String((attempt.params && attempt.params.file) || ''),
                name: String((attempt.params && attempt.params.name) || ''),
                error: String((err && err.message) || err || ''),
              });
            }
          }
          if (!rpcFile) throw (lastErr || new Error('文件发送失败'));
          raw.files.push(rpcFile);
          sent.push({
            message_id: `local_file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            time: nowSec(),
            type,
            id: String(id),
            user_id: String(runtime.napcatInfo.selfId || ''),
            sender: runtime.napcatInfo.nickname || runtime.napcatInfo.selfId || 'self',
            segments: [{ type: 'file', data: displayData }],
            text: '[文件]',
          });
        }

        ensureConversation(type, id, type === 'group' ? `群${id}` : `QQ${id}`);
        sent.forEach((msg) => appendMessage(msg));
        return json(res, 200, { ok: true, data: sent[sent.length - 1] || null, list: sent, raw });
      }

      // --- /backend/upload ---
      if (req.method === 'POST' && pathname === '/backend/upload') {
        const urlObj = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${config.PORT}`}`);
        const kind = String(urlObj.searchParams.get('kind') || '').trim().toLowerCase();
        const filenameHint = String(urlObj.searchParams.get('name') || '').trim();
        const fallback = kind === 'image' ? 'image.bin' : 'file.bin';
        const safeName = sanitizeFileName(filenameHint, fallback);
        const ext = path.extname(safeName);
        const finalName = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext || ''}`;
        const filePath = path.join(config.UPLOAD_DIR, finalName);
        await saveUploadStream(req, filePath);
        if (kind === 'image') {
          try {
            const localCopy = path.join(config.LOCAL_FILE_ROOT, finalName);
            fs.copyFileSync(filePath, localCopy);
          } catch {}
        }
        return json(res, 200, {
          ok: true,
          name: safeName,
          stored: finalName,
          url: `${getUploadBaseUrl(req)}/files/${finalName}`,
          relativeUrl: `/files/${finalName}`,
        });
      }

      // --- /backend/files/url ---
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

      // --- /backend/files/download ---
      if (req.method === 'GET' && pathname === '/backend/files/download') {
        const urlObj = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${config.PORT}`}`);
        const type = String(urlObj.searchParams.get('type') || '').trim();
        const id = String(urlObj.searchParams.get('id') || '').trim();
        if (!(type === 'group' || type === 'private') || !id) {
          return json(res, 400, { error: 'invalid conversation' });
        }
        const data = {
          file_id: String(urlObj.searchParams.get('file_id') || '').trim(),
          fileId: String(urlObj.searchParams.get('fileId') || '').trim(),
          fileid: String(urlObj.searchParams.get('fileid') || '').trim(),
          busid: String(urlObj.searchParams.get('busid') || '').trim(),
          file_busid: String(urlObj.searchParams.get('file_busid') || '').trim(),
          fileBusid: String(urlObj.searchParams.get('fileBusid') || '').trim(),
          file: String(urlObj.searchParams.get('file') || '').trim(),
          url: String(urlObj.searchParams.get('url') || '').trim(),
          name: String(urlObj.searchParams.get('name') || '').trim(),
        };
        const fileName = guessFileNameFromData(data, `file_${Date.now()}.bin`);
        let resolved, downloaded;
        try {
          resolved = await resolveFileUrl(type, id, data);
          downloaded = await downloadBinary(resolved);
        } catch (e) {
          return json(res, 502, { error: `download failed: ${e.message}`, url: resolved || '' });
        }
        appendAuditLog('info', 'file_download_proxy', req, {
          type, id: String(id), fileId: String(data.file_id || data.fileId || data.fileid || ''),
          name: fileName, resolvedUrlHost: (() => { try { return new URL(resolved).host; } catch { return ''; } })(),
        });
        appendAuditLog('info', 'file_download_done', req, {
          type, id: String(id), fileId: String(data.file_id || data.fileId || data.fileid || ''),
          name: fileName,
          bytes: Number((downloaded && downloaded.buffer && downloaded.buffer.length) || 0),
          contentType: String((downloaded && downloaded.contentType) || 'application/octet-stream'),
          disposition: `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        });
        res.writeHead(200, {
          'Content-Type': downloaded.contentType || 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'Cache-Control': 'no-store',
        });
        res.end(downloaded.buffer);
        return;
      }

      // --- /backend/files/copy-to-local ---
      if (req.method === 'POST' && pathname === '/backend/files/copy-to-local') {
        const body = await readBody(req);
        const type = String((body && body.type) || '').trim();
        const id = String((body && body.id) || '').trim();
        if (!(type === 'group' || type === 'private') || !id) {
          return json(res, 400, { error: 'invalid conversation' });
        }
        const fileData = {
          file_id: String((body && body.file_id) || '').trim(),
          busid: String((body && body.busid) || '').trim(),
        };
        const fileName = sanitizeFileName(String((body && body.name) || '').trim(), `file_${Date.now()}.bin`);
        const dirPathRaw = String((body && body.dirPath) || '').trim();
        const rootResolved = path.resolve(config.LOCAL_FILE_ROOT);
        const dirResolved = dirPathRaw ? path.resolve(dirPathRaw) : rootResolved;
        if (!dirResolved.startsWith(rootResolved)) {
          return json(res, 403, { error: 'access denied: path outside root' });
        }
        let resolved, downloaded;
        try {
          resolved = await resolveFileUrl(type, id, fileData);
          downloaded = await downloadBinary(resolved);
        } catch (e) {
          return json(res, 502, { error: `download failed: ${e.message}`, url: resolved || '' });
        }
        try {
          if (!fs.existsSync(dirResolved)) fs.mkdirSync(dirResolved, { recursive: true });
          const filePath = path.join(dirResolved, fileName);
          fs.writeFileSync(filePath, downloaded.buffer);
          appendAuditLog('info', 'file_copy_to_local', req, {
            type, id: String(id), fileId: fileData.file_id, name: fileName,
            bytes: Number(downloaded.buffer.length || 0),
            destPath: filePath,
          });
          return json(res, 200, { ok: true, path: filePath });
        } catch (e) {
          return json(res, 500, { error: `save failed: ${e.message}` });
        }
      }

      // --- /backend/logs/export ---
      if (req.method === 'POST' && pathname === '/backend/logs/export') {
        const body = await readBody(req);
        const logs = Array.isArray(body.logs) ? body.logs : [];
        const levelSet = new Set(['debug', 'info', 'warn', 'error', 'system']);
        const lines = logs.map((row) => {
          const ts = String((row && row.time) || formatShanghaiTime(new Date()));
          const levelRaw = String((row && row.level) || 'info').toLowerCase();
          const level = levelSet.has(levelRaw) ? levelRaw : 'info';
          const text = String((row && row.text) || '');
          return `[${ts}] [${level.toUpperCase()}] ${text}`;
        });
        const fname = `logs_${Date.now()}.txt`;
        const fpath = path.join(config.EXPORT_DIR, fname);
        fs.writeFileSync(fpath, `${lines.join('\n')}\n`, 'utf8');
        return json(res, 200, { ok: true, file: `data/exports/${fname}` });
      }

      // --- /backend/files/local ---
      if (req.method === 'GET' && pathname === '/backend/files/local') {
        const urlObj = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${config.PORT}`}`);
        let dirPath = String(urlObj.searchParams.get('path') || '').trim();
        const rootResolved = path.resolve(config.LOCAL_FILE_ROOT);
        if (!dirPath) dirPath = rootResolved;
        const resolved = path.resolve(dirPath);
        if (!resolved.startsWith(rootResolved)) {
          return json(res, 403, { error: 'access denied: path outside root' });
        }
        try {
          if (!fs.existsSync(resolved)) return json(res, 404, { error: 'path not found' });
          const dirStat = fs.statSync(resolved);
          if (!dirStat.isDirectory()) return json(res, 400, { error: 'not a directory' });
          const dirents = fs.readdirSync(resolved, { withFileTypes: true });
          const items = dirents.map((entry) => {
            const fullPath = path.join(resolved, entry.name);
            let size = 0;
            let mtime = 0;
            try {
              const st = fs.statSync(fullPath);
              size = st.size;
              mtime = Math.floor(st.mtimeMs);
            } catch {}
            return { name: entry.name, type: entry.isDirectory() ? 'folder' : 'file', size, mtime, path: fullPath };
          }).sort((a, b) => {
            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
            return a.name.localeCompare(b.name, 'zh-CN');
          });
          const parent = resolved === rootResolved ? null : path.dirname(resolved);
          return json(res, 200, { path: resolved, parent, root: rootResolved, entries: items });
        } catch (err) {
          if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
            return json(res, 403, { error: '该目录无权限访问（系统保护）' });
          }
          return json(res, 500, { error: err.message });
        }
      }

      // --- /backend/files/local/mkdir ---
      if (req.method === 'POST' && pathname === '/backend/files/local/mkdir') {
        const body = await readBody(req);
        const dirPath = String((body && body.path) || '').trim();
        const rootResolved = path.resolve(config.LOCAL_FILE_ROOT);
        if (!dirPath) return json(res, 400, { error: 'path required' });
        const resolved = path.resolve(dirPath);
        if (!resolved.startsWith(rootResolved)) return json(res, 403, { error: 'access denied: path outside root' });
        try {
          if (!fs.existsSync(resolved)) {
            fs.mkdirSync(resolved, { recursive: true });
            return json(res, 200, { ok: true });
          }
          return json(res, 400, { error: 'path already exists' });
        } catch (err) {
          return json(res, 500, { error: err.message });
        }
      }

      // --- /backend/files/local/download ---
      if (req.method === 'GET' && pathname === '/backend/files/local/download') {
        const urlObj = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${config.PORT}`}`);
        const filePath = String(urlObj.searchParams.get('path') || '').trim();
        if (!filePath) return json(res, 400, { error: 'path required' });
        const rootResolved = path.resolve(config.LOCAL_FILE_ROOT);
        const resolved = path.resolve(rootResolved, filePath);
        if (!resolved.startsWith(rootResolved))
          return json(res, 403, { error: 'access denied: path outside root' });
        if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory())
          return json(res, 404, { error: 'file not found' });
        const ext = path.extname(resolved).toLowerCase();
        const ctMap = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.svg':'image/svg+xml' };
        const fileName = path.basename(resolved);
        res.writeHead(200, {
          'Content-Type': ctMap[ext] || 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(resolved).pipe(res);
        return;
      }

      // --- /backend/files/local/rename ---
      if (req.method === 'POST' && pathname === '/backend/files/local/rename') {
        const body = await readBody(req);
        const oldPath = String((body && body.path) || '').trim();
        const newName = sanitizeFileName(String((body && body.newName) || ''), 'renamed');
        if (!oldPath || !newName) return json(res, 400, { error: 'path and newName required' });
        const rootResolved = path.resolve(config.LOCAL_FILE_ROOT);
        const oldResolved = path.resolve(oldPath);
        if (!oldResolved.startsWith(rootResolved))
          return json(res, 403, { error: 'access denied: path outside root' });
        if (!fs.existsSync(oldResolved))
          return json(res, 404, { error: 'source not found' });
        const newPath = path.join(path.dirname(oldResolved), newName);
        const newResolved = path.resolve(newPath);
        if (!newResolved.startsWith(rootResolved))
          return json(res, 403, { error: 'access denied: new path outside root' });
        fs.renameSync(oldResolved, newResolved);
        return json(res, 200, { ok: true, path: newResolved });
      }

      // --- /backend/files/local/save ---
      if (req.method === 'POST' && pathname === '/backend/files/local/save') {
        const body = await readBody(req);
        const dirPath = String((body && body.dirPath) || '').trim();
        const fileName = sanitizeFileName(String((body && body.fileName) || '').trim(), 'file.bin');
        const content = String((body && body.content) || '').trim();
        if (!fileName || !content) return json(res, 400, { error: 'fileName and content required' });
        const rootResolved = path.resolve(config.LOCAL_FILE_ROOT);
        const dirResolved = dirPath ? path.resolve(dirPath) : rootResolved;
        if (!dirResolved.startsWith(rootResolved))
          return json(res, 403, { error: 'access denied: path outside root' });
        try {
          if (!fs.existsSync(dirResolved)) fs.mkdirSync(dirResolved, { recursive: true });
          const filePath = path.join(dirResolved, fileName);
          fs.writeFileSync(filePath, Buffer.from(content, 'base64'));
          return json(res, 200, { ok: true, path: filePath });
        } catch (err) {
          return json(res, 500, { error: err.message });
        }
      }

      // --- /backend/files/group ---
      if (req.method === 'GET' && pathname === '/backend/files/group') {
        const urlObj = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${config.PORT}`}`);
        const groupId = String(urlObj.searchParams.get('group_id') || '').trim();
        const folderId = String(urlObj.searchParams.get('folder_id') || '').trim();
        if (!groupId) return json(res, 400, { error: 'group_id required' });
        try {
          let rpc;
          if (folderId) {
            rpc = await callOneBot('get_group_files_by_folder', { group_id: Number(groupId), folder_id: folderId });
          } else {
            rpc = await callOneBot('get_group_root_files', { group_id: Number(groupId) });
          }
          return json(res, 200, { ok: true, data: (rpc && rpc.data) || { files: [], folders: [] } });
        } catch (err) {
          return json(res, 502, { error: err.message || 'NapCat 调用失败' });
        }
      }

      // --- /backend/files/group/mkdir ---
      if (req.method === 'POST' && pathname === '/backend/files/group/mkdir') {
        const body = await readBody(req);
        const groupId = String((body && body.group_id) || '').trim();
        const folderName = String((body && body.folder_name) || '').trim();
        if (!groupId || !folderName) return json(res, 400, { error: 'group_id and folder_name required' });
        try {
          const params = { group_id: Number(groupId), folder_name: folderName };
          if (body && body.parent_id) params.parent_id = String(body.parent_id);
          const rpc = await callOneBot('create_group_file_folder', params);
          return json(res, 200, { ok: true, data: (rpc && rpc.data) || {} });
        } catch (err) {
          return json(res, 500, { error: err.message });
        }
      }

      // --- /backend/files/group/delete ---
      if (req.method === 'POST' && pathname === '/backend/files/group/delete') {
        const body = await readBody(req);
        const groupId = String((body && body.group_id) || '').trim();
        const fileId = String((body && body.file_id) || '').trim();
        const isFolder = !!(body && body.is_folder);
        if (!groupId || !fileId) return json(res, 400, { error: 'group_id and file_id required' });
        try {
          if (isFolder) {
            await callOneBot('delete_group_folder', { group_id: Number(groupId), folder_id: fileId });
          } else {
            await callOneBot('delete_group_file', { group_id: Number(groupId), file_id: fileId });
          }
          return json(res, 200, { ok: true });
        } catch (err) {
          return json(res, 500, { error: err.message });
        }
      }

      // --- /backend/files/group/rename ---
      if (req.method === 'POST' && pathname === '/backend/files/group/rename') {
        const body = await readBody(req);
        const groupId = String((body && body.group_id) || '').trim();
        const fileId = String((body && body.file_id) || '').trim();
        const newName = String((body && body.new_name) || '').trim();
        const curDir = String((body && body.current_parent_directory) || '/').trim();
        if (!groupId || !fileId || !newName) return json(res, 400, { error: 'group_id, file_id and new_name required' });
        try {
          await callOneBot('rename_group_file', {
            group_id: Number(groupId), file_id: fileId,
            current_parent_directory: curDir || '/', new_name: newName,
          });
          return json(res, 200, { ok: true });
        } catch (err) {
          return json(res, 500, { error: (err && err.message) || '重命名失败' });
        }
      }

      // --- /backend/files/group/move ---
      if (req.method === 'POST' && pathname === '/backend/files/group/move') {
        const body = await readBody(req);
        const groupId = String((body && body.group_id) || '').trim();
        const fileId = String((body && body.file_id) || '').trim();
        const curDir = String((body && body.current_parent_directory) || '/').trim();
        const targetDir = String((body && body.target_parent_directory) || '/').trim();
        if (!groupId || !fileId) return json(res, 400, { error: 'group_id and file_id required' });
        try {
          await callOneBot('move_group_file', {
            group_id: Number(groupId), file_id: fileId,
            current_parent_directory: curDir || '/', target_parent_directory: targetDir || '/',
          });
          return json(res, 200, { ok: true });
        } catch (err) {
          return json(res, 500, { error: (err && err.message) || '移动失败' });
        }
      }

      // --- /backend/events (SSE) ---
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
      try {
        appendAuditLog('error', 'http_request_failed', req, {
          method: String(req.method || ''),
          url: String(req.url || ''),
          error: String((err && err.message) || err || ''),
        });
      } catch {}
      return json(res, 500, { error: err.message || 'internal error' });
    }
  };
}

module.exports = { createRequestHandler };
