const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

const clients = new Map();
const games = new Map();

const server = http.createServer((req, res) => {
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(__dirname, 'public', filePath);

    const ext = path.extname(filePath);
    const contentTypes = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.png': 'image/png',
        '.svg': 'image/svg+xml'
    };

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
        res.end(data);
    });
});

server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const hash = require('crypto')
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + hash + '\r\n\r\n'
    );

    const clientId = Math.random().toString(36).substr(2, 9);
    clients.set(clientId, { socket, gameId: null, color: null });

    sendToClient(socket, { type: 'connected', clientId });

    socket.on('data', (buffer) => {
        const message = parseWebSocketFrame(buffer);
        if (message) {
            handleMessage(clientId, message);
        }
    });

    socket.on('close', () => {
        const client = clients.get(clientId);
        if (client && client.gameId) {
            broadcastToGame(client.gameId, { type: 'opponent_left' }, clientId);
        }
        clients.delete(clientId);
    });

    socket.on('error', () => {
        clients.delete(clientId);
    });
});

function parseWebSocketFrame(buffer) {
    if (buffer.length < 2) return null;

    const secondByte = buffer[1];
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
        payloadLength = buffer.readUInt16BE(2);
        offset = 4;
    } else if (payloadLength === 127) {
        payloadLength = buffer.readBigUInt64BE(2);
        offset = 10;
    }

    let maskingKey;
    if (masked) {
        maskingKey = buffer.slice(offset, offset + 4);
        offset += 4;
    }

    const payload = buffer.slice(offset, offset + Number(payloadLength));

    if (masked) {
        for (let i = 0; i < payload.length; i++) {
            payload[i] ^= maskingKey[i % 4];
        }
    }

    try {
        return JSON.parse(payload.toString());
    } catch {
        return null;
    }
}

function sendToClient(socket, data) {
    const payload = JSON.stringify(data);
    const payloadBuffer = Buffer.from(payload);

    let frame;
    if (payloadBuffer.length <= 125) {
        frame = Buffer.alloc(2 + payloadBuffer.length);
        frame[0] = 0x81;
        frame[1] = payloadBuffer.length;
        payloadBuffer.copy(frame, 2);
    } else if (payloadBuffer.length <= 65535) {
        frame = Buffer.alloc(4 + payloadBuffer.length);
        frame[0] = 0x81;
        frame[1] = 126;
        frame.writeUInt16BE(payloadBuffer.length, 2);
        payloadBuffer.copy(frame, 4);
    } else {
        frame = Buffer.alloc(10 + payloadBuffer.length);
        frame[0] = 0x81;
        frame[1] = 127;
        frame.writeBigUInt64BE(BigInt(payloadBuffer.length), 2);
        payloadBuffer.copy(frame, 10);
    }

    try {
        socket.write(frame);
    } catch (e) {}
}

function broadcastToGame(gameId, data, excludeId = null) {
    const game = games.get(gameId);
    if (!game) return;

    for (const [clientId, client] of clients) {
        if (client.gameId === gameId && clientId !== excludeId) {
            sendToClient(client.socket, data);
        }
    }
}

function handleMessage(clientId, message) {
    const client = clients.get(clientId);
    if (!client) return;

    switch (message.type) {
        case 'create_game': {
            const gameId = Math.random().toString(36).substr(2, 6).toUpperCase();
            const timeControl = message.timeControl || 300;
            games.set(gameId, {
                white: clientId,
                black: null,
                moves: [],
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                started: false,
                timeControl: timeControl,
                whiteTime: timeControl,
                blackTime: timeControl
            });
            client.gameId = gameId;
            client.color = 'white';
            sendToClient(client.socket, {
                type: 'game_created',
                gameId,
                color: 'white',
                timeControl: timeControl
            });
            console.log(`Game ${gameId} created with ${timeControl}s time control`);
            break;
        }

        case 'join_game': {
            const game = games.get(message.gameId);
            if (!game) {
                sendToClient(client.socket, { type: 'error', message: 'Game not found' });
                return;
            }
            if (game.black) {
                sendToClient(client.socket, { type: 'error', message: 'Game is full' });
                return;
            }
            game.black = clientId;
            game.started = true;
            client.gameId = message.gameId;
            client.color = 'black';

            sendToClient(client.socket, {
                type: 'game_joined',
                gameId: message.gameId,
                color: 'black',
                fen: game.fen,
                timeControl: game.timeControl
            });

            broadcastToGame(message.gameId, {
                type: 'game_start',
                timeControl: game.timeControl
            }, clientId);

            console.log(`Player joined game ${message.gameId}`);
            break;
        }

        case 'move': {
            const game = games.get(client.gameId);
            if (!game) return;

            game.moves.push(message.move);
            game.fen = message.fen;
            game.whiteTime = message.whiteTime;
            game.blackTime = message.blackTime;

            broadcastToGame(client.gameId, {
                type: 'move',
                move: message.move,
                fen: message.fen,
                evaluation: message.evaluation,
                whiteTime: message.whiteTime,
                blackTime: message.blackTime
            }, clientId);
            break;
        }

        case 'timeout': {
            broadcastToGame(client.gameId, {
                type: 'timeout',
                loser: message.loser
            }, clientId);
            break;
        }

        case 'game_over': {
            broadcastToGame(client.gameId, {
                type: 'game_over',
                result: message.result,
                moves: message.moves
            }, clientId);
            break;
        }

        case 'chat': {
            broadcastToGame(client.gameId, {
                type: 'chat',
                message: message.message
            }, clientId);
            break;
        }

        case 'rematch': {
            const game = games.get(client.gameId);
            if (!game) return;

            const tempWhite = game.white;
            game.white = game.black;
            game.black = tempWhite;
            game.moves = [];
            game.fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
            game.whiteTime = game.timeControl;
            game.blackTime = game.timeControl;

            for (const [cId, c] of clients) {
                if (c.gameId === client.gameId) {
                    c.color = c.color === 'white' ? 'black' : 'white';
                    sendToClient(c.socket, {
                        type: 'rematch_start',
                        color: c.color,
                        timeControl: game.timeControl
                    });
                }
            }
            break;
        }
    }
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n╔════════════════════════════════════════╗`);
    console.log(`║     FAYEZ CHESS SERVER RUNNING         ║`);
    console.log(`╠════════════════════════════════════════╣`);
    console.log(`║  Local:   http://localhost:${PORT}        ║`);

    const interfaces = require('os').networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                const ip = iface.address;
                const padding = ' '.repeat(Math.max(0, 17 - ip.length));
                console.log(`║  Network: http://${ip}:${PORT}${padding}║`);
            }
        }
    }
    console.log(`╠════════════════════════════════════════╣`);
    console.log(`║  Share the Network URL with your       ║`);
    console.log(`║  friend to play together!              ║`);
    console.log(`╚════════════════════════════════════════╝\n`);
});
