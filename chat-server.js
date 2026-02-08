const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const { Pool } = require('pg');

// Configuración
const PORT = process.env.PORT || 10001;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? 
    process.env.ALLOWED_ORIGINS.split(',') : 
    ['https://gerges-online.xo.je', 'http://localhost:3000', 'http://localhost'];

// Conexión a PostgreSQL en Render (SOLO para mensajes y notificaciones)
const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Almacenamiento en memoria para usuarios en línea
const onlineUsers = new Map(); // userId -> { ws, username, connectionType, timestamp }

const server = http.createServer((req, res) => {
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
        
        // Obtener usuarios activos (últimos 5 minutos)
        const now = Date.now();
        const activeUsers = Array.from(onlineUsers.entries())
            .filter(([_, user]) => (now - user.timestamp) < 300000) // 5 minutos
            .map(([id, user]) => ({ id, username: user.username }));
        
        res.end(JSON.stringify({ 
            status: 'ok', 
            online: activeUsers.length,
            active_users: activeUsers,
            timestamp: new Date().toISOString(),
            database: 'postgresql'
        }));
        return;
    }
    
    // Endpoint para verificar si un usuario está en línea
    if (req.url.startsWith('/check-online/')) {
        const userId = req.url.split('/').pop();
        const isOnline = onlineUsers.has(parseInt(userId));
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            success: true, 
            user_id: parseInt(userId),
            is_online: isOnline,
            timestamp: Date.now()
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
        
        if (!ALLOWED_ORIGINS.includes(origin)) {
            console.log(`❌ Origen no permitido: ${origin}`);
            callback(false, 403, 'Origen no permitido');
            return;
        }
        
        if (!userId || isNaN(userId)) {
            console.log(`❌ ID de usuario inválido: ${parsedUrl.query.user}`);
            callback(false, 400, 'ID de usuario requerido');
            return;
        }
        
        callback(true);
    }
});

// Función para obtener amigos de un usuario (solo IDs, no consulta la tabla users)
async function getFriendIds(userId) {
    try {
        // Esta consulta asume que tienes una tabla 'friends' en tu base de datos de chat
        // Si no la tienes, la crearemos en initDatabase()
        const result = await dbPool.query(`
            SELECT 
                CASE 
                    WHEN user_id = $1 THEN friend_id
                    ELSE user_id
                END as friend_id
            FROM friends 
            WHERE (user_id = $1 OR friend_id = $1) 
            AND status = 'accepted'
        `, [userId]);
        
        return result.rows.map(row => row.friend_id);
    } catch (error) {
        console.error('Error obteniendo IDs de amigos:', error.message);
        // Si falla, devolver array vacío
        return [];
    }
}

// Función para notificar a amigos específicos
async function notifySpecificFriends(userId, username, isOnline) {
    try {
        // Obtener IDs de amigos
        const friendIds = await getFriendIds(userId);
        
        if (friendIds.length === 0) {
            console.log(`📢 Usuario ${username} (${userId}) no tiene amigos registrados`);
            return;
        }
        
        // Preparar notificación
        const notification = {
            type: isOnline ? 'friend_online' : 'friend_offline',
            user_id: userId,
            username: username,
            timestamp: Date.now()
        };
        
        let notifiedCount = 0;
        
        // Enviar notificación a amigos que estén conectados al WebSocket
        for (const friendId of friendIds) {
            if (onlineUsers.has(friendId)) {
                const friend = onlineUsers.get(friendId);
                if (friend.ws.readyState === WebSocket.OPEN) {
                    friend.ws.send(JSON.stringify(notification));
                    notifiedCount++;
                }
            }
        }
        
        console.log(`📢 Notificaciones enviadas: ${notifiedCount}/${friendIds.length} amigos de ${username} (${userId})`);
        
    } catch (error) {
        console.error('Error notificando a amigos:', error.message);
    }
}

// Función para enviar lista de amigos en línea al usuario conectado
async function sendOnlineFriendsList(userId, ws) {
    try {
        // Obtener IDs de amigos
        const friendIds = await getFriendIds(userId);
        
        if (friendIds.length === 0) {
            console.log(`📋 Usuario ${userId} no tiene amigos, no se envía lista`);
            return;
        }
        
        let sentCount = 0;
        
        // Enviar cada amigo en línea como notificación individual
        for (const friendId of friendIds) {
            if (onlineUsers.has(friendId)) {
                const friend = onlineUsers.get(friendId);
                ws.send(JSON.stringify({
                    type: 'friend_online',
                    user_id: friendId,
                    username: friend.username,
                    timestamp: Date.now()
                }));
                sentCount++;
            }
        }
        
        console.log(`📋 Enviada lista de ${sentCount}/${friendIds.length} amigos en línea a usuario ${userId}`);
        
    } catch (error) {
        console.error('Error enviando lista de amigos en línea:', error.message);
    }
}

wss.on('connection', async (ws, req) => {
    const query = url.parse(req.url, true).query;
    const userId = parseInt(query.user);
    const username = decodeURIComponent(query.username || 'Usuario');
    const connectionType = query.connection_type || 'chat';
    
    if (!userId) {
        ws.close(1008, 'ID de usuario requerido');
        return;
    }
    
    console.log(`🔌 ${connectionType.toUpperCase()} - Usuario conectado: ${username} (${userId})`);
    
    // Registrar usuario en memoria
    onlineUsers.set(userId, { 
        ws, 
        username, 
        userId, 
        connectionType,
        timestamp: Date.now() // Para tracking de actividad
    });
    
    // Enviar confirmación
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Conectado al servidor de chat',
        user: { id: userId, username: username },
        connection_type: connectionType,
        timestamp: Date.now()
    }));
    
    // Notificar a amigos específicos que está en línea
    await notifySpecificFriends(userId, username, true);
    
    // Si es conexión de chat (no global), enviar lista de amigos en línea
    if (connectionType === 'chat') {
        await sendOnlineFriendsList(userId, ws);
    }
    
    // Heartbeat para mantener la conexión activa
    const heartbeatInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
            
            // Actualizar timestamp de actividad
            if (onlineUsers.has(userId)) {
                const user = onlineUsers.get(userId);
                user.timestamp = Date.now();
            }
        }
    }, 30000); // Cada 30 segundos
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.log(`📨 Mensaje de ${username} (${userId}):`, message.type);
            await handleMessage(userId, username, message, ws);
            
            // Actualizar timestamp de actividad cuando envía mensajes
            if (onlineUsers.has(userId)) {
                const user = onlineUsers.get(userId);
                user.timestamp = Date.now();
            }
        } catch (error) {
            console.error('Error procesando mensaje:', error);
        }
    });
    
    ws.on('close', async () => {
        console.log(`👋 ${connectionType.toUpperCase()} - Usuario desconectado: ${username} (${userId})`);
        
        // Limpiar intervalo de heartbeat
        clearInterval(heartbeatInterval);
        
        // Remover usuario de memoria
        onlineUsers.delete(userId);
        
        // Notificar a amigos específicos que está desconectado
        await notifySpecificFriends(userId, username, false);
    });
    
    ws.on('error', (error) => {
        console.error(`Error en WebSocket de ${username}:`, error);
        clearInterval(heartbeatInterval);
    });
    
    // Manejar ping/pong para mantener conexión
    ws.on('pong', () => {
        if (onlineUsers.has(userId)) {
            const user = onlineUsers.get(userId);
            user.timestamp = Date.now();
        }
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
            ws.send(JSON.stringify({ 
                type: 'pong',
                connection_type: message.connection_type || 'chat',
                timestamp: Date.now()
            }));
            break;
            
        case 'user_online':
            console.log(`👤 Usuario ${username} (${userId}) notifica que está en línea`);
            await notifySpecificFriends(userId, username, true);
            break;
            
        case 'user_left':
            console.log(`👤 Usuario ${username} (${userId}) notifica que se desconectó`);
            await notifySpecificFriends(userId, username, false);
            break;
            
        default:
            console.log(`⚠️ Tipo de mensaje no manejado: ${message.type}`);
    }
}

async function handlePrivateMessage(senderId, senderName, message) {
    const { to_user_id, message: messageText, timestamp } = message;
    
    console.log(`💬 Mensaje privado de ${senderId} a ${to_user_id}: ${messageText.substring(0, 50)}...`);
    
    try {
        // Guardar en PostgreSQL
        const result = await dbPool.query(
            'INSERT INTO chat_messages (sender_id, receiver_id, message) VALUES ($1, $2, $3) RETURNING id, created_at',
            [senderId, to_user_id, messageText]
        );
        
        const messageId = result.rows[0].id;
        const createdAt = result.rows[0].created_at;
        
        // Crear notificación
        await dbPool.query(
            'INSERT INTO chat_notifications (user_id, type, from_user_id, message) VALUES ($1, $2, $3, $4)',
            [to_user_id, 'message', senderId, messageText.substring(0, 100)]
        );
        
        // ENVIAR AL RECEPTOR SI ESTÁ EN LÍNEA
        if (onlineUsers.has(to_user_id)) {
            const receiver = onlineUsers.get(to_user_id);
            console.log(`📤 Enviando mensaje ${messageId} a usuario ${to_user_id} (está en línea)`);
            
            receiver.ws.send(JSON.stringify({
                type: 'private_message',
                from_user_id: senderId,
                from_username: senderName,
                to_user_id: to_user_id,
                message: messageText,
                message_id: messageId,
                timestamp: timestamp || Date.now(),
                created_at: createdAt
            }));
        } else {
            console.log(`📭 Usuario ${to_user_id} no está en línea. Mensaje guardado.`);
        }
        
        // Enviar confirmación al remitente
        if (onlineUsers.has(senderId)) {
            const sender = onlineUsers.get(senderId);
            sender.ws.send(JSON.stringify({
                type: 'message_sent',
                message_id: messageId,
                to_user_id: to_user_id,
                timestamp: timestamp || Date.now(),
                created_at: createdAt
            }));
        }
        
    } catch (error) {
        console.error('❌ Error guardando mensaje:', error.message);
        
        // Notificar al remitente sobre el error
        if (onlineUsers.has(senderId)) {
            const sender = onlineUsers.get(senderId);
            sender.ws.send(JSON.stringify({
                type: 'error',
                message: 'Error al enviar el mensaje',
                timestamp: Date.now()
            }));
        }
    }
}

async function handleFriendRequest(senderId, senderName, message) {
    const { to_user_id } = message;
    
    try {
        // Verificar si ya son amigos (opcional, puede omitirse si no hay tabla friends)
        
        // Crear notificación
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
        
        console.log(`✅ Solicitud de amistad enviada de ${senderId} a ${to_user_id}`);
        
    } catch (error) {
        console.error('Error enviando solicitud de amistad:', error.message);
    }
}

async function handleFriendRequestResponse(userId, username, message) {
    const { to_user_id, status } = message;
    
    try {
        // Crear notificación si es aceptada
        if (status === 'accepted') {
            await dbPool.query(
                'INSERT INTO chat_notifications (user_id, type, from_user_id) VALUES ($1, $2, $3)',
                [to_user_id, 'friend_accepted', userId]
            );
            
            // Notificar a ambos usuarios que ahora son amigos
            const friendNotification = {
                type: 'friend_added',
                friend_id: userId,
                friend_username: username,
                timestamp: Date.now()
            };
            
            // Notificar al usuario que aceptó
            if (onlineUsers.has(userId)) {
                onlineUsers.get(userId).ws.send(JSON.stringify(friendNotification));
            }
            
            // Notificar al otro usuario
            if (onlineUsers.has(to_user_id)) {
                // Obtener username del usuario que aceptó
                const user2 = onlineUsers.get(to_user_id) || { username: 'Usuario' };
                onlineUsers.get(to_user_id).ws.send(JSON.stringify({
                    ...friendNotification,
                    friend_id: to_user_id
                }));
                
                // Notificar estado en línea mutuo
                if (onlineUsers.has(userId)) {
                    // Notificar al usuario 2 que el usuario 1 está en línea
                    onlineUsers.get(to_user_id).ws.send(JSON.stringify({
                        type: 'friend_online',
                        user_id: userId,
                        username: username,
                        timestamp: Date.now()
                    }));
                    
                    // Notificar al usuario 1 que el usuario 2 está en línea
                    onlineUsers.get(userId).ws.send(JSON.stringify({
                        type: 'friend_online',
                        user_id: to_user_id,
                        username: user2.username,
                        timestamp: Date.now()
                    }));
                }
            }
        }
        
    } catch (error) {
        console.error('Error procesando respuesta de solicitud:', error.message);
    }
}

async function handleTypingNotification(userId, username, message) {
    const { to_user_id, is_typing } = message;
    
    console.log(`✍️ ${username} ${is_typing ? 'está escribiendo' : 'dejó de escribir'} a ${to_user_id}`);
    
    // Enviar notificación al receptor si está en línea
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
        console.error('Error actualizando estado de lectura:', error.message);
    }
}

// Inicializar base de datos
async function initDatabase() {
    try {
        console.log('🔄 Inicializando base de datos PostgreSQL...');
        
        // Tabla de mensajes
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS chat_messages (
                id SERIAL PRIMARY KEY,
                sender_id INTEGER NOT NULL,
                receiver_id INTEGER NOT NULL,
                message TEXT NOT NULL,
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        // Tabla de amigos (opcional, solo si la vas a usar)
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS friends (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                friend_id INTEGER NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, friend_id)
            );
        `);
        
        console.log('✅ Base de datos inicializada correctamente');
        return true;
    } catch (error) {
        console.error('❌ Error inicializando base de datos:', error.message);
        return false;
    }
}

// Inicializar base de datos al arrancar
async function startServer() {
    await initDatabase();
    
    server.listen(PORT, () => {
        console.log(`💬 Servidor de chat PostgreSQL en puerto ${PORT}`);
        console.log(`🔗 WebSocket: wss://localhost:${PORT}/chat-ws`);
        console.log(`🏥 Health check: http://localhost:${PORT}/health`);
        console.log(`👥 Usuarios permitidos: ${ALLOWED_ORIGINS.join(', ')}`);
    });
}

// Iniciar servidor
startServer().catch(error => {
    console.error('❌ Error fatal iniciando servidor:', error);
    process.exit(1);
});

// Limpieza periódica (cada 5 minutos) - limpiar solo usuarios inactivos en memoria
setInterval(() => {
    console.log(`👥 Usuarios en línea: ${onlineUsers.size}`);
    
    // Limpiar usuarios inactivos (más de 10 minutos sin actividad)
    const now = Date.now();
    let cleanedCount = 0;
    
    onlineUsers.forEach((user, userId) => {
        if ((now - user.timestamp) > 600000) { // 10 minutos
            console.log(`🧹 Limpiando usuario inactivo: ${user.username} (${userId})`);
            onlineUsers.delete(userId);
            
            // Notificar amigos que se desconectó
            notifySpecificFriends(userId, user.username, false).catch(() => {});
            cleanedCount++;
        }
    });
    
    if (cleanedCount > 0) {
        console.log(`🧹 Se limpiaron ${cleanedCount} usuarios inactivos`);
    }
}, 300000); // Cada 5 minutos

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
