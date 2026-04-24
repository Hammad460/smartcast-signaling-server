const http = require('http');
const { WebSocketServer } = require('ws');

const port = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('SmartCast signaling server is running.');
});

const wss = new WebSocketServer({ server, path: '/ws' });

const roomPeers = new Map();

function cleanupSocket(ws) {
  const roomId = ws.roomId;
  if (!roomId) return;

  const peers = roomPeers.get(roomId);
  if (!peers) return;

  peers.delete(ws);
  if (peers.size === 0) {
    roomPeers.delete(roomId);
  }
}

function safeSend(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.role = null;
  ws.isAlive = true;

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

  ws.on('error', () => {
    cleanupSocket(ws);
  });
});

const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      cleanupSocket(ws);
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

server.on('close', () => {
  clearInterval(heartbeatInterval);
});

server.listen(port, () => {
  console.log(`SmartCast signaling server listening on :${port}`);
});
