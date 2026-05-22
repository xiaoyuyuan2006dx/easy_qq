const { state, runtime } = require('./state');
const { broadcast } = require('./request');
const { nowSec, convKey } = require('./utils');
const { isWhitelisted, ensureConversation, normalizeSegmentsToText, normalizeIncomingSegments, appendMessage } = require('./message');
const { callOneBot } = require('./onebot-rpc');

function handleNapcatData(text) {
  let data;
  try { data = JSON.parse(text); } catch { return; }

  if (data.echo && runtime.pendingRpc.has(String(data.echo))) {
    const handler = runtime.pendingRpc.get(String(data.echo));
    runtime.pendingRpc.delete(String(data.echo));
    handler.resolve(data);
    return;
  }

  if (data.post_type === 'meta_event' && data.meta_event_type === 'lifecycle') {
    runtime.napcatInfo.selfId = String(data.self_id || runtime.napcatInfo.selfId || '');
    broadcast({ type: 'system', text: 'napcat_lifecycle', selfId: runtime.napcatInfo.selfId });
    // 拉取登录信息以获取昵称
    callOneBot('get_login_info', {}).then((info) => {
      const nick = (info && info.data && info.data.nickname) || '';
      if (nick) runtime.napcatInfo.nickname = nick;
    }).catch(() => {});
    return;
  }

  if (data.post_type === 'message' || data.post_type === 'message_sent') {
    const type = data.message_type === 'group' ? 'group' : 'private';
    const id = type === 'group' ? data.group_id : data.user_id;
    const isSelfSent = data.post_type === 'message_sent' || String(data.user_id || '') === String(runtime.napcatInfo.selfId || '');
    const sender = isSelfSent
      ? (runtime.napcatInfo.nickname || runtime.napcatInfo.selfId || '我')
      : ((data.sender && data.sender.card) || (data.sender && data.sender.nickname) || String(data.user_id || 'unknown'));
    const incomingSegments = normalizeIncomingSegments(data.message, data.raw_message);
    ensureConversation(type, id, type === 'group' ? `群${id}` : `QQ${id}`);
    const msg = {
      message_id: data.message_id,
      time: data.time || nowSec(),
      type,
      id: String(id),
      user_id: String(data.user_id || ''),
      sender,
      segments: incomingSegments,
      text: normalizeSegmentsToText(incomingSegments, data.raw_message),
    };
    appendMessage(msg);
    // also capture self nickname from incoming self messages
    if (isSelfSent && sender && sender !== '我' && !runtime.napcatInfo.nickname) {
      runtime.napcatInfo.nickname = sender;
    }
  }
}

module.exports = { handleNapcatData };
