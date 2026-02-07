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
const onlineUsers = new Map();
const userSockets = new Map();

// Crear tablas al iniciar
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
        
        // Tabla de usuarios online (opcional, podemos usar solo memoria)
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS online_users_cache (
                user_id INTEGER PRIMARY KEY,
                username VARCHAR(100),
                socket_count INTEGER DEFAULT 1,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        console.log('✅ Base de datos inicializada correctamente');
        return true;
    } catch (error) {
        console.error('❌ Error inicializando base de datos:', error.message);
        return false;
    }
}

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
    
    if (req.url === '/init-db') {
        initDatabase().then(result => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: result }));
        });
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
    
    if (!userSockets.has(userId)) {
        userSockets.set(userId, new Set());
    }
    userSockets.get(userId).add(ws);
    
    // Actualizar cache en PostgreSQL (opcional)
    try {
        await dbPool.query(`
            INSERT INTO online_users_cache (user_id, username) 
            VALUES ($1, $2) 
            ON CONFLICT (user_id) 
            DO UPDATE SET 
                socket_count = online_users_cache.socket_count + 1,
                last_seen = CURRENT_TIMESTAMP
        `, [userId, username]);
    } catch (error) {
        console.error('Error actualizando cache:', error.message);
    }
    
    // Enviar confirmación
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Conectado al servidor de chat',
        user: { id: userId, username: username },
        timestamp: Date.now()
    }));
    
    // Enviar notificaciones pendientes
    try {
        const result = await dbPool.query(
            `SELECT * FROM chat_notifications 
             WHERE user_id = $1 AND is_read = FALSE 
             ORDER BY created_at DESC 
             LIMIT 10`,
            [userId]
        );
        
        result.rows.forEach(notification => {
            ws.send(JSON.stringify({
                type: notification.type,
                notification_id: notification.id,
                from_user_id: notification.from_user_id,
                message: notification.message,
                timestamp: new Date(notification.created_at).getTime()
            }));
        });
        
        // Marcar como leídas
        if (result.rows.length > 0) {
            await dbPool.query(
                'UPDATE chat_notifications SET is_read = TRUE WHERE user_id = $1',
                [userId]
            );
        }
    } catch (error) {
        console.error('Error enviando notificaciones:', error.message);
    }
    
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
        
        if (userSockets.has(userId)) {
            userSockets.get(userId).delete(ws);
            
            if (userSockets.get(userId).size === 0) {
                userSockets.delete(userId);
                onlineUsers.delete(userId);
                
                // Remover de cache en PostgreSQL
                try {
                    await dbPool.query(
                        'DELETE FROM online_users_cache WHERE user_id = $1',
                        [userId]
                    );
                } catch (error) {
                    console.error('Error removiendo de cache:', error.message);
                }
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
            
        default:
            console.log(`Tipo de mensaje no manejado: ${message.type}`);
    }
}

async function handlePrivateMessage(senderId, senderName, message) {
    const { to_user_id, message: messageText } = message;
    
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
                timestamp: Date.now()
            }));
        }
        
    } catch (error) {
        console.error('Error guardando mensaje:', error.message);
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

// Inicializar base de datos al arrancar
async function startServer() {
    const dbInitialized = await initDatabase();
    
    if (!dbInitialized) {
        console.warn('⚠️  Base de datos no inicializada, pero el servidor continuará');
    }
    
    server.listen(PORT, () => {
        console.log(`💬 Servidor de chat PostgreSQL en puerto ${PORT}`);
        console.log(`🔗 WebSocket: ws://localhost:${PORT}/chat-ws`);
        console.log(`🏥 Health check: http://localhost:${PORT}/health`);
        console.log(`🗄️  Init DB: http://localhost:${PORT}/init-db`);
        console.log(`👥 Usuarios permitidos: ${ALLOWED_ORIGINS.join(', ')}`);
    });
}

// Iniciar servidor
startServer().catch(error => {
    console.error('❌ Error fatal iniciando servidor:', error);
    process.exit(1);
});

// Limpieza periódica (cada 5 minutos)
setInterval(async () => {
    console.log(`👥 Usuarios en línea: ${onlineUsers.size}`);
    
    try {
        // Limpiar usuarios que no han estado activos en 15 minutos
        await dbPool.query(
            `DELETE FROM online_users_cache 
             WHERE last_seen < CURRENT_TIMESTAMP - INTERVAL '15 minutes'`
        );
    } catch (error) {
        // Si la tabla no existe, solo ignorar el error
        if (error.code !== '42P01') { // 42P01 = tabla no existe
            console.error('Error limpiando cache:', error.message);
        }
    }
}, 300000); // 5 minutos

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
