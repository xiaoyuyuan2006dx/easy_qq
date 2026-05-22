const { state } = require('./state');
const { saveState } = require('./state');
const { convKey, nowSec } = require('./utils');
const { broadcast } = require('./request');
const { inferFileNameFromRef } = require('./file-utils');

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
    if (seg.type === 'reply') return '[回复]';
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
  if (Array.isArray(message)) {
    return message.map((seg) => {
      if (!seg || typeof seg !== 'object') return { type: 'segment', data: {} };
      const type = String(seg.type || 'segment').toLowerCase();
      const data = seg.data && typeof seg.data === 'object' ? { ...seg.data } : {};
      if (type === 'file' && !String(data.name || '').trim()) {
        const inferred = inferFileNameFromRef(
          data.fname || data.filename || data.file_name || data.url || data.file,
          '',
        );
        if (inferred) data.name = inferred;
      }
      return { type, data };
    });
  }
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
    if (cqType === 'file' && !String(data.name || '').trim()) {
      const inferred = inferFileNameFromRef(
        data.fname || data.filename || data.file_name || data.url || data.file,
        '',
      );
      if (inferred) data.name = inferred;
    }
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

module.exports = {
  isWhitelisted, ensureConversation, upsertConversationsFromList,
  normalizeSegmentsToText, parseCqData, normalizeIncomingSegments,
  appendMessage, parseHistory,
};
