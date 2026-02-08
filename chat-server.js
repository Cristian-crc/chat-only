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
    
    // Enviar confirmación
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Conectado al servidor de chat',
        user: { id: userId, username: username },
        timestamp: Date.now()
    }));
    
    // Notificar a amigos que están en línea
    notifyFriendsOnline(userId, username);
    
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
        console.log(`👋 Usuario desconectado: ${username} (${userId})`);
        
        // Remover usuario
        onlineUsers.delete(userId);
        
        // Notificar a amigos que está desconectado
        notifyFriendsOffline(userId);
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
            
        case 'user_online':
            console.log(`👤 Usuario ${username} (${userId}) notifica que está en línea`);
            notifyFriendsOnline(userId, username);
            break;
            
        case 'user_left':
            console.log(`👤 Usuario ${username} (${userId}) notifica que se desconectó`);
            notifyFriendsOffline(userId);
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
            'INSERT INTO chat_messages (sender_id, receiver_id, message) VALUES ($1, $2, $3) RETURNING id',
            [senderId, to_user_id, messageText]
        );
        
        const messageId = result.rows[0].id;
        
        // Crear notificación
        await dbPool.query(
            'INSERT INTO chat_notifications (user_id, type, from_user_id, message) VALUES ($1, $2, $3, $4)',
            [to_user_id, 'message', senderId, messageText.substring(0, 100)]
        );
        
        // ENVIAR AL RECEPTOR SI ESTÁ EN LÍNEA - CORREGIDO
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
                timestamp: timestamp || Date.now()
            }));
        } else {
            console.log(`📭 Usuario ${to_user_id} no está en línea. Mensaje guardado.`);
        }
        
        // TAMBIÉN ENVIAR CONFIRMACIÓN AL REMITENTE (OPCIONAL)
        if (onlineUsers.has(senderId)) {
            const sender = onlineUsers.get(senderId);
            sender.ws.send(JSON.stringify({
                type: 'message_sent',
                message_id: messageId,
                to_user_id: to_user_id,
                timestamp: timestamp || Date.now()
            }));
        }
        
    } catch (error) {
        console.error('❌ Error guardando mensaje:', error.message);
    }
}

async function handleFriendRequest(senderId, senderName, message) {
    const { to_user_id } = message;
    
    try {
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

function notifyFriendsOnline(userId, username) {
    console.log(`📢 Notificando amigos de ${username} (${userId}) que está en línea`);
    
    // En una implementación real, aquí buscarías en la base de datos los amigos
    // Por simplicidad, notificamos a todos los usuarios en línea excepto al mismo
    onlineUsers.forEach((user, id) => {
        if (id !== userId && user.ws.readyState === WebSocket.OPEN) {
            user.ws.send(JSON.stringify({
                type: 'friend_online',
                user_id: userId,
                username: username,
                timestamp: Date.now()
            }));
        }
    });
}

function notifyFriendsOffline(userId) {
    console.log(`📢 Notificando amigos de usuario ${userId} que se desconectó`);
    
    onlineUsers.forEach((user, id) => {
        if (id !== userId && user.ws.readyState === WebSocket.OPEN) {
            user.ws.send(JSON.stringify({
                type: 'friend_offline',
                user_id: userId,
                timestamp: Date.now()
            }));
        }
    });
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
}, 300000);

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
