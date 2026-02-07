const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const { Pool } = require('pg'); // Cambiar a PostgreSQL

// Configuración
const PORT = process.env.PORT || 10001;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? 
    process.env.ALLOWED_ORIGINS.split(',') : 
    ['https://gerges-online.xo.je', 'http://localhost:3000', 'http://localhost'];

// Conexión a PostgreSQL en Render
const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10, // Máximo de conexiones
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Verificar conexión a la base de datos
dbPool.query('SELECT NOW()', (err) => {
    if (err) {
        console.error('❌ Error conectando a PostgreSQL:', err.message);
    } else {
        console.log('✅ Conectado a PostgreSQL en Render');
    }
});

// Crear tablas si no existen
async function initDatabase() {
    try {
        // Tabla de mensajes
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS chat_messages (
                id SERIAL PRIMARY KEY,
                sender_id INTEGER NOT NULL,
                receiver_id INTEGER NOT NULL,
                message TEXT NOT NULL,
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_receiver (receiver_id, is_read),
                INDEX idx_sender (sender_id, created_at)
            )
        `);

        // Tabla de notificaciones
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS chat_notifications (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                type VARCHAR(50) NOT NULL,
                from_user_id INTEGER,
                message TEXT,
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_user_notif (user_id, is_read, created_at)
            )
        `);

        // Tabla de usuarios online (cache)
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS online_users_cache (
                user_id INTEGER PRIMARY KEY,
                username VARCHAR(100),
                socket_count INTEGER DEFAULT 1,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_last_seen (last_seen)
            )
        `);

        console.log('✅ Tablas de chat creadas/verificadas');
    } catch (error) {
        console.error('❌ Error inicializando base de datos:', error);
    }
}

// Almacenamiento en memoria para conexiones activas
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
    
    // Registrar usuario en memoria
    onlineUsers.set(userId, { ws, username, userId });
    
    // Agregar socket a la lista
    if (!userSockets.has(userId)) {
        userSockets.set(userId, new Set());
    }
    userSockets.get(userId).add(ws);
    
    // Actualizar en cache de PostgreSQL
    await updateUserOnlineCache(userId, username);
    
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
                await removeUserFromCache(userId);
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
            
        case 'friend_added':
            // Notificar a ambos usuarios que ahora son amigos
            await handleFriendAdded(userId, message);
            break;
    }
}

async function handlePrivateMessage(senderId, senderName, message) {
    const { to_user_id, message: messageText, timestamp } = message;
    
    try {
        // Guardar en PostgreSQL
        const result = await dbPool.query(
            'INSERT INTO chat_messages (sender_id, receiver_id, message) VALUES ($1, $2, $3) RETURNING id',
            [senderId, to_user_id, messageText]
        );
        
        const messageId = result.rows[0].id;
        
        // Crear notificación
        await dbPool.query(
            'INSERT INTO chat_notifications (user_id, type, from_user_id, message) VALUES ($1, $2, $3, $4)',
            [to_user_id, 'message', senderId, messageText.substring(0, 100)]
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
        // Crear notificación en PostgreSQL
        await dbPool.query(
            'INSERT INTO chat_notifications (user_id, type, from_user_id) VALUES ($1, $2, $3)',
            [to_user_id, 'friend_request', senderId]
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
        // Crear notificación si es aceptada
        if (status === 'accepted') {
            await dbPool.query(
                'INSERT INTO chat_notifications (user_id, type, from_user_id) VALUES ($1, $2, $3)',
                [from_user_id, 'friend_accepted', userId]
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

async function handleFriendAdded(userId, message) {
    const { friend_id, friend_username } = message;
    
    try {
        // Notificar a ambos usuarios que ahora son amigos
        const notifications = [];
        
        // Notificar al usuario que inició la solicitud
        if (onlineUsers.has(userId)) {
            const user = onlineUsers.get(userId);
            user.ws.send(JSON.stringify({
                type: 'friend_added',
                friend_id: friend_id,
                friend_username: friend_username,
                timestamp: Date.now()
            }));
        }
        
        // Notificar al amigo agregado
        if (onlineUsers.has(friend_id)) {
            const friend = onlineUsers.get(friend_id);
            friend.ws.send(JSON.stringify({
                type: 'friend_added',
                friend_id: userId,
                friend_username: username || 'Usuario',
                timestamp: Date.now()
            }));
        }
        
    } catch (error) {
        console.error('Error notificando nuevo amigo:', error);
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
        // Marcar mensaje como leído en PostgreSQL
        await dbPool.query(
            'UPDATE chat_messages SET is_read = TRUE WHERE id = $1 AND receiver_id = $2',
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

async function updateUserOnlineCache(userId, username) {
    try {
        // Usar UPSERT (INSERT ... ON CONFLICT ...)
        await dbPool.query(`
            INSERT INTO online_users_cache (user_id, username, socket_count, last_seen) 
            VALUES ($1, $2, 1, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id) 
            DO UPDATE SET 
                socket_count = online_users_cache.socket_count + 1,
                last_seen = CURRENT_TIMESTAMP,
                username = EXCLUDED.username
        `, [userId, username]);
    } catch (error) {
        console.error('Error actualizando cache de usuario:', error);
    }
}

async function removeUserFromCache(userId) {
    try {
        await dbPool.query(
            'DELETE FROM online_users_cache WHERE user_id = $1',
            [userId]
        );
    } catch (error) {
        console.error('Error removiendo usuario de cache:', error);
    }
}

async function sendPendingNotifications(userId, ws) {
    try {
        // Obtener notificaciones no leídas
        const result = await dbPool.query(
            `SELECT id, type, from_user_id, message, created_at 
             FROM chat_notifications 
             WHERE user_id = $1 AND is_read = FALSE 
             ORDER BY created_at DESC 
             LIMIT 10`,
            [userId]
        );
        
        // Enviar notificaciones
        result.rows.forEach(notif => {
            ws.send(JSON.stringify({
                type: notif.type,
                notification_id: notif.id,
                from_user_id: notif.from_user_id,
                message: notif.message,
                timestamp: new Date(notif.created_at).getTime()
            }));
        });
        
        // Marcar como leídas
        if (result.rows.length > 0) {
            await dbPool.query(
                'UPDATE chat_notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE',
                [userId]
            );
        }
        
    } catch (error) {
        console.error('Error enviando notificaciones pendientes:', error);
    }
}

// Inicializar base de datos
initDatabase();

server.listen(PORT, () => {
    console.log(`💬 Servidor de chat PostgreSQL iniciado en el puerto ${PORT}`);
    console.log(`🔗 URL del servidor: ws://localhost:${PORT}/chat-ws`);
    console.log(`🏥 Endpoint de salud: http://localhost:${PORT}/health`);
});

// Limpieza periódica de usuarios inactivos
setInterval(async () => {
    console.log(`👥 Usuarios en línea: ${onlineUsers.size}`);
    
    try {
        // Limpiar usuarios que no han estado activos en 10 minutos
        await dbPool.query(
            `DELETE FROM online_users_cache 
             WHERE last_seen < CURRENT_TIMESTAMP - INTERVAL '10 minutes'`
        );
    } catch (error) {
        console.error('Error limpiando cache:', error);
    }
}, 60000); // Cada minuto

// Manejo de cierre
process.on('SIGINT', async () => {
    console.log('\n👋 Apagando servidor de chat...');
    await dbPool.end();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n👋 Apagando servidor de chat...');
    await dbPool.end();
    process.exit(0);
});
