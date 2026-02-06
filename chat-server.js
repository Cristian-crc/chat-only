const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const mysql = require('mysql2/promise');

// Configuración
const PORT = process.env.PORT || 10001;

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
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            online: onlineUsers.size 
        }));
        return;
    }
    
    res.writeHead(404);
    res.end();
});

const wss = new WebSocket.Server({ 
    server, 
    path: '/chat-ws',
    perMessageDeflate: false
});

wss.on('connection', async (ws, req) => {
    const query = url.parse(req.url, true).query;
    const userId = parseInt(query.user);
    const username = decodeURIComponent(query.username || 'Usuario');
    
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
            
        case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
    }
}

async function handlePrivateMessage(senderId, senderName, message) {
    const { to_user_id, message: messageText, timestamp } = message;
    
    // Guardar en la base de datos
    try {
        const [result] = await dbPool.execute(
            'INSERT INTO chat_messages (sender_id, receiver_id, message) VALUES (?, ?, ?)',
            [senderId, to_user_id, messageText]
        );
        
        const messageId = result.insertId;
        
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
    
    // Enviar notificación al receptor
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
}

async function handleFriendRequestResponse(userId, username, message) {
    const { request_id, from_user_id, status } = message;
    
    // Enviar respuesta al solicitante original
    if (onlineUsers.has(from_user_id)) {
        const originalSender = onlineUsers.get(from_user_id);
        originalSender.ws.send(JSON.stringify({
            type: 'friend_request_response',
            request_id: request_id,
            from_user_id: userId,
            to_user_id: from_user_id,
            status: status,
            timestamp: Date.now()
        }));
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
        
        // Obtener solicitudes de amistad pendientes
        const [pendingRequests] = await dbPool.execute(
            `SELECT fr.*, u.username as sender_username
             FROM friends fr
             JOIN users u ON fr.user_id = u.id
             WHERE fr.friend_id = ? AND fr.status = 'pending'
             ORDER BY fr.created_at DESC
             LIMIT 10`,
            [userId]
        );
        
        // Enviar notificaciones
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
        
        pendingRequests.forEach(req => {
            ws.send(JSON.stringify({
                type: 'friend_request',
                from_user_id: req.user_id,
                from_username: req.sender_username,
                to_user_id: userId,
                timestamp: new Date(req.created_at).getTime()
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

process.on('SIGINT', () => {
    console.log('\n👋 Apagando servidor de chat...');
    process.exit(0);
});
