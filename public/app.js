const state = {
  whitelist: [],
  conversations: [],
  visibleConvKeys: [],
  activeConv: '',
  messages: new Map(),
  sse: null,
  wsToken: '',
  accessToken: '',
  unread: {},
  devices: [],
  activeTab: 'console',
  localIp: '',
  pendingFileName: '',
  pendingImageRef: '',
  pendingFileRef: '',
  manageDraftKeys: [],
  manageSearchKeys: [],
  logs: [],
  auditLogs: [],
  logFilter: { debug: true, info: true, warn: true, error: true, system: true },
  custom: { bgImageUrl: '/files/default.png', bgOpacity: 100, bgPosX: 50, bgPosY: 20, selfMsgColor: '#ffe4a8' },
  authed: false,
  loginFailures: 0,
  selfId: '',
  selfNickname: '',
  fileLocalPath: '',
  fileLocalRoot: '',
  fileLocalEntries: [],
  fileGroupId: '',
  fileGroupPath: [],
  fileGroupEntries: { files: [], folders: [] },
  fileLocalSelected: new Set(),
  fileGroupSelected: new Set(),
  fileLocalMode: 'server',
  fileClientDirHandle: null,
  fileClientDirName: '',
  fileClientHandleStack: [],
  fileClientEntries: [],
  fileClientSelected: new Set(),
  fileClientWebkitPath: '',
};

const el = (id) => document.getElementById(id);
const TOKEN_KEY = 'easyqq_access_token';
const UI_CACHE_KEY = 'easyqq_ui_cache';
const URL_TOKEN = String(new URLSearchParams(window.location.search).get('access_token') || '').trim();
const REPOSITORY_URL = 'https://github.com/xiaoyuyuan2006dx/easy_qq';
const GROUP_REMOVED_HINT = '你已被移出群聊';
let PINYIN_DICT = {};

function nameWithoutExtension(filename) {
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function fileExtension(filename) {
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

function getUploaderName(entry) {
  return String(
    entry.uploader_name || entry.uploaderName || entry.uploader ||
    entry.uploader_nick || entry.uploaderNick || entry.sender_name ||
    entry.senderName || entry.owner_name || entry.ownerName ||
    entry.owner || entry.creator_name || entry.creatorName || ''
  ).trim() || '未知';
}

function toTitleCasePinyinWord(raw) {
  const text = String(raw || '');
  if (!text) return '';
  return text.split(/[_\-\s]+/).filter(Boolean).map((part) => {
    const lower = part.toLowerCase();
    return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
  }).join('');
}

async function loadPinyinDict() {
  try {
    const resp = await fetch(withAccessToken('/pinyin_dict.json'), { headers: { ...buildAuthHeaders() } });
    if (!resp.ok) return;
    const parsed = await resp.json().catch(() => ({}));
    PINYIN_DICT = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    PINYIN_DICT = {};
  }
}

function withAccessToken(path) {
  const token = getClientToken();
  if (!token) return path;
  const joiner = path.includes('?') ? '&' : '?';
  return `${path}${joiner}access_token=${encodeURIComponent(token)}`;
}

function getClientToken() {
  return String(localStorage.getItem(TOKEN_KEY) || '').trim();
}

function setClientToken(token) {
  const value = String(token || '').trim();
  if (!value) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, value);
}

function buildAuthHeaders() {
  const token = getClientToken();
  return token ? { 'x-access-token': token } : {};
}

function convKey(type, id) { return `${type}:${String(id)}`; }
function parseConvKey(key) {
  if (!key || !key.includes(':')) return null;
  const [type, id] = key.split(':');
  if (!(type === 'group' || type === 'private') || !id) return null;
  return { type, id };
}
// --- Shanghai time helpers ---
function shanghaiNow() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const [date, time] = s.split(' ');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  return { y, m, d, hh, mm, ss };
}

function formatShanghaiTime(ts) {
  const d = new Date(ts * 1000);
  const s = d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const [date, time] = s.split(' ');
  return `${date} ${time}`;
}

function formatShanghaiHHMMSS(ts) {
  const d = new Date(ts * 1000);
  const s = d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  return s.split(' ')[1];
}

function formatShanghaiDate(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).split(' ')[0];
}

function formatShanghaiFull(ts) {
  return formatShanghaiTime(ts);
}

function formatShanghaiFileTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const s = d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const [date, time] = s.split(' ');
  const hhmm = time.slice(0, 5);
  return `${date} ${hhmm}`;
}

function todayStartSec() {
  const sh = shanghaiNow();
  const start = new Date(sh.y, sh.m - 1, sh.d, 0, 0, 0);
  return Math.floor(start.getTime() / 1000);
}
function nowSec() { return Math.floor(Date.now() / 1000); }

function isMobileView() {
  return window.matchMedia && window.matchMedia('(max-width: 900px)').matches;
}

function setConn(text, ok = false, err = false) {
  const badge = el('connBadge');
  badge.textContent = text;
  badge.classList.remove('ok', 'warn', 'err');
  if (err) badge.classList.add('err');
  else badge.classList.add(ok ? 'ok' : 'warn');
}

async function api(path, method = 'GET', body) {
  const resp = await fetch(withAccessToken(path), {
    method,
    headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (resp.status === 401) {
    throw new Error('AUTH_REQUIRED');
  }
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

async function uploadLocalFile(file, kind) {
  if (!file) throw new Error('未选择文件');
  const path = withAccessToken(`/backend/upload?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(file.name || '')}`);
  const resp = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream', ...buildAuthHeaders() },
    body: file,
  });
  const data = await resp.json().catch(() => ({}));
  if (resp.status === 401) throw new Error('AUTH_REQUIRED');
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

let toastTimer = null;
function addLog(level, text) {
  state.logs.push({
    time: formatShanghaiFull(nowSec()),
    level: String(level || 'info').toLowerCase(),
    text: String(text || ''),
  });
  if (state.logs.length > 3000) state.logs = state.logs.slice(-3000);
  if (state.activeTab === 'logs') renderLogs();
}

async function refreshAuditLogsData() {
  try {
    const res = await api('/backend/logs/audit');
    const rows = Array.isArray(res && res.data) ? res.data : [];
    state.auditLogs = rows.map((row) => ({
      time: String(row.time || formatShanghaiFull(nowSec())),
      level: String((row.level || 'info')).toLowerCase(),
      text: `[server:${row.action || 'audit'}] ip=${row.ip || '-'} host=${row.host || '-'} detail=${JSON.stringify(row.detail || {})}`,
    }));
    if (state.activeTab === 'logs') renderLogs();
  } catch (_) {}
}

function getAllLogsSorted() {
  const all = [...state.logs, ...state.auditLogs];
  return all.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
}

function notify(message, type = 'ok') {
  const level = type === 'err' ? 'error' : (type === 'warn' ? 'warn' : 'info');
  addLog(level, message);
  const box = el('toast');
  box.textContent = message;
  box.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.className = 'toast'; }, 2200);
}

function showAuthModal(tip = '请输入访问Token') {
  const preset = URL_TOKEN || getClientToken();
  if (preset) el('authTokenInput').value = preset;
  if (state.loginFailures >= 3) {
    el('authTip').innerHTML = '已连续失败3次。<br><br><strong>忘记密码？</strong>请通过SSH登录服务器，编辑 <code>data/store.json</code> 文件，将 <code>accessToken</code> 字段的值改为 <code>"easyqq"</code> 即可恢复默认密码，然后重新访问此页面。';
  } else {
    el('authTip').textContent = tip;
  }
  document.body.classList.add('auth-locked');
  el('authModal').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function hideAuthModal() {
  document.body.classList.remove('auth-locked');
  el('authModal').classList.remove('show');
  document.body.style.overflow = '';
}

function showChangePasswordModal() {
  el('newPasswordInput').value = '';
  el('confirmPasswordInput').value = '';
  el('changePasswordTip').textContent = '';
  el('changePasswordModal').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function hideChangePasswordModal() {
  el('changePasswordModal').classList.remove('show');
  document.body.style.overflow = '';
}

function isAuthRequiredError(error) {
  return String((error && error.message) || '') === 'AUTH_REQUIRED';
}

async function runAction(btnId, action, pendingText = '处理中...') {
  const button = el(btnId);
  const oldText = button.textContent;
  const oldHtml = button.innerHTML;
  const isIconBtn = button.classList.contains('icon-btn');
  button.disabled = true;
  button.classList.add('btn-loading');
  if (!isIconBtn) button.textContent = pendingText;
  addLog('debug', `action start: ${btnId}`);
  try {
    await action();
    addLog('debug', `action done: ${btnId}`);
  } catch (error) {
    if (isAuthRequiredError(error)) {
      showAuthModal('Token无效或未登录，请重新输入');
      return;
    }
    addLog('error', `action failed: ${btnId} - ${(error && error.message) || 'unknown error'}`);
    notify(error.message || '操作失败', 'err');
    throw error;
  } finally {
    button.disabled = false;
    button.classList.remove('btn-loading');
    if (isIconBtn) button.innerHTML = oldHtml;
    else button.textContent = oldText;
  }
}

async function loadProfiles() {
  try {
    const raw = localStorage.getItem('easyqq_single_profile');
    const parsed = raw ? JSON.parse(raw) : {};
    state.unread = parsed.unread && typeof parsed.unread === 'object' ? parsed.unread : {};
    state.visibleConvKeys = Array.isArray(parsed.conversationKeys) ? parsed.conversationKeys.map(String) : [];
    // whitelist synced from backend first, then merged with local
    try {
      const wlRes = await api('/backend/whitelist');
      state.whitelist = Array.isArray(wlRes.data) ? wlRes.data : [];
    } catch (_) {
      state.whitelist = Array.isArray(parsed.whitelist) ? parsed.whitelist : [];
    }
  } catch (_) {}
}

function applyProfile() {
  renderConversations();
  updateRealtimeButton();
}

function saveProfileData() {
  localStorage.setItem('easyqq_single_profile', JSON.stringify({
    whitelist: state.whitelist,
    unread: state.unread,
    conversationKeys: state.visibleConvKeys,
  }));
}

function isWhitelisted(type, id) {
  return state.whitelist.some((x) => x.type === type && String(x.id) === String(id));
}

function normalizeConversationList(list) {
  const map = new Map();
  (Array.isArray(list) ? list : []).forEach((conv) => {
    if (!conv || !(conv.type === 'group' || conv.type === 'private')) return;
    const id = String(conv.id || '').trim();
    if (!id) return;
    const key = convKey(conv.type, id);
    const name = String(conv.name || '').trim();
    if (conv.type === 'group' && name.includes(GROUP_REMOVED_HINT)) return;
    if (!map.has(key)) map.set(key, { type: conv.type, id, name });
    else if (name && !map.get(key).name) map.set(key, { ...map.get(key), name });
  });
  return Array.from(map.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'private' ? -1 : 1;
    const na = Number(a.id);
    const nb = Number(b.id);
    const aNum = Number.isFinite(na) && String(na) === a.id;
    const bNum = Number.isFinite(nb) && String(nb) === b.id;
    if (aNum && bNum) return na - nb;
    return String(a.id).localeCompare(String(b.id), 'zh-CN');
  });
}

function upsertConversations(list) {
  const merged = normalizeConversationList([...(state.conversations || []), ...(list || [])]);
  state.conversations = merged;
}

function conversationLabel(conv) {
  const key = convKey(conv.type, conv.id);
  return `${key}${conv.name ? ` (${conv.name})` : ''}`;
}

function isRealtimeEnabled(conv) {
  if (!conv) return false;
  return isWhitelisted(conv.type, conv.id);
}

function renderWhitelist() {
  // whitelist items are now shown inline in the conversation list (top, accent)
}

function renderConversations() {
  const box = el('convList');
  box.innerHTML = '';
  const map = new Map(state.conversations.map((conv) => [convKey(conv.type, conv.id), conv]));
  const selected = (state.visibleConvKeys || [])
    .map((key) => map.get(key))
    .filter(Boolean);
  // sort: whitelisted first, then others
  const sorted = [...selected].sort((a, b) => {
    const aWl = isWhitelisted(a.type, a.id) ? 1 : 0;
    const bWl = isWhitelisted(b.type, b.id) ? 1 : 0;
    return bWl - aWl;
  });
  sorted.forEach((conv) => {
    const key = convKey(conv.type, conv.id);
    const item = document.createElement('div');
    const wlClass = isWhitelisted(conv.type, conv.id) ? ' conv-item wl-accent' : '';
    item.className = `item${state.activeConv === key ? ' active' : ''}${wlClass}`;
    const unread = Number(state.unread[key] || 0);
    const wlBadge = isWhitelisted(conv.type, conv.id) ? ' ●实时' : '';
    // whitelisted: show only name; others: show full type:id (name)
    const label = isWhitelisted(conv.type, conv.id) && conv.name
      ? conv.name
      : conversationLabel(conv);
    item.textContent = `${label}${unread > 0 ? `  🔔${unread}` : ''}${wlBadge}`;
    item.onclick = async () => {
      await setActiveConversation(key, true);
    };
    box.appendChild(item);
  });
  if (!sorted.length) {
    const empty = document.createElement('div');
    empty.className = 'item';
    empty.style.cursor = 'default';
    empty.textContent = '暂无显示会话，请点”管理会话”添加';
    box.appendChild(empty);
  }
  renderMobileConvSelect(sorted);
}

async function setActiveConversation(key, autoLoad = true) {
  state.activeConv = key;
  state.unread[key] = 0;
  saveProfileData();
  el('activeConv').value = key;
  const mobile = el('mobileConvSelect');
  if (mobile) mobile.value = key;
  renderConversations();
  updateRealtimeButton();
  if (autoLoad) await autoLoadOnOpen();
}

function renderMobileConvSelect(selectedList) {
  const sel = el('mobileConvSelect');
  if (!sel) return;
  const list = Array.isArray(selectedList) ? selectedList : [];
  sel.innerHTML = '';
  if (!list.length) {
    const op = document.createElement('option');
    op.value = '';
    op.textContent = '暂无会话';
    sel.appendChild(op);
    return;
  }
  list.forEach((conv) => {
    const key = convKey(conv.type, conv.id);
    const op = document.createElement('option');
    op.value = key;
    op.textContent = conversationLabel(conv);
    sel.appendChild(op);
  });
  if (!state.activeConv || !list.some((conv) => convKey(conv.type, conv.id) === state.activeConv)) {
    state.activeConv = convKey(list[0].type, list[0].id);
    el('activeConv').value = state.activeConv;
  }
  sel.value = state.activeConv;
}

function getDateLabel(ts) {
  return formatShanghaiDate(ts);
}

function renderMessages() {
  const box = el('msgArea');
  box.innerHTML = '';
  const list = state.messages.get(state.activeConv) || [];
  const messageMap = new Map();
  const userNameMap = new Map();
  list.forEach((m) => {
    if (m && m.message_id !== undefined && m.message_id !== null) {
      messageMap.set(String(m.message_id), m);
    }
    const uid = String((m && m.user_id) || '').trim();
    const uname = String(normalizedSenderName(m) || '').trim();
    if (uid && uname && !userNameMap.has(uid)) userNameMap.set(uid, uname);
  });
  let lastDateLabel = '';
  list.forEach((m) => {
    if (!state.selfNickname && String(m.sender || '').trim() && String(m.sender || '').toLowerCase() !== 'me' && isSelfMessage(m)) {
      state.selfNickname = String(m.sender || '').trim();
    }
    const curDateLabel = getDateLabel(m.time || nowSec());
    if (curDateLabel !== lastDateLabel) {
      lastDateLabel = curDateLabel;
      const sep = document.createElement('div');
      sep.className = 'date-separator';
      const label = document.createElement('span');
      label.className = 'date-label';
      label.textContent = curDateLabel;
      sep.appendChild(label);
      box.appendChild(sep);
    }
    const senderName = normalizedSenderName(m);
    const item = document.createElement('div');
    item.className = 'msg';
    item.style.setProperty('--sender-bg', senderColorBg(senderName || 'unknown'));
    if (isSelfMessage(m)) item.classList.add('self');
    const prefix = document.createElement('span');
    prefix.className = 'msg-prefix';
    // time link (click to reply)
    const timeText = formatShanghaiHHMMSS(m.time || nowSec());
    const timeLink = document.createElement('a');
    timeLink.href = '#';
    timeLink.textContent = timeText;
    timeLink.title = '点击设置回复';
    timeLink.onclick = (evt) => {
      evt.preventDefault();
      if (!m || !m.message_id) return;
      el('replyRef').value = String(m.message_id || '');
      notify(`已设置回复: ${m.message_id}`, 'ok');
    };
    prefix.appendChild(timeLink);
    prefix.appendChild(document.createTextNode(' '));
    const senderLink = document.createElement('a');
    senderLink.href = '#';
    senderLink.textContent = `${senderName}`;
    senderLink.title = '点击@此人';
    senderLink.onclick = (evt) => {
      evt.preventDefault();
      const qq = String((m && (m.user_id || (m.sender && m.sender.user_id))) || '').trim();
      if (!qq) return;
      el('atRef').value = qq;
      notify(`已填充 @${qq}`, 'ok');
    };
    prefix.appendChild(senderLink);
    prefix.appendChild(document.createTextNode(': '));
    item.appendChild(prefix);
    renderMessageContent(item, m, messageMap, userNameMap);
    box.appendChild(item);
  });
  box.scrollTop = box.scrollHeight;
  const last = box.lastElementChild;
  if (last) last.scrollIntoView({ block: 'end' });
}

function extractImageUrlFromText(text) {
  const match = String(text).match(/\[CQ:image,[^\]]*url=([^,\]]+)/i);
  if (!match || !match[1]) return '';
  return match[1].replace(/&amp;/g, '&');
}

function resolveImageUrl(seg, textFallback) {
  const data = seg && typeof seg.data === 'object' ? seg.data : {};
  const url = String(data.url || '').trim().replace(/&amp;/g, '&');
  const file = String(data.file || '').trim().replace(/&amp;/g, '&');
  if (/^https?:\/\//i.test(url)) return url;
  if (/^https?:\/\//i.test(file)) return file;
  return extractImageUrlFromText(textFallback || '');
}

function resolveFileRef(seg) {
  const data = seg && typeof seg.data === 'object' ? seg.data : {};
  const ref = String(data.url || data.file || '').trim().replace(/&amp;/g, '&');
  if (!ref) return '';
  if (/^https?:\/\//i.test(ref)) return ref;
  if (ref.startsWith('/')) return withAccessToken(ref);
  return '';
}

function buildFileDownloadLink(msg, data) {
  const params = new URLSearchParams();
  params.set('type', String((msg && msg.type) || ''));
  params.set('id', String((msg && msg.id) || ''));
  const mapKeys = ['file_id', 'fileId', 'fileid', 'busid', 'file_busid', 'fileBusid', 'file', 'url', 'name', 'fname', 'filename', 'file_name'];
  mapKeys.forEach((key) => {
    const v = String((data && data[key]) || '').trim();
    if (v) params.set(key, v);
  });
  return withAccessToken(`/backend/files/download?${params.toString()}`);
}

function openImageModal(url) {
  const modal = el('imgModal');
  const img = el('imgModalView');
  let triedDirect = false;
  img.referrerPolicy = 'no-referrer';
  img.crossOrigin = 'anonymous';
  img.onerror = () => {
    if (!triedDirect && /^https?:\/\//i.test(String(url || ''))) {
      triedDirect = true;
      img.removeAttribute('crossorigin');
      img.src = String(url);
      return;
    }
    notify('图片加载失败（代理也失败）', 'err');
  };
  img.onload = () => {};
  img.src = withAccessToken(`/backend/image-proxy?url=${encodeURIComponent(url)}`);
  modal.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeImageModal() {
  const modal = el('imgModal');
  const img = el('imgModalView');
  modal.classList.remove('show');
  img.src = '';
  document.body.style.overflow = '';
}

function senderColorBg(sender) {
  const normalized = String(sender || 'unknown');
  if (normalized.toLowerCase() === 'me' || normalized === state.selfNickname) return state.custom.selfMsgColor || '#ffe4a8';
  const theme = CHAT_THEMES.find((t) => t.name === getChatTheme()) || CHAT_THEMES[0];
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) hash = (hash * 31 + normalized.charCodeAt(i)) | 0;
  const hue = (Math.abs(hash) % 360 + (theme.hueShift || 0)) % 360;
  return `hsl(${hue}, ${theme.sat}%, ${theme.light}%)`;
}

function isSelfMessage(msg) {
  const sender = String((msg && msg.sender) || '').trim();
  const userId = String((msg && msg.user_id) || '').trim();
  if (sender.toLowerCase() === 'me') return true;
  if (state.selfNickname && sender === state.selfNickname) return true;
  if (state.selfId && userId && userId === String(state.selfId)) return true;
  return false;
}

function normalizedSenderName(msg) {
  if (isSelfMessage(msg)) {
    return String(state.selfNickname || (msg && msg.sender) || '我');
  }
  // prefer card/nickname; show QQ号 only as last resort
  const sender = String((msg && msg.sender) || 'unknown');
  const userId = String((msg && msg.user_id) || '');
  if (/^\d{5,12}$/.test(sender) && userId && sender === userId) {
    return userId; // sender is just the raw QQ号
  }
  return sender;
}

function createInlineLink(text, onClick) {
  const link = document.createElement('a');
  link.href = '#';
  link.textContent = text;
  link.onclick = async (evt) => {
    evt.preventDefault();
    try {
      await onClick();
    } catch (err) {
      notify((err && err.message) || '操作失败', 'err');
    }
  };
  return link;
}

function appendGap(container) {
  container.appendChild(document.createTextNode(' '));
}

function appendTextWithMentions(container, text) {
  const value = String(text || '');
  if (!value) return;
  const regex = /@([0-9A-Za-z_\-\u4e00-\u9fa5]+)/g;
  let last = 0;
  let match;
  while ((match = regex.exec(value))) {
    if (match.index > last) {
      container.appendChild(document.createTextNode(value.slice(last, match.index)));
    }
    const span = document.createElement('span');
    span.className = 'msg-mention';
    span.textContent = `@${match[1]}`;
    container.appendChild(span);
    last = match.index + match[0].length;
  }
  if (last < value.length) container.appendChild(document.createTextNode(value.slice(last)));
}

function summarizeReplyText(msg) {
  const raw = String((msg && msg.text) || '').trim();
  if (!raw) return '...';
  const compact = raw.replace(/\s+/g, ' ').trim();
  return compact.length > 6 ? `${compact.slice(0, 6)}...` : compact;
}

function renderMessageContent(container, msg, messageMap = new Map(), userNameMap = new Map()) {
  const text = String((msg && msg.text) || '');
  const segments = Array.isArray(msg && msg.segments) ? msg.segments : [];
  if (segments.length > 0) {
    segments.forEach((seg, index) => {
      const type = String((seg && seg.type) || '').toLowerCase();
      const data = seg && typeof seg.data === 'object' ? seg.data : {};
      if (type === 'text') {
        appendTextWithMentions(container, String(data.text || ''));
      } else if (type === 'at') {
        const qq = String(data.qq || data.id || data.uin || '').trim();
        const span = document.createElement('span');
        span.className = 'msg-mention';
        const shown = qq ? (userNameMap.get(qq) || qq) : '';
        span.textContent = shown ? `@${shown}` : '@';
        container.appendChild(span);
      } else if (type === 'reply') {
        const rid = String(data.id || data.message_id || data.msg_id || '').trim();
        const target = rid ? messageMap.get(rid) : null;
        const targetName = target ? normalizedSenderName(target) : '某用户';
        const targetText = target ? summarizeReplyText(target) : '...';
        container.appendChild(document.createTextNode(`【回复:${targetName} ${targetText}】`));
      } else if (type === 'image') {
        const imageUrl = resolveImageUrl(seg, text);
        if (imageUrl) container.appendChild(createInlineLink('【图片】', () => openImageModal(imageUrl)));
        else container.appendChild(document.createTextNode('【图片(无可访问URL)】'));
      } else if (type === 'file') {
        const ref = String(data.url || data.file || '').trim();
        const clickableRef = resolveFileRef(seg);
        let name = String(inferDisplayFileName(data) || inferFileNameFromMessageText(text) || '文件');
        if (isLikelyHashFileName(name)) {
          const fallback = String(data.file || '').trim();
          if (fallback && !isLikelyHashFileName(fallback)) name = fallback;
          else name = '未命名文件';
        }
        const downloadLink = buildFileDownloadLink(msg, data);
        if (clickableRef) {
          const fileLink = document.createElement('a');
          fileLink.href = downloadLink || clickableRef;
          fileLink.target = '_self';
          fileLink.rel = 'noopener noreferrer';
          fileLink.textContent = `【文件:${name}】`;
          container.appendChild(fileLink);
        } else if (data.file_id || data.fileId || data.fileid) {
          const fileLink = document.createElement('a');
          fileLink.href = downloadLink;
          fileLink.target = '_self';
          fileLink.rel = 'noopener noreferrer';
          fileLink.textContent = `【文件:${name}】`;
          container.appendChild(fileLink);
        } else {
          container.appendChild(document.createTextNode(`【文件:${name}】`));
        }
      } else {
        container.appendChild(document.createTextNode(`[${type || 'segment'}]`));
      }
      if (index < segments.length - 1) appendGap(container);
    });
    return;
  }

  const imageUrl = extractImageUrlFromText(text);
  if (!imageUrl) {
    appendTextWithMentions(container, text);
    return;
  }
  container.appendChild(createInlineLink('【图片】', () => openImageModal(imageUrl)));
}

function inferFileNameFromRef(ref) {
  const value = String(ref || '').trim();
  if (!value) return '';
  try {
    if (/^https?:\/\//i.test(value)) {
      const parsed = new URL(value);
      const qName = String(
        parsed.searchParams.get('fname')
        || parsed.searchParams.get('filename')
        || parsed.searchParams.get('name')
        || '',
      ).trim();
      if (qName) return decodeURIComponent(qName);
      const p = parsed.pathname || '';
      const name = decodeURIComponent((p.split('/').pop() || '').trim());
      return name || '';
    }
  } catch (_) {}
  const raw = value.split('?')[0].split('/').pop().split('\\').pop();
  return String(raw || '').trim();
}

function inferDisplayFileName(data) {
  const segData = data && typeof data === 'object' ? data : {};
  const direct = String(segData.name || segData.fname || segData.filename || segData.file_name || '').trim();
  if (direct) return direct;
  const file = String(segData.file || '').trim();
  if (file && !/^https?:\/\//i.test(file) && !file.startsWith('/')) {
    return inferFileNameFromRef(file) || file;
  }
  const fromUrl = inferFileNameFromRef(String(segData.url || '').trim());
  if (fromUrl) return fromUrl;
  return inferFileNameFromRef(file);
}

function inferFileNameFromMessageText(text) {
  const raw = String(text || '');
  if (!raw) return '';
  const m = raw.match(/\[CQ:file,[^\]]*file=([^,\]]+)/i);
  if (!m || !m[1]) return '';
  try {
    return decodeURIComponent(String(m[1]).replace(/&amp;/g, '&')).trim();
  } catch (_) {
    return String(m[1]).trim();
  }
}

function isLikelyHashFileName(name) {
  const value = String(name || '').trim();
  if (!value) return false;
  if (value.includes('.')) return false;
  return /^[a-f0-9]{40,}$/i.test(value);
}

function normalizeFileNameForSend(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const dot = raw.lastIndexOf('.');
  const base = dot > 0 ? raw.slice(0, dot) : raw;
  const ext = dot > 0 ? raw.slice(dot) : '';
  const pinyin = Array.from(base).map((ch) => {
    if (/[\x00-\x7F]/.test(ch)) return ch;
    return toTitleCasePinyinWord(PINYIN_DICT[ch] || 'Zi');
  }).join('_');
  const compact = pinyin
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const titled = toTitleCasePinyinWord(compact);
  const finalBase = titled || `File${Date.now()}`;
  const ascii = `${finalBase}${ext}`
    .replace(/[^\x00-\x7F]+/g, '_')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return ascii || `File${Date.now()}${ext}`;
}

function parseOutgoingTextSegments(text, type) {
  const content = String(text || '');
  if (!content) return [];
  if (type !== 'group') return [{ type: 'text', data: { text: content } }];
  const segments = [];
  const regex = /@(\d{5,12})/g;
  let last = 0;
  let match;
  while ((match = regex.exec(content))) {
    if (match.index > last) {
      segments.push({ type: 'text', data: { text: content.slice(last, match.index) } });
    }
    segments.push({ type: 'at', data: { qq: match[1] } });
    last = match.index + match[0].length;
  }
  if (last < content.length) {
    segments.push({ type: 'text', data: { text: content.slice(last) } });
  }
  return segments.filter((seg) => !(seg.type === 'text' && !String(seg.data && seg.data.text || '').length));
}

function dedupeMessages(list) {
  const byId = new Map();
  const contentSeen = new Set();
  const out = [];
  for (const m of list) {
    const id = String((m && m.message_id) || '').trim();
    if (id && !id.startsWith('local_') && !id.startsWith('local_file_')) {
      if (byId.has(id)) continue;
      byId.set(id, true);
      out.push(m);
      continue;
    }
    const isSelf = isSelfMessage(m) ? 'self' : 'other';
    const text = String((m && m.text) || '').trim();
    const type = String((m && m.type) || '').trim();
    const convId = String((m && m.id) || '').trim();
    const roundedTime = Math.floor(Number((m && m.time) || 0) / 2);
    const segmentSig = Array.isArray(m && m.segments)
      ? m.segments.map((s) => `${String((s && s.type) || '')}:${JSON.stringify((s && s.data) || {})}`).join('|')
      : '';
    const key = `${type}:${convId}:${isSelf}:${roundedTime}:${text}:${segmentSig}`;
    if (contentSeen.has(key)) continue;
    contentSeen.add(key);
    out.push(m);
  }
  return out.sort((a, b) => (a.time || 0) - (b.time || 0));
}

function addMessages(conv, msgs, append = true) {
  const key = convKey(conv.type, conv.id);
  const cur = append ? (state.messages.get(key) || []) : [];
  const merged = dedupeMessages([...cur, ...msgs]).slice(-1000);
  state.messages.set(key, merged);
  if (key === state.activeConv) renderMessages();
}

function switchTab(tab) {
  state.activeTab = tab;
  el('tabConsole').classList.toggle('active', tab === 'console');
  el('tabFiles').classList.toggle('active', tab === 'files');
  el('tabDevices').classList.toggle('active', tab === 'devices');
  el('tabSettings').classList.toggle('active', tab === 'settings');
  el('tabLogs').classList.toggle('active', tab === 'logs');
  el('pageConsole').classList.toggle('active', tab === 'console');
  el('pageFiles').classList.toggle('active', tab === 'files');
  el('pageDevices').classList.toggle('active', tab === 'devices');
  el('pageSettings').classList.toggle('active', tab === 'settings');
  el('pageLogs').classList.toggle('active', tab === 'logs');
  if (tab === 'devices') {
    refreshDevices().catch((e) => notify(e.message, 'err'));
  }
  if (tab === 'files') {
    refreshFileGroupSelect();
    if (state.fileLocalMode === 'client') {
      getStoredDirectoryHandle().then((handle) => {
        if (handle) {
          state.fileClientDirHandle = handle;
          state.fileClientHandleStack = [{ name: handle.name, handle }];
          el('clientDirLabel').textContent = handle.name;
          return loadClientDirectory(handle);
        }
      }).catch(() => {});
    } else if (!state.fileLocalEntries.length) {
      loadLocalFiles('').catch((e) => notify(e.message, 'err'));
    }
  }
  if (tab === 'logs') renderLogs();
}

function formatSec(ts) {
  if (!ts) return '-';
  return formatShanghaiTime(ts);
}

function applyCustomStyles() {
  const bg = String(state.custom.bgImageUrl || '').trim();
  const opacity = Number(state.custom.bgOpacity || 100) / 100;
  const posX = Number(state.custom.bgPosX || 50);
  const posY = Number(state.custom.bgPosY || 20);
  document.body.style.setProperty('--bg-image', bg ? `url("${bg.replace(/"/g, '\\"')}")` : 'none');
  document.body.style.setProperty('--bg-opacity', String(opacity));
  document.body.style.setProperty('--bg-position', `${posX}% ${posY}%`);
  document.body.classList.toggle('has-bg-image', !!bg);
}

function syncSelfColorPreview() {
  const value = String(state.custom.selfMsgColor || '#ffe4a8');
  el('selfMsgColorPicker').value = value;
  el('selfMsgColorCode').value = value;
}

const CHAT_THEMES = [
  { name: '柔和', sat: 50, light: 94, hueShift: 0 },
  { name: '清凉', sat: 45, light: 91, hueShift: 200 },
  { name: '暖阳', sat: 65, light: 90, hueShift: 35 },
  { name: '鲜明', sat: 80, light: 85, hueShift: 0 },
  { name: '素雅', sat: 18, light: 93, hueShift: 0 },
  { name: '深邃', sat: 45, light: 78, hueShift: 0 },
  { name: '桃色', sat: 55, light: 92, hueShift: 15 },
  { name: '薄荷', sat: 50, light: 90, hueShift: 150 },
  { name: '薰衣草', sat: 55, light: 91, hueShift: 270 },
  { name: '琥珀', sat: 70, light: 87, hueShift: 40 },
  { name: '青灰', sat: 15, light: 88, hueShift: 210 },
  { name: '珊瑚', sat: 75, light: 88, hueShift: 10 },
];

function getChatTheme() {
  return state.custom.chatTheme || '柔和';
}

const CHAT_THEME_PREVIEW_HUES = [210, 140, 30];

function renderChatThemes() {
  const container = el('colorPresets');
  if (!container) return;
  container.innerHTML = '';
  const active = getChatTheme();
  const activeTheme = CHAT_THEMES.find((t) => t.name === active) || CHAT_THEMES[0];

  // trigger button
  const trigger = document.createElement('button');
  trigger.className = 'chat-theme-trigger';
  trigger.innerHTML =
    '<span class="chat-theme-dots">' +
    CHAT_THEME_PREVIEW_HUES.map((h) =>
      `<span class="chat-theme-dot" style="background:hsl(${h},${activeTheme.sat}%,${activeTheme.light}%)"></span>`
    ).join('') +
    '</span>' +
    `<span>${activeTheme.name}</span>` +
    '<span class="chat-theme-arrow">▾</span>';
  trigger.title = '点击选择他人气泡配色';
  container.appendChild(trigger);

  // popup panel
  const popup = document.createElement('div');
  popup.className = 'chat-theme-popup';
  popup.style.display = 'none';
  CHAT_THEMES.forEach((t) => {
    const row = document.createElement('button');
    row.className = 'chat-theme-row';
    if (t.name === active) row.classList.add('active');
    row.innerHTML =
      '<span class="chat-theme-dots">' +
      CHAT_THEME_PREVIEW_HUES.map((h) =>
        `<span class="chat-theme-dot" style="background:hsl(${h},${t.sat}%,${t.light}%)"></span>`
      ).join('') +
      '</span>' +
      `<span>${t.name}</span>`;
    row.title = `${t.name} · 饱和度${t.sat}% 亮度${t.light}%`;
    row.onclick = (evt) => {
      evt.stopPropagation();
      state.custom.chatTheme = t.name;
      renderMessages();
      renderChatThemes();
    };
    popup.appendChild(row);
  });
  container.appendChild(popup);

  trigger.onclick = (evt) => {
    evt.stopPropagation();
    const isOpen = popup.style.display === 'block';
    closeAllThemePopups();
    if (!isOpen) popup.style.display = 'block';
  };

  // close popup on outside click
  if (!window._themePopupCloseBound) {
    window._themePopupCloseBound = true;
    document.addEventListener('click', closeAllThemePopups);
  }
}

function closeAllThemePopups() {
  document.querySelectorAll('.chat-theme-popup').forEach((p) => {
    p.style.display = 'none';
  });
}

async function loadCustomSettings() {
  const res = await api('/backend/ui-settings');
  const parsed = res && res.data ? res.data : {};
  state.custom.bgImageUrl = String(parsed.bgImageUrl || '/files/default.png');
  state.custom.bgOpacity = Number(parsed.bgOpacity || 100);
  state.custom.bgPosX = Number(parsed.bgPosX || 50);
  state.custom.bgPosY = Number(parsed.bgPosY || 20);
  state.custom.selfMsgColor = String(parsed.selfMsgColor || '#ffe4a8');
  state.custom.chatTheme = String(parsed.chatTheme || '柔和');
  localStorage.setItem(UI_CACHE_KEY, JSON.stringify(state.custom));
}

async function saveCustomSettings() {
  await api('/backend/ui-settings', 'POST', {
    bgImageUrl: state.custom.bgImageUrl,
    bgOpacity: state.custom.bgOpacity,
    bgPosX: state.custom.bgPosX,
    bgPosY: state.custom.bgPosY,
    selfMsgColor: state.custom.selfMsgColor,
    chatTheme: state.custom.chatTheme,
  });
  localStorage.setItem(UI_CACHE_KEY, JSON.stringify(state.custom));
}

function loadCustomSettingsFromCache() {
  try {
    const raw = localStorage.getItem(UI_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') {
      state.custom.bgImageUrl = String(parsed.bgImageUrl || state.custom.bgImageUrl || '');
      state.custom.bgOpacity = Number(parsed.bgOpacity || state.custom.bgOpacity || 20);
      state.custom.bgPosX = Number(parsed.bgPosX || state.custom.bgPosX || 50);
      state.custom.bgPosY = Number(parsed.bgPosY || state.custom.bgPosY || 50);
      state.custom.selfMsgColor = String(parsed.selfMsgColor || state.custom.selfMsgColor || '#dbeafe');
    }
  } catch (_) {}
}

function syncSettingsToUI() {
  el('bgImageUrl').value = state.custom.bgImageUrl || '';
  el('bgOpacity').value = state.custom.bgOpacity || 20;
  el('bgOpacityLabel').textContent = `${state.custom.bgOpacity || 20}%`;
  el('bgPosX').value = state.custom.bgPosX || 50;
  el('bgPosXLabel').textContent = `${state.custom.bgPosX || 50}%`;
  el('bgPosY').value = state.custom.bgPosY || 50;
  el('bgPosYLabel').textContent = `${state.custom.bgPosY || 50}%`;
  syncSelfColorPreview();
  renderChatThemes();
}

function renderLogs() {
  const area = el('logsArea');
  if (!area) return;
  const allowed = state.logFilter;
  const rows = getAllLogsSorted()
    .filter((x) => !!allowed[String(x.level || '').toLowerCase()])
    .map((x) => ({ time: x.time, level: String(x.level || 'info').toLowerCase(), text: x.text }));
  area.innerHTML = '';
  rows.forEach((row) => {
    const line = document.createElement('div');
    line.className = `log-line log-${row.level}`;
    line.textContent = `[${row.time}] [${row.level.toUpperCase()}] ${row.text}`;
    area.appendChild(line);
  });
  area.scrollTop = area.scrollHeight;
}

function renderDevices() {
  const box = el('deviceList');
  box.innerHTML = '';
  state.devices.forEach((d) => {
    const item = document.createElement('div');
    item.className = 'item device-item';

    const line1 = document.createElement('div');
    line1.className = 'device-line';
    line1.textContent = `${d.ip}  ->  ${d.host}:${d.port}`;
    item.appendChild(line1);

    const line2 = document.createElement('div');
    line2.className = 'device-line';
    line2.textContent = `最后路径: ${d.lastPath} | 次数: ${d.count} | 最后访问: ${formatSec(d.lastSeen)}`;
    item.appendChild(line2);

    const line3 = document.createElement('div');
    line3.className = 'device-line';
    line3.textContent = `状态: ${d.accepted ? '已放行' : '被拦截'}${d.viaWs ? ' | WS' : ' | HTTP'}`;
    item.appendChild(line3);

    const line4 = document.createElement('div');
    line4.className = 'device-line';
    line4.textContent = `UA: ${d.ua}`;
    item.appendChild(line4);

    box.appendChild(item);
  });
}

async function refreshDevices() {
  const res = await api('/backend/devices');
  state.devices = res.data || [];
  state.accessToken = String(res.accessToken || '');
  el('accessToken').value = state.accessToken;
  renderDevices();
}

async function saveAccessToken() {
  const token = el('accessToken').value.trim();
  if (!token || token.length < 4) return notify('密码至少需要4位字符', 'warn');
  await api('/backend/access-token', 'POST', { token });
  state.accessToken = token;
  setClientToken(token);
  notify('访问密码已更新', 'ok');
}

async function refreshHealth() {
  const health = await api('/backend/health');
  state.authed = true;
  state.wsToken = health.wsToken;
  state.accessToken = String(health.accessToken || '');
  state.loginFailures = Number(health.loginFailures || 0);
  state.localIp = String(health.localIp || '');
  state.selfId = String((health.napcat && health.napcat.selfId) || state.selfId || '');
  state.selfNickname = String((health.napcat && health.napcat.nickname) || state.selfNickname || '');
  const clientIp = String(health.clientIp || '');
  const clientIpRaw = String(health.clientIpRaw || '');
  el('wsToken').value = state.wsToken;
  el('accessToken').value = state.accessToken;
  el('accessToken').readOnly = false;
  el('accessToken').placeholder = '访问密码（至少4位）';
  el('accessTokenRow').style.display = '';
  el('accessTokenActionRow').style.display = '';
  el('saveAccessToken').style.display = '';
  el('accessTokenHint').textContent = '设置访问密码，任何人知道此密码即可通过网页管理NapCat。';
  el('wsTip').textContent = 'NapCat 的 ws 客户端填写地址：ws://你的IP:18080/ws?access_token=你的wstoken';
  el('wsTipIp').textContent = `自动识别本机IP：${state.localIp || '-'}`;
  el('visitIp').textContent = `你的访问IP：${clientIp || '-'}${clientIpRaw && clientIpRaw !== clientIp ? `（raw: ${clientIpRaw}）` : ''}`;
  el('selfQq').textContent = state.selfNickname ? `${state.selfNickname} (${state.selfId || '-'})` : `QQ: ${state.selfId || '-'}`;
  el('selfAvatar').src = state.selfId ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(state.selfId)}&s=100` : '';
  el('versionStamp').textContent = String(health.versionStamp || '-');
  if (health.napcat.connected) setConn('NapCat已连接', true);
  else setConn('等待NapCat连接', false);
}

async function tryLoginWithToken(token, showSuccess = true) {
  setClientToken(token);
  await loadInitial();
  if (!state.sse) connectRealtime();
  hideAuthModal();
  state.loginFailures = 0;
  if (showSuccess) notify('登录成功', 'ok');
  if (token === 'easyqq') {
    setTimeout(() => showChangePasswordModal(), 500);
  }
}

async function loadInitial() {
  await loadCustomSettings();
  applyCustomStyles();
  await loadProfiles();
  applyProfile();
  await refreshHealth();
  syncSettingsToUI();

  const conv = await api('/backend/conversations');
  state.conversations = normalizeConversationList(conv.data || []);
  state.visibleConvKeys = (state.visibleConvKeys || []).filter((key) =>
    state.conversations.some((c) => convKey(c.type, c.id) === key)
  );
  saveProfileData();
  try {
    await refreshList();
  } catch (_) {
    notify('NapCat未连接，先显示本地会话', 'warn');
  }
  try {
    const repoLink = el('repoLink');
    if (REPOSITORY_URL) repoLink.href = REPOSITORY_URL;
    else repoLink.href = '#';
  } catch (_) {}
  await refreshAuditLogsData();
  renderConversations();
  await prefetchMobileRecentMessages(30);
}

async function saveWhitelistToBackend() {
  await api('/backend/whitelist', 'POST', { data: state.whitelist });
  saveProfileData();
  renderConversations();
}

async function saveConversation() {
  await refreshList();
}

async function refreshList() {
  const friends = await api('/backend/friends');
  const groups = await api('/backend/groups');
  const conv = await api('/backend/conversations');
  upsertConversations(friends.data || []);
  upsertConversations(groups.data || []);
  upsertConversations(conv.data || []);
  renderConversations();
  await prefetchMobileRecentMessages(30);
}

async function doSearch() {
  const type = el('searchType').value;
  const keyword = el('searchKeyword').value.trim();
  const res = await api('/backend/search', 'POST', { type, keyword });
  const found = normalizeConversationList(res.data || []);
  upsertConversations(found);
  notify(`搜索到 ${found.length} 个会话，可在“管理会话”里添加显示`, 'ok');
}

async function pullHistory({ append }) {
  const key = el('activeConv').value.trim();
  const parsed = parseConvKey(key);
  if (!parsed) return notify('先填当前会话，例如 group:1001', 'warn');

  const limit = Number(el('historyCount').value || 30);
  const res = await api('/backend/messages/pull', 'POST', { type: parsed.type, id: parsed.id, limit });
  addMessages(parsed, res.data || [], false);
}

async function autoLoadOnOpen() {
  const parsed = parseConvKey(state.activeConv);
  if (!parsed) return;

  if (isRealtimeEnabled(parsed)) {
    const res = await api('/backend/messages/pull', 'POST', { type: parsed.type, id: parsed.id, limit: 200 });
    const start = todayStartSec();
    const todayList = (res.data || []).filter((m) => Number(m.time || 0) >= start);
    addMessages(parsed, todayList, false);
    notify('已加载今日消息', 'ok');
  } else {
    const res = await api('/backend/messages/pull', 'POST', { type: parsed.type, id: parsed.id, limit: 5 });
    addMessages(parsed, res.data || [], false);
    notify('已自动拉取最近5条', 'ok');
  }
}

async function prefetchMobileRecentMessages(limit = 30) {
  if (!isMobileView()) return;
  const map = new Map(state.conversations.map((conv) => [convKey(conv.type, conv.id), conv]));
  const selected = (state.visibleConvKeys || [])
    .map((key) => map.get(key))
    .filter(Boolean);
  for (const conv of selected) {
    try {
      const res = await api('/backend/messages/pull', 'POST', {
        type: conv.type,
        id: conv.id,
        limit,
      });
      addMessages(conv, res.data || [], false);
    } catch (_) {}
  }
}

function updateRealtimeButton() {
  const button = el('toggleRealtime');
  const parsed = parseConvKey(el('activeConv').value.trim() || state.activeConv);
  if (!parsed) {
    button.textContent = '实时推送: 关闭';
    button.classList.remove('success');
    button.classList.add('muted');
    return;
  }
  const on = isRealtimeEnabled(parsed);
  button.textContent = `实时推送: ${on ? '开启' : '关闭'}`;
  button.classList.remove('success', 'muted');
  button.classList.add(on ? 'success' : 'muted');
}

async function toggleRealtimeForActive() {
  const parsed = parseConvKey(el('activeConv').value.trim() || state.activeConv);
  if (!parsed) return notify('先选择会话', 'warn');
  const on = isRealtimeEnabled(parsed);
  if (on) {
    state.whitelist = state.whitelist.filter((w) => !(w.type === parsed.type && String(w.id) === String(parsed.id)));
    notify('已关闭该会话实时推送', 'warn');
  } else {
    state.whitelist.push({ type: parsed.type, id: parsed.id });
    notify('已开启该会话实时推送', 'ok');
  }
  await saveWhitelistToBackend();
  updateRealtimeButton();
  await autoLoadOnOpen();
}

async function sendMessage() {
  const parsed = parseConvKey(el('activeConv').value.trim());
  if (!parsed) return notify('先选择当前会话', 'warn');

  const text = el('textMsg').value.trim();
  const atRef = el('atRef').value.trim();
  const replyRef = el('replyRef').value.trim();
  const imageRef = String(state.pendingImageRef || '').trim();
  const fileRef = String(state.pendingFileRef || '').trim();

  const segments = [];
  if (replyRef) segments.push({ type: 'reply', data: { id: replyRef } });
  if (parsed.type === 'group' && atRef) {
    segments.push({ type: 'at', data: { qq: atRef } });
    if (text) segments.push({ type: 'text', data: { text: ' ' } });
  }
  if (text) segments.push(...parseOutgoingTextSegments(text, parsed.type));
  if (imageRef) segments.push({ type: 'image', data: { file: imageRef } });
  if (fileRef) {
    const fileName = normalizeFileNameForSend(state.pendingFileName || inferFileNameFromRef(fileRef));
    const data = { file: fileRef };
    if (fileName) data.name = fileName;
    segments.push({ type: 'file', data });
  }
  if (!segments.length) return notify('至少填一种消息内容', 'warn');
  const textBrief = text ? (text.length > 24 ? `${text.slice(0, 24)}...` : text) : '';
  addLog('info', `send -> ${parsed.type}:${parsed.id} at=${atRef || '-'} reply=${replyRef || '-'} image=${imageRef ? 'yes' : 'no'} file=${fileRef ? 'yes' : 'no'} fileName=${state.pendingFileName || '-'} segments=${segments.map((s) => s.type).join(',')}${textBrief ? ` text="${textBrief}"` : ''}`);

  const res = await api('/backend/messages/send', 'POST', { type: parsed.type, id: parsed.id, segments });
  const sentList = Array.isArray(res.list) ? res.list : (res.data ? [res.data] : []);
  if (sentList.length) addMessages(parsed, sentList, true);

  el('textMsg').value = '';
  el('atRef').value = '';
  el('replyRef').value = '';
  state.pendingImageRef = '';
  state.pendingFileRef = '';
  state.pendingFileName = '';
  el('selectedMediaInfo').value = '';
  notify('发送成功', 'ok');
}

async function pickAndUploadImage() {
  const picker = el('imagePicker');
  picker.value = '';
  picker.click();
}

async function pickAndUploadFile() {
  const picker = el('filePicker');
  picker.value = '';
  picker.click();
}

async function onPickedImage() {
  const picker = el('imagePicker');
  const file = picker.files && picker.files[0];
  if (!file) return;
  const res = await uploadLocalFile(file, 'image');
  state.pendingImageRef = String(res.url || res.relativeUrl || '').trim();
  el('selectedMediaInfo').value = `图片: ${file.name || '已上传'}`;
  notify('图片已上传，可直接发送', 'ok');
}

async function onPickedFile() {
  const picker = el('filePicker');
  const file = picker.files && picker.files[0];
  if (!file) return;
  const res = await uploadLocalFile(file, 'file');
  state.pendingFileRef = String(res.url || res.relativeUrl || '').trim();
  state.pendingFileName = normalizeFileNameForSend(file.name || res.name || '');
  el('selectedMediaInfo').value = `文件: ${state.pendingFileName || file.name || '已上传'}`;
  notify('文件已上传，可直接发送', 'ok');
}

function convFromKey(key) {
  const parsed = parseConvKey(key);
  if (!parsed) return null;
  return { type: parsed.type, id: parsed.id, name: '' };
}

function openConvManageModal() {
  state.manageDraftKeys = Array.isArray(state.visibleConvKeys) ? [...state.visibleConvKeys] : [];
  state.manageSearchKeys = [];
  el('convSearchKeyword').value = '';
  renderConvManageLists();
  el('convManageModal').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeConvManageModal() {
  el('convManageModal').classList.remove('show');
  document.body.style.overflow = '';
}

function keySelectorValue(key) {
  return key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function blinkAndScrollManageItem(key) {
  const selector = `[data-conv-key="${keySelectorValue(key)}"]`;
  const node = document.querySelector(`#allConvList ${selector}`);
  if (!node) return;
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  node.classList.remove('search-blink');
  setTimeout(() => node.classList.add('search-blink'), 40);
}

function renderConvManageLists() {
  const allBox = el('allConvList');
  const selectedBox = el('selectedConvList');
  allBox.innerHTML = '';
  selectedBox.innerHTML = '';

  const map = new Map(state.conversations.map((conv) => [convKey(conv.type, conv.id), conv]));
  const selectedSet = new Set(state.manageDraftKeys || []);
  const highlightSet = new Set(state.manageSearchKeys || []);

  const selectedItems = (state.manageDraftKeys || []).map((key) => map.get(key) || convFromKey(key)).filter(Boolean);
  const allItems = state.conversations.filter((conv) => !selectedSet.has(convKey(conv.type, conv.id)));

  selectedItems.forEach((conv) => {
    const key = convKey(conv.type, conv.id);
    const row = document.createElement('div');
    row.className = 'item conv-manage-item';
    row.dataset.convKey = key;
    const label = document.createElement('div');
    label.className = 'conv-manage-label';
    label.textContent = conversationLabel(conv);
    const btn = document.createElement('button');
    btn.textContent = '移除';
    btn.className = 'secondary';
    btn.onclick = () => {
      state.manageDraftKeys = state.manageDraftKeys.filter((k) => k !== key);
      renderConvManageLists();
    };
    row.appendChild(label);
    row.appendChild(btn);
    selectedBox.appendChild(row);
  });

  allItems.forEach((conv) => {
    const key = convKey(conv.type, conv.id);
    const row = document.createElement('div');
    row.className = 'item conv-manage-item';
    row.dataset.convKey = key;
    if (highlightSet.has(key)) row.classList.add('search-hit');
    const label = document.createElement('div');
    label.className = 'conv-manage-label';
    label.textContent = conversationLabel(conv);
    const btn = document.createElement('button');
    btn.textContent = '显示';
    btn.onclick = () => {
      state.manageDraftKeys.push(key);
      state.manageDraftKeys = Array.from(new Set(state.manageDraftKeys));
      renderConvManageLists();
    };
    row.appendChild(label);
    row.appendChild(btn);
    allBox.appendChild(row);
  });

  if (highlightSet.size === 1) {
    const only = Array.from(highlightSet)[0];
    blinkAndScrollManageItem(only);
  }
}

function saveConvManage() {
  state.visibleConvKeys = Array.from(new Set(state.manageDraftKeys || []));
  saveProfileData();
  if (state.activeConv && !state.visibleConvKeys.includes(state.activeConv)) {
    state.activeConv = state.visibleConvKeys[0] || '';
    el('activeConv').value = state.activeConv;
  }
  renderConversations();
  closeConvManageModal();
  notify('会话显示列表已更新', 'ok');
}

function searchInManageConversations() {
  const keywordRaw = el('convSearchKeyword').value.trim();
  if (!keywordRaw) {
    state.manageSearchKeys = [];
    renderConvManageLists();
    return;
  }
  const isDigits = /^\d+$/.test(keywordRaw);
  if (isDigits && !(keywordRaw.length === 9 || keywordRaw.length === 10)) {
    notify('请输入完整9或10位ID', 'warn');
    return;
  }
  const query = keywordRaw.toLowerCase();
  const found = state.conversations.filter((conv) => {
    const id = String(conv.id || '');
    const name = String(conv.name || '');
    if (isDigits) return id === keywordRaw;
    return name.toLowerCase().includes(query);
  });
  state.manageSearchKeys = found.map((conv) => convKey(conv.type, conv.id));
  if (!found.length) {
    notify('未找到匹配会话', 'warn');
  } else if (found.length > 1) {
    notify(`找到 ${found.length} 个会话，已高亮`, 'ok');
  }
  renderConvManageLists();
}

function clearManageSearch() {
  state.manageSearchKeys = [];
  el('convSearchKeyword').value = '';
  renderConvManageLists();
}

function syncLogFilterFromUI() {
  state.logFilter.debug = !!el('logDebug').checked;
  state.logFilter.info = !!el('logInfo').checked;
  state.logFilter.warn = !!el('logWarn').checked;
  state.logFilter.error = !!el('logError').checked;
  state.logFilter.system = !!el('logSystem').checked;
  renderLogs();
}

async function exportLogs() {
  const selected = getAllLogsSorted().filter((row) => !!state.logFilter[String(row.level || '').toLowerCase()]);
  const res = await api('/backend/logs/export', 'POST', { logs: selected });
  notify(`日志导出成功: ${res.file}`, 'ok');
}

// --- file management ---

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatFileTime(ms) {
  return formatShanghaiFileTime(ms);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => { resolve(reader.result.split(',')[1]); };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// --- File System Access API helpers (Chrome/Edge only) ---
function hasFSApi() { return !!window.showDirectoryPicker; }
function isSecureCtx() { return !!window.isSecureContext; }
function hasWebkitDirSupport() {
  const input = document.createElement('input');
  input.type = 'file';
  return !!input.webkitdirectory || 'webkitdirectory' in input;
}

function openFSDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('easyqq-fs', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('handles'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeDirectoryHandle(handle) {
  try {
    const db = await openFSDB();
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, 'rootDir');
    await new Promise((r) => { tx.oncomplete = r; });
  } catch {}
}

async function getStoredDirectoryHandle() {
  try {
    const db = await openFSDB();
    const tx = db.transaction('handles', 'readonly');
    const handle = await new Promise((r) => {
      const req = tx.objectStore('handles').get('rootDir');
      req.onsuccess = () => r(req.result);
      req.onerror = () => r(null);
    });
    if (!handle) return null;
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') return handle;
    const req = await handle.requestPermission({ mode: 'readwrite' });
    return req === 'granted' ? handle : null;
  } catch { return null; }
}

async function loadLocalFiles(dirPath) {
  const params = new URLSearchParams();
  if (dirPath) params.set('path', dirPath);
  const res = await api(`/backend/files/local?${params.toString()}`);
  state.fileLocalPath = String(res.path || '');
  state.fileLocalRoot = String(res.root || '');
  state.fileLocalEntries = Array.isArray(res.entries) ? res.entries : [];
  state.fileLocalSelected.clear();
  renderLocalFiles();
}

function renderLocalFiles() {
  const box = el('localFileList');
  const pathInput = el('localPathInput');
  box.innerHTML = '';
  pathInput.value = state.fileLocalPath || '';
  state.fileLocalEntries.forEach((entry) => {
    const row = document.createElement('div');
    const sel = state.fileLocalSelected.has(entry.path);
    row.className = `file-item${entry.type === 'folder' ? ' folder-item' : ''}${sel ? ' selected' : ''}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'file-checkbox';
    cb.checked = sel;
    cb.onclick = (evt) => {
      evt.stopPropagation();
      if (state.fileLocalSelected.has(entry.path)) {
        state.fileLocalSelected.delete(entry.path);
        row.classList.remove('selected');
        cb.checked = false;
      } else {
        state.fileLocalSelected.add(entry.path);
        row.classList.add('selected');
        cb.checked = true;
      }
    };
    row.onclick = (evt) => {
      if (evt.target === cb) return;
      if (entry.type === 'folder') {
        loadLocalFiles(entry.path).catch((e) => notify(e.message, 'err'));
        return;
      }
      // toggle selection on row click
      if (state.fileLocalSelected.has(entry.path)) {
        state.fileLocalSelected.delete(entry.path);
        row.classList.remove('selected');
        cb.checked = false;
      } else {
        state.fileLocalSelected.add(entry.path);
        row.classList.add('selected');
        cb.checked = true;
      }
    };
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = entry.type === 'folder' ? '📁' : '📄';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = entry.name;
    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = entry.type === 'file' ? formatSize(entry.size) : '';
    const time = document.createElement('span');
    time.className = 'file-time';
    time.textContent = formatFileTime(entry.mtime);
    row.appendChild(cb);
    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(size);
    row.appendChild(time);
    box.appendChild(row);
  });
  if (!state.fileLocalEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'help';
    empty.style.cssText = 'padding:16px;text-align:center;color:#9ca3af;';
    empty.textContent = '此目录为空';
    box.appendChild(empty);
  }
}

async function loadGroupFiles(groupId, folderId) {
  if (!groupId) {
    state.fileGroupEntries = { files: [], folders: [] };
    state.fileGroupPath = [];
    el('groupFolderLabel').textContent = '根目录';
    renderGroupFiles();
    return;
  }
  const params = new URLSearchParams();
  params.set('group_id', groupId);
  if (folderId) params.set('folder_id', folderId);
  const res = await api(`/backend/files/group?${params.toString()}`);
  const data = res && res.data ? res.data : { files: [], folders: [] };
  state.fileGroupEntries = {
    files: Array.isArray(data.files) ? data.files : [],
    folders: Array.isArray(data.folders) ? data.folders : [],
  };
  state.fileGroupSelected.clear();
  renderGroupFiles();
}

function renderGroupFiles() {
  const box = el('groupFileList');
  box.innerHTML = '';
  const allItems = [];
  (state.fileGroupEntries.folders || []).forEach((f) => allItems.push({ ...f, _type: 'folder' }));
  (state.fileGroupEntries.files || []).forEach((f) => allItems.push({ ...f, _type: 'file' }));
  allItems.sort((a, b) => {
    if (a._type !== b._type) return a._type === 'folder' ? -1 : 1;
    return String(a.name || a.file_name || '').localeCompare(String(b.name || b.file_name || ''), 'zh-CN');
  });
  allItems.forEach((entry) => {
    const id = String(entry.file_id || entry.folder_id || entry.name || '');
    const row = document.createElement('div');
    const sel = state.fileGroupSelected.has(id);
    row.className = `file-item${entry._type === 'folder' ? ' folder-item' : ''}${sel ? ' selected' : ''}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'file-checkbox';
    cb.checked = sel;
    cb.onclick = (evt) => {
      evt.stopPropagation();
      if (state.fileGroupSelected.has(id)) {
        state.fileGroupSelected.delete(id);
        row.classList.remove('selected');
        cb.checked = false;
      } else {
        state.fileGroupSelected.add(id);
        row.classList.add('selected');
        cb.checked = true;
      }
    };
    row.onclick = (evt) => {
      if (evt.target === cb) return;
      if (entry._type === 'folder') {
        const nextPath = [...(state.fileGroupPath || [])];
        nextPath.push({ id, name: String(entry.folder_name || entry.name || id) });
        state.fileGroupPath = nextPath;
        el('groupFolderLabel').textContent = '/' + nextPath.map((p) => p.name).join('/');
        loadGroupFiles(state.fileGroupId, id).catch((e) => notify(e.message, 'err'));
        return;
      }
      if (state.fileGroupSelected.has(id)) {
        state.fileGroupSelected.delete(id);
        row.classList.remove('selected');
        cb.checked = false;
      } else {
        state.fileGroupSelected.add(id);
        row.classList.add('selected');
        cb.checked = true;
      }
    };
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = entry._type === 'folder' ? '📁' : '📄';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = String(entry.name || entry.file_name || entry.folder_name || id);
    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = entry._type === 'file' ? formatSize(Number(entry.size || entry.file_size || 0)) : '';
    const uploader = document.createElement('span');
    uploader.className = 'file-uploader';
    uploader.textContent = getUploaderName(entry);
    row.appendChild(cb);
    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(size);
    row.appendChild(uploader);
    box.appendChild(row);
  });
}

function navigateGroupUp() {
  const p = state.fileGroupPath || [];
  if (!p.length) return;
  const popped = p.pop();
  state.fileGroupPath = p;
  el('groupFolderLabel').textContent = p.length ? '/' + p.map((x) => x.name).join('/') : '根目录';
  const parentId = p.length ? p[p.length - 1].id : '';
  loadGroupFiles(state.fileGroupId, parentId).catch((e) => notify(e.message, 'err'));
}

async function uploadLocalToGroup() {
  if (!state.fileGroupId) return notify('请先选择目标群聊', 'warn');
  if (!state.fileLocalSelected.size) return notify('请先在左侧选中要上传的文件', 'warn');
  for (const filePath of state.fileLocalSelected) {
    const fileName = filePath.split('/').pop() || filePath;
    try {
      await api('/backend/messages/send', 'POST', {
        type: 'group',
        id: state.fileGroupId,
        segments: [{ type: 'file', data: { file: filePath, name: fileName } }],
      });
      notify(`已上传: ${fileName}`, 'ok');
    } catch (e) {
      notify(`上传失败 ${fileName}: ${e.message}`, 'err');
    }
  }
  state.fileLocalSelected.clear();
  renderLocalFiles();
  loadGroupFiles(state.fileGroupId, state.fileGroupPath.length ? state.fileGroupPath[state.fileGroupPath.length - 1].id : '').catch(() => {});
}

async function downloadSelectedGroupFiles() {
  if (!state.fileGroupSelected.size) return notify('请先在右侧选中要下载的文件', 'warn');
  for (const fileId of state.fileGroupSelected) {
    const entry = [...(state.fileGroupEntries.files || []), ...(state.fileGroupEntries.folders || [])]
      .find((e) => String(e.file_id || e.folder_id || e.name || '') === fileId);
    if (!entry || entry._type === 'folder') continue;
    const params = new URLSearchParams();
    params.set('type', 'group');
    params.set('id', state.fileGroupId);
    params.set('file_id', String(entry.file_id || ''));
    if (entry.busid) params.set('busid', String(entry.busid));
    const name = String(entry.name || entry.file_name || fileId);
    params.set('name', name);
    const url = withAccessToken(`/backend/files/download?${params.toString()}`);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  notify('已开始下载选中文件', 'ok');
}

async function deleteSelectedGroupFiles() {
  if (!state.fileGroupSelected.size) return notify('请先在右侧选中要删除的文件/文件夹', 'warn');
  if (!confirm(`确认删除 ${state.fileGroupSelected.size} 个文件/文件夹？此操作不可撤销。`)) return;
  for (const fileId of state.fileGroupSelected) {
    const entry = [...(state.fileGroupEntries.files || []), ...(state.fileGroupEntries.folders || [])]
      .find((e) => String(e.file_id || e.folder_id || e.name || '') === fileId);
    if (!entry) continue;
    try {
      await api('/backend/files/group/delete', 'POST', {
        group_id: state.fileGroupId,
        file_id: String(entry.file_id || entry.folder_id || ''),
        is_folder: entry._type === 'folder' || !!entry.folder_id,
        busid: entry.busid,
      });
    } catch (e) {
      notify(`删除失败: ${e.message}`, 'err');
    }
  }
  notify('删除完成', 'ok');
  const folderId = state.fileGroupPath.length ? state.fileGroupPath[state.fileGroupPath.length - 1].id : '';
  loadGroupFiles(state.fileGroupId, folderId).catch(() => {});
}

async function createGroupFolder() {
  const name = prompt('请输入文件夹名称:');
  if (!name || !name.trim()) return;
  const parentId = state.fileGroupPath.length ? state.fileGroupPath[state.fileGroupPath.length - 1].id : '';
  try {
    await api('/backend/files/group/mkdir', 'POST', {
      group_id: state.fileGroupId,
      folder_name: name.trim(),
      parent_id: parentId || undefined,
    });
    notify('文件夹已创建', 'ok');
    loadGroupFiles(state.fileGroupId, parentId).catch(() => {});
  } catch (e) {
    notify(e.message, 'err');
  }
}

async function createLocalFolder() {
  const name = prompt('请输入文件夹名称:');
  if (!name || !name.trim()) return;
  const targetPath = (state.fileLocalPath || '') + '/' + name.trim();
  try {
    await api('/backend/files/local/mkdir', 'POST', { path: targetPath });
    notify('本地文件夹已创建', 'ok');
  } catch (e) {
    notify(e.message, 'err');
  }
  loadLocalFiles(state.fileLocalPath).catch(() => {});
}

// --- container file operations ---

async function setLocalFileAsBackground() {
  if (!state.fileLocalSelected.size) return notify('请先选中一个文件', 'warn');
  const selPath = [...state.fileLocalSelected][0];
  // 使用 /files/ 端点（无需鉴权，CSS background-image 可正常加载）
  const root = state.fileLocalRoot || '';
  const relPath = root && selPath.startsWith(root)
    ? selPath.slice(root.length).replace(/^[/\\]+/, '')
    : selPath.replace(/\\/g, '/').split('/').pop();
  const url = `/files/${relPath.split('/').map(encodeURIComponent).join('/')}`;
  state.custom.bgImageUrl = url;
  el('bgImageUrl').value = url;
  await saveCustomSettings();
  applyCustomStyles();
  notify('已设为背景', 'ok');
}

async function renameSelectedLocalFile() {
  if (state.fileLocalSelected.size !== 1) return notify('请只选中一个文件/文件夹进行重命名', 'warn');
  const oldPath = [...state.fileLocalSelected][0];
  const entry = state.fileLocalEntries.find((e) => e.path === oldPath);
  const oldName = entry ? entry.name : oldPath.split('/').pop();
  const isFolder = entry && entry.type === 'folder';
  const oldExt = isFolder ? '' : fileExtension(oldName);
  const defaultName = isFolder ? oldName : nameWithoutExtension(oldName);
  const newName = prompt('请输入新名称:', defaultName);
  if (!newName || !newName.trim()) return;
  let finalName = newName.trim();
  if (!isFolder && oldExt && !finalName.endsWith(oldExt)) finalName += oldExt;
  if (finalName === oldName) return;
  try {
    await api('/backend/files/local/rename', 'POST', { path: oldPath, newName: finalName });
    notify('重命名成功', 'ok');
  } catch (e) {
    notify(e.message, 'err');
  }
  loadLocalFiles(state.fileLocalPath).catch(() => {});
}

// --- left panel mode switching (server / client) ---

async function switchLocalModeToServer() {
  state.fileLocalMode = 'server';
  el('localModeServer').classList.add('active');
  el('localModeClient').classList.remove('active');
  el('localNavServer').style.display = '';
  el('localNavClient').style.display = 'none';
  const setBgBtn = el('localSetBg');
  if (setBgBtn) setBgBtn.style.display = '';
  state.fileLocalSelected.clear();
  state.fileClientSelected.clear();
}

async function switchLocalMode(mode) {
  state.fileLocalMode = mode;
  el('localModeServer').classList.toggle('active', mode === 'server');
  el('localModeClient').classList.toggle('active', mode === 'client');
  el('localNavServer').style.display = mode === 'server' ? '' : 'none';
  el('localNavClient').style.display = mode === 'client' ? '' : 'none';
  // 切换模式下按钮可见性
  const setBgBtn = el('localSetBg');
  if (setBgBtn) setBgBtn.style.display = mode === 'server' ? '' : 'none';
  state.fileLocalSelected.clear();
  state.fileClientSelected.clear();
  if (mode === 'server') {
    if (!state.fileLocalEntries.length) {
      await loadLocalFiles('').catch((e) => notify(e.message, 'err'));
    } else {
      renderLocalFiles();
    }
  } else {
    if (hasFSApi()) {
      el('clientGoUp').style.display = '';
      let handle = await getStoredDirectoryHandle();
      if (!handle) {
        handle = await pickClientDirectory();
        if (!handle) { switchLocalMode('server'); return; }
      }
      state.fileClientDirHandle = handle;
      state.fileClientDirName = handle.name;
      state.fileClientHandleStack = [{ name: handle.name, handle }];
      el('clientDirLabel').textContent = handle.name;
      await loadClientDirectory(handle);
    } else if (hasWebkitDirSupport()) {
      el('clientGoUp').style.display = '';
      const hint = isSecureCtx()
        ? '点击"选择目录"浏览本机文件夹（当前浏览器不支持写入，仅可读取）'
        : `点击"选择目录"浏览本机文件夹（仅可读取。如需写入请用 http://localhost:${location.port} 或 HTTPS 访问）`;
      el('clientDirLabel').textContent = hint;
      el('webkitDirPicker').click();
    } else {
      notify('此浏览器不支持 File System Access API 或 webkitdirectory。请使用 Chrome/Edge 等现代浏览器，并通过 localhost 或 HTTPS 访问本页面', 'err');
      switchLocalMode('server');
    }
  }
}

async function pickClientDirectory() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await storeDirectoryHandle(handle);
    return handle;
  } catch (e) {
    if (e.name !== 'AbortError') notify('选择目录失败: ' + e.message, 'err');
    return null;
  }
}

async function loadClientDirectory(dirHandle) {
  const entries = [];
  for await (const [name, handle] of dirHandle.entries()) {
    const entry = { name, handle };
    if (handle.kind === 'directory') {
      entry.type = 'folder';
      entry.size = 0; entry.mtime = 0;
    } else {
      entry.type = 'file';
      try { const f = await handle.getFile(); entry.size = f.size; entry.mtime = f.lastModified; }
      catch { entry.size = 0; entry.mtime = 0; }
    }
    entries.push(entry);
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  state.fileClientEntries = entries;
  state.fileClientSelected.clear();
  renderClientFiles();
}

function handleWebkitDirSelection(evt) {
  const files = Array.from(evt.target.files || []);
  if (!files.length) { switchLocalMode('server'); return; }
  const rootPath = files[0].webkitRelativePath || files[0].name;
  const rootName = rootPath.split('/')[0] || '已选目录';
  state.fileClientDirName = rootName;
  state.fileClientDirHandle = null;
  state.fileClientHandleStack = [];
  state.fileClientWebkitPath = rootName;
  el('clientGoUp').style.display = '';
  el('clientDirLabel').textContent = rootName + ' (只读模式)';
  // build flat entries with _fullPath; dedupe folders
  const folderSet = new Set();
  const entries = [];
  files.forEach((f) => {
    const relPath = f.webkitRelativePath || f.name;
    const parts = relPath.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const folderPath = parts.slice(0, i + 1).join('/');
      if (!folderSet.has(folderPath)) {
        folderSet.add(folderPath);
        entries.push({ name: parts[i], type: 'folder', size: 0, mtime: 0, _fullPath: folderPath });
      }
    }
    entries.push({
      name: parts[parts.length - 1],
      type: 'file',
      size: f.size,
      mtime: f.lastModified,
      _fileObj: f,
      _fullPath: relPath,
    });
  });
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  state.fileClientEntries = entries;
  state.fileClientSelected.clear();
  renderClientFiles();
  evt.target.value = '';
}

function webkitDirParent(entryPath) {
  const idx = entryPath.lastIndexOf('/');
  return idx > 0 ? entryPath.slice(0, idx) : '';
}

function renderClientFiles() {
  const box = el('localFileList');
  box.innerHTML = '';
  const isWebkitDir = !hasFSApi() && hasWebkitDirSupport();
  let displayEntries = state.fileClientEntries;
  if (isWebkitDir) {
    const curPath = state.fileClientWebkitPath || '';
    displayEntries = state.fileClientEntries.filter((e) => webkitDirParent(e._fullPath) === curPath);
  }
  displayEntries.forEach((entry) => {
    const row = document.createElement('div');
    const sel = state.fileClientSelected.has(entry.name);
    row.className = `file-item${entry.type === 'folder' ? ' folder-item' : ''}${sel ? ' selected' : ''}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'file-checkbox';
    cb.checked = sel;
    cb.onclick = (evt) => {
      evt.stopPropagation();
      if (state.fileClientSelected.has(entry.name)) {
        state.fileClientSelected.delete(entry.name);
        row.classList.remove('selected');
        cb.checked = false;
      } else {
        state.fileClientSelected.add(entry.name);
        row.classList.add('selected');
        cb.checked = true;
      }
    };
    row.onclick = (evt) => {
      if (evt.target === cb) return;
      if (entry.type === 'folder') {
        if (isWebkitDir) {
          state.fileClientWebkitPath = entry._fullPath || '';
          state.fileClientSelected.clear();
          el('clientDirLabel').textContent = state.fileClientWebkitPath + ' (只读模式)';
          renderClientFiles();
        } else {
          navigateClientInto(entry).catch((e) => notify(e.message, 'err'));
        }
        return;
      }
      if (state.fileClientSelected.has(entry.name)) {
        state.fileClientSelected.delete(entry.name);
        row.classList.remove('selected');
        cb.checked = false;
      } else {
        state.fileClientSelected.add(entry.name);
        row.classList.add('selected');
        cb.checked = true;
      }
    };
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = entry.type === 'folder' ? '📁' : '📄';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = entry.name;
    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = entry.type === 'file' ? formatSize(entry.size) : '';
    row.appendChild(cb);
    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(size);
    box.appendChild(row);
  });
  if (!displayEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'help';
    empty.style.cssText = 'padding:16px;text-align:center;color:#9ca3af;';
    empty.textContent = isWebkitDir
      ? '此目录为空（注意：只读模式无法检测空文件夹）'
      : '此目录为空';
    box.appendChild(empty);
  }
}

async function navigateClientInto(entry) {
  state.fileClientHandleStack.push({ name: entry.name, handle: entry.handle });
  el('clientDirLabel').textContent = '/' + state.fileClientHandleStack.map((p) => p.name).join('/');
  await loadClientDirectory(entry.handle);
}

async function navigateClientUp() {
  const isWebkitDir = !hasFSApi() && hasWebkitDirSupport();
  if (isWebkitDir) {
    const cur = state.fileClientWebkitPath || '';
    const parentPath = webkitDirParent(cur);
    if (!parentPath) return;
    state.fileClientWebkitPath = parentPath;
    state.fileClientSelected.clear();
    el('clientDirLabel').textContent = parentPath + ' (只读模式)';
    renderClientFiles();
    return;
  }
  if (state.fileClientHandleStack.length <= 1) return;
  state.fileClientHandleStack.pop();
  const top = state.fileClientHandleStack[state.fileClientHandleStack.length - 1];
  el('clientDirLabel').textContent = '/' + state.fileClientHandleStack.map((p) => p.name).join('/');
  await loadClientDirectory(top.handle);
}

// --- group file operations ---

async function copyGroupFilesToLeft() {
  if (!state.fileGroupSelected.size) return notify('请先在右侧选中文件', 'warn');
  const isWebkitFallback = !hasFSApi() && hasWebkitDirSupport();
  const useServerCopy = state.fileLocalMode === 'server' || isWebkitFallback;
  if (state.fileLocalMode === 'client' && !isWebkitFallback && !state.fileClientDirHandle)
    return notify('请先在左侧选择客户端目录', 'warn');
  if (useServerCopy && !state.fileLocalPath) {
    try { await loadLocalFiles(''); } catch { return notify('无法访问容器存储', 'err'); }
  }

  let copied = 0;
  for (const fileId of state.fileGroupSelected) {
    const entry = [...(state.fileGroupEntries.files || [])]
      .find((e) => String(e.file_id || '') === fileId);
    if (!entry) continue;
    const fileName = String(entry.name || entry.file_name || fileId);

    // server mode / webkitDir: use server-side copy (no browser middleman, handles large files)
    if (useServerCopy) {
      try {
        const resp = await api('/backend/files/copy-to-local', 'POST', {
          type: 'group',
          id: state.fileGroupId,
          file_id: String(entry.file_id || ''),
          busid: String(entry.busid || ''),
          name: fileName,
          dirPath: state.fileLocalPath || '',
        });
        copied++;
        // when in webkitDir fallback, also trigger browser download to user's ~/Downloads
        if (isWebkitFallback && resp && resp.ok) {
          const dlUrl = `/files/${encodeURIComponent(fileName)}`;
          const a = document.createElement('a');
          a.href = dlUrl;
          a.download = fileName;
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }
      } catch (e) { notify(`失败 ${fileName}: ${e.message}`, 'err'); }
      continue;
    }

    // FSA client mode: download through browser to write to local FS
    const params = new URLSearchParams();
    params.set('type', 'group');
    params.set('id', state.fileGroupId);
    params.set('file_id', String(entry.file_id || ''));
    if (entry.busid) params.set('busid', String(entry.busid));
    params.set('name', fileName);
    const url = withAccessToken(`/backend/files/download?${params.toString()}`);

    try {
      let resp;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        resp = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
      } catch (_first) {
        const ctrl2 = new AbortController();
        const timer2 = setTimeout(() => ctrl2.abort(), 30000);
        resp = await fetch(url, { signal: ctrl2.signal });
        clearTimeout(timer2);
      }
      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try { const j = await resp.json(); if (j.error) detail = j.error; } catch {}
        notify(`下载失败(${detail}): ${fileName}`, 'err'); continue;
      }
      const blob = await resp.blob();
      const currentHandle = state.fileClientHandleStack.length > 0
        ? state.fileClientHandleStack[state.fileClientHandleStack.length - 1].handle
        : state.fileClientDirHandle;
      const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_');
      const fileHandle = await currentHandle.getFileHandle(safeName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      copied++;
    } catch (e) { notify(`失败 ${fileName}: ${e.message}`, 'err'); }
  }
  if (isWebkitFallback) {
    switchLocalModeToServer();
    await loadLocalFiles('');
        notify(`已保存 ${copied} 个文件到容器存储并触发浏览器下载`, 'ok');
  } else if (state.fileLocalMode === 'server') {
    notify(`已复制 ${copied} 个文件到左侧`, 'ok');
    await loadLocalFiles(state.fileLocalPath);
  } else {
    notify(`已复制 ${copied} 个文件到左侧`, 'ok');
    const handle = state.fileClientHandleStack.length > 0
      ? state.fileClientHandleStack[state.fileClientHandleStack.length - 1].handle
      : state.fileClientDirHandle;
    await loadClientDirectory(handle);
  }
}

async function renameSelectedGroupFile() {
  if (state.fileGroupSelected.size !== 1) return notify('请只选中一个文件/文件夹进行重命名', 'warn');
  const fileId = [...state.fileGroupSelected][0];
  const entry = [...(state.fileGroupEntries.files || []), ...(state.fileGroupEntries.folders || [])]
    .find((e) => String(e.file_id || e.folder_id || '') === fileId);
  if (!entry) return notify('找不到选中项', 'err');
  const oldName = String(entry.name || entry.file_name || entry.folder_name || fileId);
  const isFolder = !!(entry.folder_id || entry._type === 'folder');
  const oldExt = isFolder ? '' : fileExtension(oldName);
  const defaultName = isFolder ? oldName : nameWithoutExtension(oldName);
  const newName = prompt('请输入新名称:', defaultName);
  if (!newName || !newName.trim()) return;
  let finalName = newName.trim();
  if (!isFolder && oldExt && !finalName.endsWith(oldExt)) finalName += oldExt;
  if (finalName === oldName) return;
  const curDir = state.fileGroupPath.length ? '/' + state.fileGroupPath.map(p => p.id).join('/') : '/';
  try {
    await api('/backend/files/group/rename', 'POST', {
      group_id: state.fileGroupId,
      file_id: String(entry.file_id || entry.folder_id || ''),
      current_parent_directory: curDir,
      new_name: finalName,
    });
    notify('重命名成功', 'ok');
  } catch (e) {
    notify(e.message || '重命名失败，NapCat 可能不支持此操作', 'err');
  }
  const folderId = state.fileGroupPath.length ? state.fileGroupPath[state.fileGroupPath.length - 1].id : '';
  loadGroupFiles(state.fileGroupId, folderId).catch(() => {});
}

async function moveSelectedGroupFiles() {
  if (!state.fileGroupSelected.size) return notify('请先选中要移动的文件/文件夹', 'warn');
  const folders = (state.fileGroupEntries.folders || []).map(f => ({
    id: String(f.folder_id || ''),
    name: String(f.folder_name || f.folder_id || '')
  }));
  const folderListStr = folders.length ? folders.map(f => `${f.name} (ID: ${f.id})`).join('\n') : '(无子文件夹)';
  const targetInput = prompt(`当前目录下的文件夹:\n${folderListStr}\n\n请输入目标文件夹 名称 或 ID（留空=根目录）:`, '');
  if (targetInput === null) return;
  const input = targetInput.trim();
  const curDir = state.fileGroupPath.length ? '/' + state.fileGroupPath.map(p => p.id).join('/') : '/';
  let targetDir = '/';
  if (input) {
    // 1) exact ID match (with or without leading /)
    const exactById = folders.find(f => f.id === input || '/' + f.id === input);
    if (exactById) {
      targetDir = '/' + exactById.id;
    } else {
      // 2) case-insensitive name match
      const lower = input.toLowerCase();
      const byName = folders.find(f => String(f.name || '').toLowerCase() === lower);
      if (byName) {
        targetDir = '/' + byName.id;
      } else {
        // 3) fallback: treat as raw path
        targetDir = input.startsWith('/') ? input : '/' + input;
      }
    }
  }
  let moved = 0;
  for (const fileId of state.fileGroupSelected) {
    const entry = [...(state.fileGroupEntries.files || []), ...(state.fileGroupEntries.folders || [])]
      .find((e) => String(e.file_id || e.folder_id || '') === fileId);
    if (!entry) continue;
    try {
      await api('/backend/files/group/move', 'POST', {
        group_id: state.fileGroupId,
        file_id: String(entry.file_id || entry.folder_id || ''),
        current_parent_directory: curDir,
        target_parent_directory: targetDir,
      });
      moved++;
    } catch (e) { notify(`移动失败: ${e.message}`, 'err'); }
  }
  notify(`已移动 ${moved} 个项目`, 'ok');
  const curFolderId = state.fileGroupPath.length ? state.fileGroupPath[state.fileGroupPath.length - 1].id : '';
  loadGroupFiles(state.fileGroupId, curFolderId).catch(() => {});
}

// --- upload to group: client mode support ---

const _uploadLocalToGroupOrig = uploadLocalToGroup;
uploadLocalToGroup = async function () {
  if (!state.fileGroupId) return notify('请先选择目标群聊', 'warn');
  if (state.fileLocalMode === 'client') {
    if (!state.fileClientSelected.size) return notify('请先在左侧选中要上传的文件', 'warn');
    for (const cname of state.fileClientSelected) {
      const entry = state.fileClientEntries.find((e) => e.name === cname);
      if (!entry || entry.type === 'folder') continue;
      try {
        const file = entry._fileObj || await entry.handle.getFile();
        const uploadRes = await uploadLocalFile(file, 'file');
        const url = String(uploadRes.url || uploadRes.relativeUrl || '');
        await api('/backend/messages/send', 'POST', {
          type: 'group', id: state.fileGroupId,
          segments: [{ type: 'file', data: { file: url, name: entry.name } }],
        });
        notify(`已上传: ${entry.name}`, 'ok');
      } catch (e) { notify(`上传失败 ${entry.name}: ${e.message}`, 'err'); }
    }
    state.fileClientSelected.clear();
    const handle = state.fileClientHandleStack.length > 0
      ? state.fileClientHandleStack[state.fileClientHandleStack.length - 1].handle
      : state.fileClientDirHandle;
    if (handle) await loadClientDirectory(handle);
    const folderId = state.fileGroupPath.length ? state.fileGroupPath[state.fileGroupPath.length - 1].id : '';
    loadGroupFiles(state.fileGroupId, folderId).catch(() => {});
    return;
  }
  return _uploadLocalToGroupOrig();
};

function refreshFileGroupSelect() {
  const sel = el('fileGroupSelect');
  // only show whitelisted groups
  const groups = state.conversations.filter((c) => c.type === 'group' && isWhitelisted(c.type, c.id));
  sel.innerHTML = '<option value="">-- 选择群聊（仅白名单） --</option>';
  groups.forEach((g) => {
    const op = document.createElement('option');
    op.value = g.id;
    op.textContent = conversationLabel(g);
    sel.appendChild(op);
  });
  if (state.fileGroupId && groups.some((g) => g.id === state.fileGroupId)) {
    sel.value = state.fileGroupId;
  } else {
    state.fileGroupId = '';
    state.fileGroupPath = [];
    state.fileGroupEntries = { files: [], folders: [] };
    el('groupFolderLabel').textContent = '根目录';
    renderGroupFiles();
  }
}

function connectRealtime() {
  if (state.sse) state.sse.close();
  state.sse = new EventSource(withAccessToken('/backend/events'));
  state.sse.onopen = () => {
    setConn('实时推送已开启', true);
    addLog('system', 'SSE connected');
    notify('实时推送已开启', 'ok');
  };
  state.sse.onerror = () => {
    addLog('error', 'SSE error');
    setConn('实时推送异常', false, true);
  };
  state.sse.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (data.type === 'system') {
        addLog('system', String(data.text || 'system'));
        if (data.text === 'napcat_connected') setConn('NapCat已连接', true);
        if (data.text === 'napcat_disconnected') setConn('NapCat已断开', false, true);
        return;
      }
      if (data.type !== 'message') return;
      const msg = data.payload;
      if (!isWhitelisted(msg.type, msg.id)) return;
      const key = convKey(msg.type, msg.id);
      addMessages({ type: msg.type, id: msg.id }, [msg], true);
      if (key !== state.activeConv) {
        state.unread[key] = Number(state.unread[key] || 0) + 1;
        saveProfileData();
        renderConversations();
        notify(`新消息：${key}`, 'warn');
      }
    } catch (_) {}
  };
}

function bindEvents() {
  el('tabConsole').onclick = () => switchTab('console');
  el('tabFiles').onclick = () => switchTab('files');
  el('tabDevices').onclick = () => switchTab('devices');
  el('tabSettings').onclick = () => switchTab('settings');
  el('tabLogs').onclick = () => switchTab('logs');

  el('authLoginBtn').onclick = () => runAction('authLoginBtn', async () => {
    const token = el('authTokenInput').value.trim();
    await tryLoginWithToken(token, true);
  }, '校验中...');
  el('authTokenInput').onkeydown = (evt) => {
    if (evt.key === 'Enter') {
      evt.preventDefault();
      el('authLoginBtn').click();
    }
  };

  el('changePasswordBtn').onclick = () => runAction('changePasswordBtn', async () => {
    const p1 = el('newPasswordInput').value.trim();
    const p2 = el('confirmPasswordInput').value.trim();
    if (!p1 || p1.length < 4) { el('changePasswordTip').textContent = '密码至少需要4位字符'; return; }
    if (p1 !== p2) { el('changePasswordTip').textContent = '两次输入的密码不一致'; return; }
    await api('/backend/access-token', 'POST', { token: p1 });
    setClientToken(p1);
    state.accessToken = p1;
    el('accessToken').value = p1;
    hideChangePasswordModal();
    notify('密码已更新，请牢记新密码', 'ok');
  }, '设置中...');
  el('confirmPasswordInput').onkeydown = (evt) => {
    if (evt.key === 'Enter') { evt.preventDefault(); el('changePasswordBtn').click(); }
  };

  el('saveToken').onclick = () => runAction('saveToken', async () => {
    const token = el('wsToken').value.trim();
    await api('/backend/ws-token', 'POST', { token });
    await refreshHealth();
    notify('Token已保存', 'ok');
  }, '保存中...');

  el('refreshHealth').onclick = () => runAction('refreshHealth', () => refreshHealth(), '刷新中...');
  el('refreshList').onclick = () => runAction('refreshList', () => saveConversation(), '刷新中...');
  el('doSearch').onclick = () => runAction('doSearch', () => doSearch(), '搜索中...');

  el('clearWl').onclick = () => {
    state.whitelist = [];
    saveWhitelistToBackend().then(() => {
      updateRealtimeButton();
      notify('白名单已清空', 'warn');
    }).catch((e) => notify(e.message, 'err'));
  };

  // file management bindings
  el('localGoUp').onclick = () => {
    if (!state.fileLocalPath) return;
    const root = (state.fileLocalRoot || state.fileLocalPath || '').replace(/\/+$/, '');
    const cur = state.fileLocalPath.replace(/\/+$/, '');
    if (cur === root || cur.length <= root.length) {
      notify('已在根目录', 'warn');
      return;
    }
    const parent = cur.split('/').slice(0, -1).join('/') || '/';
    loadLocalFiles(parent).catch((e) => notify(e.message, 'err'));
  };
  el('localGoBtn').onclick = () => {
    const p = el('localPathInput').value.trim();
    if (!p) return;
    loadLocalFiles(p).catch((e) => notify(e.message, 'err'));
  };
  el('localRefreshBtn').onclick = () => loadLocalFiles(state.fileLocalPath).catch((e) => notify(e.message, 'err'));
  el('localUploadToGroup').onclick = () => runAction('localUploadToGroup', () => uploadLocalToGroup(), '上传中...');
  el('localMkdir').onclick = () => createLocalFolder();
  el('localSetBg').onclick = () => runAction('localSetBg', () => setLocalFileAsBackground(), '设置中...');
  el('localRename').onclick = () => runAction('localRename', () => renameSelectedLocalFile(), '重命名中...');
  el('localPathInput').onkeydown = (evt) => {
    if (evt.key === 'Enter') el('localGoBtn').click();
  };

  // left panel mode toggle
  el('localModeServer').onclick = () => switchLocalMode('server');
  el('localModeClient').onclick = () => switchLocalMode('client');
  // client nav bindings
  el('clientGoUp').onclick = () => navigateClientUp();
  el('clientPickDir').onclick = async () => {
    if (!hasFSApi() && hasWebkitDirSupport()) {
      el('webkitDirPicker').click();
      return;
    }
    const handle = await pickClientDirectory();
    if (!handle) return;
    state.fileClientDirHandle = handle;
    state.fileClientDirName = handle.name;
    state.fileClientHandleStack = [{ name: handle.name, handle }];
    el('clientDirLabel').textContent = handle.name;
    await loadClientDirectory(handle);
  };
  el('clientRefreshBtn').onclick = async () => {
    if (!hasFSApi() && hasWebkitDirSupport()) {
      el('webkitDirPicker').click();
      return;
    }
    const handle = state.fileClientHandleStack.length > 0
      ? state.fileClientHandleStack[state.fileClientHandleStack.length - 1].handle
      : state.fileClientDirHandle;
    if (handle) await loadClientDirectory(handle);
  };
  el('webkitDirPicker').onchange = (evt) => handleWebkitDirSelection(evt);

  el('fileGroupSelect').onchange = () => {
    state.fileGroupId = el('fileGroupSelect').value;
    state.fileGroupPath = [];
    el('groupFolderLabel').textContent = '根目录';
    if (state.fileGroupId) {
      loadGroupFiles(state.fileGroupId, '').catch((e) => notify(e.message, 'err'));
    } else {
      state.fileGroupEntries = { files: [], folders: [] };
      renderGroupFiles();
    }
  };
  el('refreshGroupFiles').onclick = () => {
    if (!state.fileGroupId) return notify('请先选择群聊', 'warn');
    const folderId = state.fileGroupPath.length ? state.fileGroupPath[state.fileGroupPath.length - 1].id : '';
    loadGroupFiles(state.fileGroupId, folderId).catch((e) => notify(e.message, 'err'));
  };
  el('groupGoUp').onclick = () => navigateGroupUp();
  el('groupDownloadSelected').onclick = () => runAction('groupDownloadSelected', () => downloadSelectedGroupFiles(), '下载中...');
  el('groupCopyToLeft').onclick = () => runAction('groupCopyToLeft', () => copyGroupFilesToLeft(), '复制中...');
  el('groupDeleteSelected').onclick = () => runAction('groupDeleteSelected', () => deleteSelectedGroupFiles(), '删除中...');
  el('groupRename').onclick = () => runAction('groupRename', () => renameSelectedGroupFile(), '重命名中...');
  el('groupMove').onclick = () => runAction('groupMove', () => moveSelectedGroupFiles(), '移动中...');
  el('groupMkdir').onclick = () => {
    if (!state.fileGroupId) return notify('请先选择群聊', 'warn');
    createGroupFolder();
  };

  el('pullHistory').onclick = () => runAction('pullHistory', () => pullHistory({ append: true }), '拉取中...');
  el('sendMsg').onclick = () => runAction('sendMsg', () => sendMessage(), '发送中...');
  el('textMsg').onkeydown = (evt) => {
    if (evt.key === 'Enter' && (evt.ctrlKey || evt.metaKey)) {
      evt.preventDefault();
      el('sendMsg').click();
    }
  };
  el('toggleRealtime').onclick = () => runAction('toggleRealtime', () => toggleRealtimeForActive(), '处理中...');
  el('manageConv').onclick = () => openConvManageModal();
  el('pickImage').onclick = () => runAction('pickImage', () => pickAndUploadImage(), '选择中...');
  el('pickFile').onclick = () => runAction('pickFile', () => pickAndUploadFile(), '选择中...');
  el('imagePicker').onchange = () => {
    runAction('pickImage', () => onPickedImage(), '上传中...').catch(() => {});
  };
  el('filePicker').onchange = () => {
    runAction('pickFile', () => onPickedFile(), '上传中...').catch(() => {});
  };
  el('mobileConvSelect').onchange = () => {
    const key = el('mobileConvSelect').value;
    if (!key) return;
    setActiveConversation(key, true).catch((e) => notify(e.message, 'err'));
  };
  el('activeConv').onchange = () => {
    state.activeConv = el('activeConv').value.trim();
    updateRealtimeButton();
  };

  el('saveAccessToken').onclick = () => runAction('saveAccessToken', () => saveAccessToken(), '保存中...');
  el('refreshDevices').onclick = () => runAction('refreshDevices', () => refreshDevices(), '刷新中...');
  el('convManageClose').onclick = () => closeConvManageModal();
  el('convManageSave').onclick = () => saveConvManage();
  el('convSearchBtn').onclick = () => searchInManageConversations();
  el('convSearchClear').onclick = () => clearManageSearch();
  el('convSearchKeyword').onkeydown = (evt) => {
    if (evt.key === 'Enter') {
      evt.preventDefault();
      searchInManageConversations();
    }
  };
  // settings: live preview + unified save
  el('bgImageUrl').oninput = () => {
    state.custom.bgImageUrl = el('bgImageUrl').value.trim();
    applyCustomStyles();
  };
  el('pickBgImage').onclick = () => {
    const picker = el('bgImagePicker');
    picker.value = '';
    picker.click();
  };
  el('bgImagePicker').onchange = () => {
    (async () => {
      const picker = el('bgImagePicker');
      const file = picker.files && picker.files[0];
      if (!file) return;
      const res = await uploadLocalFile(file, 'image');
      const url = String(res.url || res.relativeUrl || '').trim();
      el('bgImageUrl').value = url;
      state.custom.bgImageUrl = url;
      applyCustomStyles();
      notify('已选取本机背景图，点击"保存设置"持久化', 'ok');
    })().catch((e) => notify(e.message || '背景图上传失败', 'err'));
  };
  el('bgOpacity').oninput = () => {
    state.custom.bgOpacity = Number(el('bgOpacity').value) || 20;
    el('bgOpacityLabel').textContent = `${state.custom.bgOpacity}%`;
    applyCustomStyles();
  };
  el('bgPosX').oninput = () => {
    state.custom.bgPosX = Number(el('bgPosX').value) || 50;
    el('bgPosXLabel').textContent = `${state.custom.bgPosX}%`;
    applyCustomStyles();
  };
  el('bgPosY').oninput = () => {
    state.custom.bgPosY = Number(el('bgPosY').value) || 50;
    el('bgPosYLabel').textContent = `${state.custom.bgPosY}%`;
    applyCustomStyles();
  };
  el('selfMsgColorPicker').oninput = () => {
    state.custom.selfMsgColor = el('selfMsgColorPicker').value || '#ffe4a8';
    syncSelfColorPreview();
    renderMessages();
  };
  el('saveAllSettings').onclick = () => {
    runAction('saveAllSettings', async () => {
      await saveCustomSettings();
      notify('设置已保存', 'ok');
    }, '保存中...');
  };
  el('refreshLogs').onclick = () => runAction('refreshLogs', async () => {
    await refreshAuditLogsData();
    renderLogs();
  }, '刷新中...');
  el('exportLogs').onclick = () => runAction('exportLogs', () => exportLogs(), '导出中...');
  ['logDebug', 'logInfo', 'logWarn', 'logError', 'logSystem'].forEach((id) => {
    el(id).onchange = () => syncLogFilterFromUI();
  });

  if (state.authed) connectRealtime();
  const convModal = el('convManageModal');
  convModal.onclick = (evt) => {
    if (evt.target.id === 'convManageModal') closeConvManageModal();
  };
  const modal = el('imgModal');
  modal.onclick = (evt) => {
    if (evt.target.id !== 'imgModalView') closeImageModal();
  };
  el('imgModalClose').onclick = () => closeImageModal();
  document.addEventListener('keydown', (evt) => {
    if (evt.key === 'Escape') {
      closeImageModal();
      closeConvManageModal();
    }
  });
}

async function boot() {
  await loadPinyinDict();
  loadCustomSettingsFromCache();
  applyCustomStyles();
  if (URL_TOKEN) setClientToken(URL_TOKEN);
  try {
    await loadInitial();
  } catch (e) {
    if (isAuthRequiredError(e)) {
      state.authed = false;
      setConn('需要访问Token', false, true);
      showAuthModal('请输入访问Token后进入页面');
      const autoToken = URL_TOKEN || getClientToken();
      if (autoToken) {
        try {
          await tryLoginWithToken(autoToken, false);
        } catch (_) {
          showAuthModal('Token无效，请手动输入');
        }
      }
    } else {
      throw e;
    }
  }
  bindEvents();
  try {
    await saveWhitelistToBackend();
  } catch (_) {}
}

boot().catch((e) => {
  setConn('启动失败', false, true);
  notify(e.message, 'err');
});
