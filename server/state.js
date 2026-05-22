const fs = require('fs');
const path = require('path');
const config = require('./config');

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
  if (!fs.existsSync(config.DATA_FILE)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(config.DATA_FILE, 'utf8'));
    const rules = Array.isArray(parsed.accessRules) ? parsed.accessRules : [];
    const legacyRule = rules.find((x) => String((x && x.host) || '').toLowerCase() === '0.0.0.0' && Number((x && x.port)) === config.PORT);
    return {
      wsToken: String(parsed.wsToken || 'napcat_ws_token'),
      accessToken: String(parsed.accessToken || (legacyRule && legacyRule.token) || '').trim() || 'easyqq',
    loginFailures: Number(parsed.loginFailures || 0),
      uiSettings: parsed.uiSettings && typeof parsed.uiSettings === 'object'
        ? {
          bgImageUrl: String(parsed.uiSettings.bgImageUrl || ''),
          bgOpacity: Number(parsed.uiSettings.bgOpacity || 20),
          bgPosX: Number(parsed.uiSettings.bgPosX || 50),
          bgPosY: Number(parsed.uiSettings.bgPosY || 50),
          selfMsgColor: String(parsed.uiSettings.selfMsgColor || '#dbeafe'),
        }
        : { bgImageUrl: '', bgOpacity: 20, bgPosX: 50, bgPosY: 50, selfMsgColor: '#dbeafe' },
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
  fs.writeFileSync(config.DATA_FILE, JSON.stringify(state, null, 2));
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
