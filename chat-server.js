const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const { Pool } = require('pg');

// Configuración
const PORT = process.env.PORT || 10001;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? 
    process.env.ALLOWED_ORIGINS.split(',') : 
    ['https://gerges-online.xo.je', 'http://localhost:3000', 'http://localhost'];

// Conexión a PostgreSQL en Render
const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Almacenamiento en memoria
const onlineUsers = new Map(); // userId -> { ws, username, ... }

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
        res.end(JSON.stringify({ 
            status: 'ok', 
            online: onlineUsers.size,
            timestamp: new Date().toISOString(),
            database: 'postgresql'
        }));
        return;
    }
    
    // Nuevo endpoint para obtener amigos en línea
    if (req.url.startsWith('/friends/online/')) {
        const userId = req.url.split('/').pop();
        if (userId) {
            getOnlineFriendsFromDB(parseInt(userId)).then(friends => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true, 
                    online_friends: friends 
                }));
            }).catch(error => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: false, 
                    error: error.message 
                }));
            });
            return;
        }
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

// Función para obtener amigos de un usuario desde la base de datos
async function getFriendsFromDB(userId) {
    try {
        const result = await dbPool.query(`
            SELECT u.id, u.username, u.avatar_color,
                   CASE 
                        WHEN u.last_seen >= NOW() - INTERVAL '2 minutes' THEN true
                        ELSE false
                   END as is_online
            FROM (
                SELECT friend_id as id FROM friends WHERE user_id = $1 AND status = 'accepted'
                UNION
                SELECT user_id as id FROM friends WHERE friend_id = $1 AND status = 'accepted'
            ) f
            JOIN users u ON f.id = u.id
            ORDER BY u.username
        `, [userId]);
        
        return result.rows;
    } catch (error) {
        console.error('Error obteniendo amigos:', error.message);
        return [];
    }
}

// Función para obtener amigos en línea desde la base de datos
async function getOnlineFriendsFromDB(userId) {
    try {
        const result = await dbPool.query(`
            SELECT u.id, u.username, u.avatar_color
            FROM (
                SELECT friend_id as id FROM friends WHERE user_id = $1 AND status = 'accepted'
                UNION
                SELECT user_id as id FROM friends WHERE friend_id = $1 AND status = 'accepted'
            ) f
            JOIN users u ON f.id = u.id
            WHERE u.last_seen >= NOW() - INTERVAL '2 minutes'
            ORDER BY u.username
        `, [userId]);
        
        return result.rows;
    } catch (error) {
        console.error('Error obteniendo amigos en línea:', error.message);
        return [];
    }
}

// Función para verificar si dos usuarios son amigos
async function areFriends(userId1, userId2) {
    try {
        const result = await dbPool.query(`
            SELECT 1 FROM friends 
            WHERE (
                (user_id = $1 AND friend_id = $2) 
                OR (user_id = $2 AND friend_id = $1)
            ) AND status = 'accepted'
            LIMIT 1
        `, [userId1, userId2]);
        
        return result.rows.length > 0;
    } catch (error) {
        console.error('Error verificando amistad:', error.message);
        return false;
    }
}

// Función para actualizar estado de usuario en la base de datos
async function updateUserStatus(userId, isOnline) {
    try {
        if (isOnline) {
            await dbPool.query(
                'UPDATE users SET is_online = true, last_seen = NOW() WHERE id = $1',
                [userId]
            );
        } else {
            await dbPool.query(
                'UPDATE users SET is_online = false, last_seen = NOW() WHERE id = $1',
                [userId]
            );
        }
    } catch (error) {
        console.error('Error actualizando estado de usuario:', error.message);
    }
}

// Función para notificar a amigos específicos
async function notifySpecificFriends(userId, username, isOnline) {
    try {
        // Obtener amigos desde la base de datos
        const friends = await getFriendsFromDB(userId);
        
        // Preparar notificación
        const notification = {
            type: isOnline ? 'friend_online' : 'friend_offline',
            user_id: userId,
            username: username,
            timestamp: Date.now()
        };
        
        // Enviar notificación a amigos que estén conectados al WebSocket
        for (const friend of friends) {
            if (onlineUsers.has(friend.id)) {
                const friendWs = onlineUsers.get(friend.id).ws;
                if (friendWs.readyState === WebSocket.OPEN) {
                    friendWs.send(JSON.stringify(notification));
                    console.log(`📢 Notificación enviada a ${friend.username} (${friend.id}): ${username} está ${isOnline ? 'en línea' : 'desconectado'}`);
                }
            }
        }
    } catch (error) {
        console.error('Error notificando a amigos:', error.message);
    }
}

// Función para enviar lista de amigos en línea al usuario conectado
async function sendOnlineFriendsList(userId, ws) {
    try {
        const onlineFriends = await getOnlineFriendsFromDB(userId);
        
        // Enviar cada amigo en línea como notificación individual
        for (const friend of onlineFriends) {
            if (friend.id !== userId) { // No enviarse a sí mismo
                ws.send(JSON.stringify({
                    type: 'friend_online',
                    user_id: friend.id,
                    username: friend.username,
                    timestamp: Date.now()
                }));
            }
        }
        
        console.log(`📋 Enviada lista de ${onlineFriends.length} amigos en línea a usuario ${userId}`);
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
    
    // Registrar usuario
    onlineUsers.set(userId, { ws, username, userId, connectionType });
    
    // Actualizar estado en la base de datos
    await updateUserStatus(userId, true);
    
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
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.log(`📨 Mensaje de ${username} (${userId}):`, message.type);
            await handleMessage(userId, username, message, ws);
        } catch (error) {
            console.error('Error procesando mensaje:', error);
        }
    });
    
    ws.on('close', async () => {
        console.log(`👋 ${connectionType.toUpperCase()} - Usuario desconectado: ${username} (${userId})`);
        
        // Remover usuario
        onlineUsers.delete(userId);
        
        // Actualizar estado en la base de datos
        await updateUserStatus(userId, false);
        
        // Notificar a amigos específicos que está desconectado
        await notifySpecificFriends(userId, username, false);
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
            ws.send(JSON.stringify({ 
                type: 'pong',
                connection_type: message.connection_type || 'chat',
                timestamp: Date.now()
            }));
            break;
            
        case 'user_online':
            console.log(`👤 Usuario ${username} (${userId}) notifica que está en línea`);
            await updateUserStatus(userId, true);
            await notifySpecificFriends(userId, username, true);
            break;
            
        case 'user_left':
            console.log(`👤 Usuario ${username} (${userId}) notifica que se desconectó`);
            await updateUserStatus(userId, false);
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
        // Verificar si son amigos
        const areTheyFriends = await areFriends(senderId, to_user_id);
        
        if (!areTheyFriends) {
            console.log(`❌ ${senderId} y ${to_user_id} no son amigos. Mensaje rechazado.`);
            
            // Notificar al remitente
            if (onlineUsers.has(senderId)) {
                const sender = onlineUsers.get(senderId);
                sender.ws.send(JSON.stringify({
                    type: 'error',
                    message: 'No puedes enviar mensajes a este usuario porque no son amigos',
                    timestamp: Date.now()
                }));
            }
            return;
        }
        
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
        // Verificar si ya son amigos
        const alreadyFriends = await areFriends(senderId, to_user_id);
        
        if (alreadyFriends) {
            console.log(`❌ ${senderId} y ${to_user_id} ya son amigos. Solicitud rechazada.`);
            return;
        }
        
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
                onlineUsers.get(to_user_id).ws.send(JSON.stringify({
                    ...friendNotification,
                    friend_id: to_user_id
                }));
            }
            
            // Notificar a ambos que están en línea (si es que están conectados)
            if (onlineUsers.has(userId) && onlineUsers.has(to_user_id)) {
                // Notificar al usuario 1 que el usuario 2 está en línea
                onlineUsers.get(userId).ws.send(JSON.stringify({
                    type: 'friend_online',
                    user_id: to_user_id,
                    username: username,
                    timestamp: Date.now()
                }));
                
                // Notificar al usuario 2 que el usuario 1 está en línea
                // Necesitamos obtener el nombre del usuario 2
                const user2 = await dbPool.query(
                    'SELECT username FROM users WHERE id = $1',
                    [to_user_id]
                );
                
                if (user2.rows.length > 0) {
                    onlineUsers.get(to_user_id).ws.send(JSON.stringify({
                        type: 'friend_online',
                        user_id: userId,
                        username: user2.rows[0].username,
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
        
        // Asegurarse de que la tabla users tenga las columnas necesarias
        await dbPool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name = 'users' AND column_name = 'is_online') THEN
                    ALTER TABLE users ADD COLUMN is_online BOOLEAN DEFAULT FALSE;
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name = 'users' AND column_name = 'last_seen') THEN
                    ALTER TABLE users ADD COLUMN last_seen TIMESTAMP DEFAULT NOW();
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name = 'users' AND column_name = 'avatar_color') THEN
                    ALTER TABLE users ADD COLUMN avatar_color VARCHAR(7) DEFAULT '#FF3333';
                END IF;
            END $$;
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

// Limpieza periódica (cada 5 minutos)
setInterval(() => {
    console.log(`👥 Usuarios en línea: ${onlineUsers.size}`);
    
    // Limpiar usuarios inactivos en la base de datos (más de 5 minutos)
    dbPool.query(
        "UPDATE users SET is_online = false WHERE last_seen < NOW() - INTERVAL '5 minutes' AND is_online = true"
    ).catch(err => console.error('Error limpiando usuarios inactivos:', err.message));
}, 300000);

// Manejo de cierre
process.on('SIGINT', async () => {
    console.log('\n👋 Apagando servidor de chat...');
    
    // Marcar a todos los usuarios como desconectados
    await dbPool.query("UPDATE users SET is_online = false WHERE is_online = true");
    
    await dbPool.end();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n👋 Apagando servidor de chat...');
    
    // Marcar a todos los usuarios como desconectados
    await dbPool.query("UPDATE users SET is_online = false WHERE is_online = true");
    
    await dbPool.end();
    process.exit(0);
});
