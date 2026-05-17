const http = require('http');
const { WebSocketServer } = require('ws');

const port = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    const rooms = roomPeers.size;
    const peers = Array.from(roomPeers.values()).reduce((sum, set) => sum + set.size, 0);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms, peers, ts: new Date().toISOString() }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('SmartCast signaling server is running.');
});

const wss = new WebSocketServer({ server, path: '/ws' });

const roomPeers = new Map();

function log(message, meta = {}) {
  const payload = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[Signal ${new Date().toISOString()}] ${message}${payload}`);
}

function cleanupSocket(ws) {
  const roomId = ws.roomId;
  if (!roomId) return;

  const peers = roomPeers.get(roomId);
  if (!peers) return;

  peers.delete(ws);
  if (peers.size === 0) {
    roomPeers.delete(roomId);
  }

  log('peer removed', { roomId, role: ws.role, remaining: peers.size });
}

function safeSend(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

wss.on('connection', (ws, req) => {
  ws.roomId = null;
  ws.role = null;
  ws.isAlive = true;

  log('ws connected', { ip: req.socket.remoteAddress });

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      safeSend(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (message.type === 'join') {
      const roomId = message.roomId;
      const role = message.role;

      if (!roomId || (role !== 'sender' && role !== 'receiver')) {
        safeSend(ws, { type: 'error', message: 'Invalid join payload' });
        return;
      }

      ws.roomId = roomId;
      ws.role = role;

      if (!roomPeers.has(roomId)) {
        roomPeers.set(roomId, new Set());
      }
      roomPeers.get(roomId).add(ws);

      safeSend(ws, { type: 'joined', roomId, role });
      log('peer joined room', { roomId, role, roomPeers: roomPeers.get(roomId).size });
      return;
    }

    if (message.type === 'signal') {
      const roomId = message.roomId;
      const payload = message.payload;

      if (!roomId || !payload) {
        safeSend(ws, { type: 'error', message: 'Invalid signal payload' });
        return;
      }

      const peers = roomPeers.get(roomId);
      if (!peers) return;

      const signalType = payload.type || 'unknown';
      log('signal relay', { roomId, signalType, fanout: Math.max(peers.size - 1, 0) });

      for (const peer of peers) {
        if (peer === ws) continue;
        safeSend(peer, {
          type: 'signal',
          roomId,
          payload
        });
      }
      return;
    }

    safeSend(ws, { type: 'error', message: 'Unknown message type' });
  });

  ws.on('close', () => {
    cleanupSocket(ws);
  });

  ws.on('error', (error) => {
    log('ws error', { message: error.message });
    cleanupSocket(ws);
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      log('ws heartbeat timeout', { roomId: ws.roomId, role: ws.role });
      ws.terminate();
      return;
    }

    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on('close', () => {
  clearInterval(heartbeat);
});

server.listen(port, () => {
  log('signaling server listening', { port });
});
