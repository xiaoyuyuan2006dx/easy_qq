const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');

function defaultState() {
  return {
    wsToken: 'napcat_ws_token',
    accessToken: 'easyqq',
    uiSettings: { bgImageUrl: '', bgOpacity: 20, bgPosX: 50, bgPosY: 50, selfMsgColor: '#dbeafe' },
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
    { ...config.FIXED_LOCAL_RULE },
    { ...config.FIXED_GLOBAL_RULE, token: String(state.accessToken || '').trim() },
  ];
}

function loadState() {
  // Run migration from old single-file store.json if needed
  store.migrateFromOldStore();

  const defaults = defaultState();

  // Load settings from store.json (tokens, ui, profiles, whitelist)
  const settings = store.loadSettings(defaults);

  // Load conversations separately
  const conversations = store.loadConversations();

  // Load all messages from per-conversation JSONL files
  const messages = {};
  const msgDir = path.join(config.DATA_DIR, 'messages');
  if (fs.existsSync(msgDir)) {
    try {
      for (const fname of fs.readdirSync(msgDir)) {
        if (!fname.endsWith('.jsonl')) continue;
        const convKey = fname.replace(/\.jsonl$/, '').replace(/_/g, ':');
        const msgs = store.loadMessages(convKey);
        if (msgs.length) messages[convKey] = msgs;
      }
    } catch { /* ignore */ }
  }

  // Load devices
  const devices = store.loadDevices();

  // Load audit logs
  const auditLogs = store.loadAuditLogs();

  return {
    ...settings,
    conversations,
    messages,
    devices,
    auditLogs,
  };
}

function saveState() {
  // Settings: full rewrite (small, changes rarely)
  store.saveSettings({
    wsToken: state.wsToken,
    accessToken: state.accessToken,
    loginFailures: state.loginFailures,
    uiSettings: state.uiSettings,
    activeProfile: state.activeProfile,
    profiles: state.profiles,
    whitelist: state.whitelist,
  });

  // Conversations: full rewrite (small, changes rarely)
  store.saveConversations(state.conversations);

  // Devices: debounced write (changes on every request)
  store.saveDevicesDebounced(state.devices);

  // Messages & audit: saved at source via append, not here
}

// --- shared mutable runtime state ---
const state = loadState();
const sseClients = new Set();
const runtime = {
  napcatSocket: null,
  napcatInfo: { connected: false, since: 0, selfId: '', name: '' },
  pendingRpc: new Map(),
  rpcSeq: 1,
};
const { getLocalIpv4List } = require('./network');
const localIps = getLocalIpv4List();
const preferredLanIp = localIps[0] || '';

module.exports = {
  state, sseClients, runtime,
  localIps, preferredLanIp,
  defaultState, loadState, saveState, getAccessRules,
};
