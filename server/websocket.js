const { runtime } = require('./state');
const { handleNapcatData } = require('./napcat');

const MAX_FRAME_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_BUFFER_SIZE = 16 * 1024 * 1024; // 16MB accumulated

function decodeFrames(socket, chunk) {
  socket._buf = socket._buf ? Buffer.concat([socket._buf, chunk]) : Buffer.from(chunk);
  // prevent unbounded buffer growth from slow-send attacks
  if (socket._buf.length > MAX_BUFFER_SIZE) {
    socket.end();
    return;
  }
  while (socket._buf.length >= 2) {
    const b1 = socket._buf[0];
    const b2 = socket._buf[1];
    const opcode = b1 & 0x0f;
    const masked = (b2 & 0x80) !== 0;
    let len = b2 & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (socket._buf.length < offset + 2) return;
      len = socket._buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (socket._buf.length < offset + 8) return;
      const v = socket._buf.readBigUInt64BE(offset);
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) return;
      len = Number(v);
      offset += 8;
    }

    // reject oversized frames
    if (len > MAX_FRAME_SIZE) {
      socket.end();
      return;
    }

    const maskLen = masked ? 4 : 0;
    if (socket._buf.length < offset + maskLen + len) return;

    let payload = socket._buf.subarray(offset + maskLen, offset + maskLen + len);
    if (masked) {
      const mask = socket._buf.subarray(offset, offset + 4);
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
      payload = out;
    }

    socket._buf = socket._buf.subarray(offset + maskLen + len);

    if (opcode === 0x8) {
      socket.end();
      return;
    }
    if (opcode === 0x9) {
      socket.write(Buffer.from([0x8a, 0x00]));
      continue;
    }
    if (opcode === 0x1) {
      handleNapcatData(payload.toString('utf8'));
    }
  }
}

module.exports = { decodeFrames };
