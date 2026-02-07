const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const mysql = require('mysql2/promise');

// Configuración
const PORT = process.env.PORT || 10001;
const ALLOWED_ORIGINS = [
    'https://gerges-online.xo.je',
    'http://localhost:3000',
    'http://localhost'
];

// Conexión a la base de datos
const dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Almacenamiento en memoria
const onlineUsers = new Map(); // userId -> { ws, username, ... }
const userSockets = new Map(); // userId -> Set of WebSockets

const server = http.createServer((req, res) => {
    // CORS HEADERS
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    if (req.url === '/health') {
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(JSON.stringify({ 
            status: 'ok', 
            online: onlineUsers.size,
            timestamp: new Date().toISOString()
        }));
        return;
    }
    
    res.writeHead(404);
    res.end();
});

const wss = new WebSocket.Server({ 
    server, 
    path: '/chat-ws',
    perMessageDeflate: false,
    verifyClient: (info, callback) => {
        const origin = info.origin || info.req.headers.origin;
        const parsedUrl = url.parse(info.req.url, true);
        const userId = parseInt(parsedUrl.query.user);
        
        // Verificar origen
        if (!ALLOWED_ORIGINS.includes(origin)) {
            console.log(`❌ Origen no permitido: ${origin}`);
            callback(false, 403, 'Origen no permitido');
            return;
        }
        
        // Verificar usuario
        if (!userId || isNaN(userId)) {
            console.log(`❌ ID de usuario inválido: ${parsedUrl.query.user}`);
            callback(false, 400, 'ID de usuario requerido');
            return;
        }
        
        callback(true);
    }
});

wss.on('connection', async (ws, req) => {
    const query = url.parse(req.url, true).query;
    const userId = parseInt(query.user);
    const username = decodeURIComponent(query.username || 'Usuario');
    const token = query.token || '';
    
    if (!userId) {
        ws.close(1008, 'ID de usuario requerido');
        return;
    }
    
    console.log(`🔌 Usuario conectado: ${username} (${userId})`);
    
    // Registrar usuario
    onlineUsers.set(userId, { ws, username, userId });
    
    // Agregar socket a la lista
    if (!userSockets.has(userId)) {
        userSockets.set(userId, new Set());
    }
    userSockets.get(userId).add(ws);
    
    // Actualizar estado en la base de datos
    await updateUserOnlineStatus(userId, true);
    
    // Enviar confirmación
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Conectado al servidor de chat',
        user: { id: userId, username: username }
    }));
    
    // Notificar a amigos que están en línea
    await notifyFriendsOnline(userId, username);
    
    // Enviar notificaciones pendientes
    await sendPendingNotifications(userId, ws);
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            await handleMessage(userId, username, message, ws);
        } catch (error) {
            console.error('Error procesando mensaje:', error);
        }
    });
    
    ws.on('close', async () => {
        console.log(`👋 Usuario desconectado: ${username} (${userId})`);
        
        // Remover socket
        if (userSockets.has(userId)) {
            userSockets.get(userId).delete(ws);
            
            // Si no hay más sockets, marcar como desconectado
            if (userSockets.get(userId).size === 0) {
                userSockets.delete(userId);
                onlineUsers.delete(userId);
                await updateUserOnlineStatus(userId, false);
                
                // Notificar a amigos que está desconectado
                await notifyFriendsOffline(userId);
            }
        }
    });
    
    ws.on('error', (error) => {
        console.error(`Error en WebSocket de ${username}:`, error);
    });
});

async function handleMessage(userId, username, message, ws) {
    switch (message.type) {
        case 'private_message':
            await handlePrivateMessage(userId, username, message);
            break;
            
        case 'friend_request':
            await handleFriendRequest(userId, username, message);
            break;
            
        case 'friend_request_response':
            await handleFriendRequestResponse(userId, username, message);
            break;
            
        case 'typing':
            await handleTypingNotification(userId, username, message);
            break;
            
        case 'read_receipt':
            await handleReadReceipt(userId, message);
            break;
            
        case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
    }
}

async function handlePrivateMessage(senderId, senderName, message) {
    const { to_user_id, message: messageText, timestamp } = message;
    
    try {
        // Guardar en la base de datos
        const [result] = await dbPool.execute(
            'INSERT INTO chat_messages (sender_id, receiver_id, message) VALUES (?, ?, ?)',
            [senderId, to_user_id, messageText]
        );
        
        const messageId = result.insertId;
        
        // Crear notificación
        await dbPool.execute(
            'INSERT INTO chat_notifications (user_id, type, from_user_id, message) VALUES (?, "message", ?, ?)',
            [to_user_id, senderId, messageText.substring(0, 100)]
        );
        
        // Enviar al receptor si está en línea
        if (onlineUsers.has(to_user_id)) {
            const receiver = onlineUsers.get(to_user_id);
            receiver.ws.send(JSON.stringify({
                type: 'private_message',
                from_user_id: senderId,
                from_username: senderName,
                to_user_id: to_user_id,
                message: messageText,
                message_id: messageId,
                timestamp: timestamp || Date.now()
            }));
        }
        
    } catch (error) {
        console.error('Error guardando mensaje:', error);
    }
}

async function handleFriendRequest(senderId, senderName, message) {
    const { to_user_id } = message;
    
    try {
        // Crear notificación en la base de datos
        await dbPool.execute(
            'INSERT INTO chat_notifications (user_id, type, from_user_id) VALUES (?, "friend_request", ?)',
            [to_user_id, senderId]
        );
        
        // Enviar notificación al receptor si está en línea
        if (onlineUsers.has(to_user_id)) {
            const receiver = onlineUsers.get(to_user_id);
            receiver.ws.send(JSON.stringify({
                type: 'friend_request',
                from_user_id: senderId,
                from_username: senderName,
                to_user_id: to_user_id,
                timestamp: Date.now()
            }));
        }
        
    } catch (error) {
        console.error('Error enviando solicitud de amistad:', error);
    }
}

async function handleFriendRequestResponse(userId, username, message) {
    const { request_id, from_user_id, status } = message;
    
    try {
        // Actualizar estado en la base de datos
        await dbPool.execute(
            'UPDATE friends SET status = ?, updated_at = NOW() WHERE user_id = ? AND friend_id = ?',
            [status, from_user_id, userId]
        );
        
        // Crear notificación si es aceptada
        if (status === 'accepted') {
            await dbPool.execute(
                'INSERT INTO chat_notifications (user_id, type, from_user_id) VALUES (?, "friend_accepted", ?)',
                [from_user_id, userId]
            );
        }
        
        // Enviar respuesta al solicitante original si está en línea
        if (onlineUsers.has(from_user_id)) {
            const originalSender = onlineUsers.get(from_user_id);
            originalSender.ws.send(JSON.stringify({
                type: 'friend_request_response',
                request_id: request_id,
                from_user_id: userId,
                from_username: username,
                to_user_id: from_user_id,
                status: status,
                timestamp: Date.now()
            }));
        }
        
    } catch (error) {
        console.error('Error procesando respuesta de solicitud:', error);
    }
}

async function handleTypingNotification(userId, username, message) {
    const { to_user_id, is_typing } = message;
    
    // Enviar notificación de "escribiendo..." al receptor si está en línea
    if (onlineUsers.has(to_user_id)) {
        const receiver = onlineUsers.get(to_user_id);
        receiver.ws.send(JSON.stringify({
            type: 'typing',
            from_user_id: userId,
            from_username: username,
            is_typing: is_typing,
            timestamp: Date.now()
        }));
    }
}

async function handleReadReceipt(userId, message) {
    const { message_id, from_user_id } = message;
    
    try {
        // Marcar mensaje como leído en la base de datos
        await dbPool.execute(
            'UPDATE chat_messages SET is_read = TRUE WHERE id = ? AND receiver_id = ?',
            [message_id, userId]
        );
        
        // Notificar al remitente si está en línea
        if (onlineUsers.has(from_user_id)) {
            const sender = onlineUsers.get(from_user_id);
            sender.ws.send(JSON.stringify({
                type: 'read_receipt',
                message_id: message_id,
                read_by: userId,
                timestamp: Date.now()
            }));
        }
        
    } catch (error) {
        console.error('Error actualizando estado de lectura:', error);
    }
}

async function updateUserOnlineStatus(userId, isOnline) {
    try {
        await dbPool.execute(
            'UPDATE users SET is_online = ?, last_seen = NOW() WHERE id = ?',
            [isOnline ? 1 : 0, userId]
        );
    } catch (error) {
        console.error('Error actualizando estado:', error);
    }
}

async function notifyFriendsOnline(userId, username) {
    try {
        // Obtener amigos
        const [friends] = await dbPool.execute(
            `SELECT u.id 
             FROM friends f 
             JOIN users u ON (f.user_id = ? AND f.friend_id = u.id) 
                OR (f.friend_id = ? AND f.user_id = u.id) 
             WHERE f.status = 'accepted' AND u.is_online = 1`,
            [userId, userId]
        );
        
        // Notificar a cada amigo en línea
        friends.forEach(friend => {
            if (onlineUsers.has(friend.id)) {
                const friendWs = onlineUsers.get(friend.id).ws;
                friendWs.send(JSON.stringify({
                    type: 'friend_online',
                    user_id: userId,
                    username: username,
                    timestamp: Date.now()
                }));
            }
        });
        
    } catch (error) {
        console.error('Error notificando amigos:', error);
    }
}

async function notifyFriendsOffline(userId) {
    try {
        // Obtener amigos
        const [friends] = await dbPool.execute(
            `SELECT u.id 
             FROM friends f 
             JOIN users u ON (f.user_id = ? AND f.friend_id = u.id) 
                OR (f.friend_id = ? AND f.user_id = u.id) 
             WHERE f.status = 'accepted' AND u.is_online = 1`,
            [userId, userId]
        );
        
        // Notificar a cada amigo en línea
        friends.forEach(friend => {
            if (onlineUsers.has(friend.id)) {
                const friendWs = onlineUsers.get(friend.id).ws;
                friendWs.send(JSON.stringify({
                    type: 'friend_offline',
                    user_id: userId,
                    timestamp: Date.now()
                }));
            }
        });
        
    } catch (error) {
        console.error('Error notificando amigos:', error);
    }
}

async function sendPendingNotifications(userId, ws) {
    try {
        // Obtener mensajes no leídos
        const [unreadMessages] = await dbPool.execute(
            `SELECT cm.*, u.username as sender_username
             FROM chat_messages cm
             JOIN users u ON cm.sender_id = u.id
             WHERE cm.receiver_id = ? AND cm.is_read = FALSE
             ORDER BY cm.created_at DESC
             LIMIT 10`,
            [userId]
        );
        
        // Obtener notificaciones no leídas
        const [notifications] = await dbPool.execute(
            `SELECT cn.*, u.username as from_username
             FROM chat_notifications cn
             LEFT JOIN users u ON cn.from_user_id = u.id
             WHERE cn.user_id = ? AND cn.is_read = FALSE
             ORDER BY cn.created_at DESC
             LIMIT 10`,
            [userId]
        );
        
        // Enviar mensajes no leídos
        unreadMessages.forEach(msg => {
            ws.send(JSON.stringify({
                type: 'private_message',
                from_user_id: msg.sender_id,
                from_username: msg.sender_username,
                to_user_id: userId,
                message: msg.message,
                message_id: msg.id,
                timestamp: new Date(msg.created_at).getTime()
            }));
        });
        
        // Enviar notificaciones
        notifications.forEach(notif => {
            ws.send(JSON.stringify({
                type: notif.type,
                notification_id: notif.id,
                from_user_id: notif.from_user_id,
                from_username: notif.from_username,
                message: notif.message,
                timestamp: new Date(notif.created_at).getTime()
            }));
        });
        
    } catch (error) {
        console.error('Error enviando notificaciones pendientes:', error);
    }
}

server.listen(PORT, () => {
    console.log(`💬 Servidor de chat iniciado en el puerto ${PORT}`);
    console.log(`🔗 URL del servidor: ws://localhost:${PORT}/chat-ws`);
    console.log(`🏥 Endpoint de salud: http://localhost:${PORT}/health`);
});

// Limpieza periódica
setInterval(() => {
    console.log(`👥 Usuarios en línea: ${onlineUsers.size}`);
}, 60000);

// Manejo de cierre
process.on('SIGINT', async () => {
    console.log('\n👋 Apagando servidor de chat...');
    
    // Marcar todos los usuarios como desconectados
    for (const userId of onlineUsers.keys()) {
        await updateUserOnlineStatus(userId, false);
    }
    
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n👋 Apagando servidor de chat...');
    
    // Marcar todos los usuarios como desconectados
    for (const userId of onlineUsers.keys()) {
        await updateUserOnlineStatus(userId, false);
    }
    
    process.exit(0);
});
