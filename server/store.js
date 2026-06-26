const fs = require('fs');
const path = require('path');
const config = require('./config');

// ---- file paths ----
const STORE_FILE = config.DATA_FILE; // settings only (tokens, ui, profiles, whitelist)
const CONVERSATIONS_FILE = path.join(config.DATA_DIR, 'conversations.json');
const MESSAGES_DIR = path.join(config.DATA_DIR, 'messages');
const DEVICES_FILE = path.join(config.DATA_DIR, 'devices.json');
const AUDIT_FILE = path.join(config.DATA_DIR, 'audit.jsonl');

// ensure messages dir exists
if (!fs.existsSync(MESSAGES_DIR)) fs.mkdirSync(MESSAGES_DIR, { recursive: true });

// sanitize conversation key for filename (group:123 → group_123)
function msgFileName(convKey) {
  return String(convKey).replace(/[^a-zA-Z0-9_\-.一-鿿]/g, '_') + '.jsonl';
}

// ---- helpers ----
function readJSON(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function appendJSONL(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

// ---- settings (small, full rewrite OK) ----
function loadSettings(defaults) {
  if (!fs.existsSync(STORE_FILE)) return { ...defaults };
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return {
      wsToken: String(raw.wsToken || defaults.wsToken || 'napcat_ws_token'),
      accessToken: String(raw.accessToken || defaults.accessToken || 'easyqq'),
      loginFailures: Number(raw.loginFailures || 0),
      uiSettings: raw.uiSettings && typeof raw.uiSettings === 'object'
        ? raw.uiSettings
        : (defaults.uiSettings || {}),
      activeProfile: String(raw.activeProfile || defaults.activeProfile || 'default'),
      profiles: raw.profiles && typeof raw.profiles === 'object'
        ? raw.profiles
        : (defaults.profiles || {}),
      whitelist: Array.isArray(raw.whitelist) ? raw.whitelist : (defaults.whitelist || []),
    };
  } catch {
    return { ...defaults };
  }
}

function saveSettings(settings) {
  writeJSON(STORE_FILE, {
    wsToken: settings.wsToken,
    accessToken: settings.accessToken,
    loginFailures: settings.loginFailures,
    uiSettings: settings.uiSettings,
    activeProfile: settings.activeProfile,
    profiles: settings.profiles,
    whitelist: settings.whitelist,
  });
}

// ---- conversations (small, full rewrite) ----
function loadConversations() {
  return readJSON(CONVERSATIONS_FILE, []);
}

function saveConversations(conversations) {
  writeJSON(CONVERSATIONS_FILE, conversations);
}

// ---- messages (JSONL, append-only per conversation) ----
function loadMessages(convKey) {
  const file = path.join(MESSAGES_DIR, msgFileName(convKey));
  if (!fs.existsSync(file)) return [];
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function appendMessage(msg) {
  const convKey = `${msg.type}:${msg.id}`;
  const file = path.join(MESSAGES_DIR, msgFileName(convKey));
  appendJSONL(file, msg);
}

// ---- devices (debounced write) ----
let deviceTimer = null;

function loadDevices() {
  return readJSON(DEVICES_FILE, []);
}

function saveDevicesDebounced(devices) {
  clearTimeout(deviceTimer);
  deviceTimer = setTimeout(() => {
    try {
      writeJSON(DEVICES_FILE, devices.slice(0, 200));
    } catch { /* ignore */ }
  }, 2000); // 2s debounce
}

// ---- audit (JSONL append-only) ----
function appendAudit(entry) {
  appendJSONL(AUDIT_FILE, entry);
}

function loadAuditLogs() {
  if (!fs.existsSync(AUDIT_FILE)) return [];
  try {
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// ---- migration from old store.json ----
function shouldMigrate() {
  if (!fs.existsSync(STORE_FILE)) return false;
  // Check if old store.json has conversations/messages/devices/auditLogs
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return Array.isArray(raw.conversations) || raw.messages || Array.isArray(raw.devices) || Array.isArray(raw.auditLogs);
  } catch {
    return false;
  }
}

function migrateFromOldStore() {
  if (!shouldMigrate()) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    console.log('[store] Migrating from old store.json to split files...');

    // conversations
    if (Array.isArray(raw.conversations) && raw.conversations.length) {
      saveConversations(raw.conversations);
      console.log(`[store]   → conversations.json (${raw.conversations.length} items)`);
    }

    // messages → per-conversation JSONL
    if (raw.messages && typeof raw.messages === 'object') {
      let msgCount = 0;
      for (const [convKey, msgs] of Object.entries(raw.messages)) {
        if (!Array.isArray(msgs) || !msgs.length) continue;
        const file = path.join(MESSAGES_DIR, msgFileName(convKey));
        for (const msg of msgs) {
          appendJSONL(file, msg);
          msgCount++;
        }
      }
      console.log(`[store]   → messages/*.jsonl (${msgCount} messages)`);
    }

    // devices
    if (Array.isArray(raw.devices) && raw.devices.length) {
      writeJSON(DEVICES_FILE, raw.devices.slice(0, 200));
      console.log(`[store]   → devices.json (${Math.min(raw.devices.length, 200)} items)`);
    }

    // audit
    if (Array.isArray(raw.auditLogs) && raw.auditLogs.length) {
      for (const entry of raw.auditLogs) {
        appendJSONL(AUDIT_FILE, entry);
      }
      console.log(`[store]   → audit.jsonl (${raw.auditLogs.length} items)`);
    }

    // rewrite store.json with settings only
    saveSettings({
      wsToken: raw.wsToken,
      accessToken: raw.accessToken,
      loginFailures: raw.loginFailures,
      uiSettings: raw.uiSettings,
      activeProfile: raw.activeProfile,
      profiles: raw.profiles,
      whitelist: raw.whitelist,
    });
    console.log('[store] Migration complete — old data removed from store.json');
  } catch (e) {
    console.log(`[store] Migration failed (safe to ignore): ${e.message}`);
  }
}

module.exports = {
  loadSettings, saveSettings,
  loadConversations, saveConversations,
  loadMessages, appendMessage,
  loadDevices, saveDevicesDebounced,
  appendAudit, loadAuditLogs,
  migrateFromOldStore, shouldMigrate,
};
