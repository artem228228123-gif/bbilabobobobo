/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/services/websocketService.js
 * Описание: WebSocket сервис для управления подключениями, комнатами, отправкой сообщений
 */

const jwt = require('jsonwebtoken');
const { get, set, del, sadd, srem, smembers } = require('../../config/redis');
const { config } = require('../../config/env');
const { User, Message, Chat } = require('../models');

// ============================================
// КОНСТАНТЫ
// ============================================

const CACHE_TTL = {
    userSocket: 86400,      // 24 часа
    room: 3600,             // 1 час
    typing: 10              // 10 секунд
};

// Хранилища в памяти (для быстрого доступа)
const activeUsers = new Map();        // userId -> socketId
const activeSockets = new Map();      // socketId -> userId
const userRooms = new Map();          // userId -> Set of roomIds
const roomUsers = new Map();          // roomId -> Set of userIds
const typingUsers = new Map();        // roomId -> Set of userIds

// ============================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================

function initWebSocketService(io) {
    // Middleware для аутентификации
    io.use(async (socket, next) => {
        const token = socket.handshake.auth.token;
        
        if (!token) {
            return next(new Error('Authentication required'));
        }
        
        try {
            const decoded = jwt.verify(token, config.jwt.secret);
            const user = await User.findById(decoded.id);
            
            if (!user || user.status !== 'active') {
                return next(new Error('User not found or inactive'));
            }
            
            socket.userId = decoded.id;
            socket.userName = user.name;
            socket.userAvatar = user.avatar;
            socket.userRole = user.role;
            next();
        } catch (error) {
            next(new Error('Invalid token'));
        }
    });
    
    io.on('connection', (socket) => {
        handleConnection(socket, io);
    });
    
    return io;
}

// ============================================
// ОБРАБОТКА ПОДКЛЮЧЕНИЯ
// ============================================

async function handleConnection(socket, io) {
    const userId = socket.userId;
    
    console.log(`🔌 [WebSocket] Пользователь ${userId} подключился, socketId: ${socket.id}`);
    
    // Сохраняем в память
    activeUsers.set(userId, socket.id);
    activeSockets.set(socket.id, userId);
    
    // Сохраняем в Redis для кластеризации
    await set(`socket:user:${userId}`, socket.id, CACHE_TTL.userSocket);
    await set(`socket:user:${userId}:info`, {
        socketId: socket.id,
        userId,
        name: socket.userName,
        connectedAt: new Date().toISOString()
    }, CACHE_TTL.userSocket);
    
    // Обновляем статус пользователя
    await updateUserStatus(userId, true);
    
    // Уведомляем всех о онлайн-статусе
    io.emit('user_status', {
        userId,
        status: 'online',
        lastSeen: new Date().toISOString()
    });
    
    // Обновляем last_seen
    await User.updateLastSeen(userId);
    
    // Отправляем количество непрочитанных уведомлений
    const unreadCount = await get(`notifications:unread:${userId}`) || 0;
    socket.emit('unread_count', { count: unreadCount });
    
    // Настраиваем обработчики событий
    setupEventHandlers(socket, io);
    
    // Обработка отключения
    socket.on('disconnect', () => handleDisconnect(socket, io));
}

// ============================================
// ОБРАБОТКА ОТКЛЮЧЕНИЯ
// ============================================

async function handleDisconnect(socket, io) {
    const userId = socket.userId;
    const socketId = socket.id;
    
    console.log(`🔌 [WebSocket] Пользователь ${userId} отключился, socketId: ${socketId}`);
    
    // Удаляем из памяти
    activeUsers.delete(userId);
    activeSockets.delete(socketId);
    
    // Удаляем из Redis
    await del(`socket:user:${userId}`);
    await del(`socket:user:${userId}:info`);
    
    // Удаляем из всех комнат
    const rooms = userRooms.get(userId) || new Set();
    for (const roomId of rooms) {
        const roomUsersSet = roomUsers.get(roomId);
        if (roomUsersSet) {
            roomUsersSet.delete(userId);
            if (roomUsersSet.size === 0) {
                roomUsers.delete(roomId);
            }
        }
        socket.leave(`room:${roomId}`);
    }
    userRooms.delete(userId);
    
    // Очищаем статус печатания
    for (const [roomId, typingSet] of typingUsers) {
        if (typingSet.has(userId)) {
            typingSet.delete(userId);
            io.to(`room:${roomId}`).emit('user_typing', {
                userId,
                isTyping: false
            });
        }
    }
    
    // Обновляем статус пользователя
    await updateUserStatus(userId, false);
    
    // Уведомляем всех о офлайн-статусе
    io.emit('user_status', {
        userId,
        status: 'offline',
        lastSeen: new Date().toISOString()
    });
}

// ============================================
// ОБРАБОТЧИКИ СОБЫТИЙ
// ============================================

function setupEventHandlers(socket, io) {
    const userId = socket.userId;
    
    // Присоединение к комнате (чату)
    socket.on('join_room', async (data) => {
        const { roomId } = data;
        
        if (!roomId) return;
        
        // Проверяем доступ к комнате
        const hasAccess = await checkRoomAccess(userId, roomId);
        if (!hasAccess) {
            socket.emit('error', { message: 'Access denied' });
            return;
        }
        
        socket.join(`room:${roomId}`);
        
        // Сохраняем в память
        if (!userRooms.has(userId)) {
            userRooms.set(userId, new Set());
        }
        userRooms.get(userId).add(roomId);
        
        if (!roomUsers.has(roomId)) {
            roomUsers.set(roomId, new Set());
        }
        roomUsers.get(roomId).add(userId);
        
        // Отправляем историю сообщений из кеша
        const cachedMessages = await get(`room:${roomId}:messages`);
        if (cachedMessages) {
            socket.emit('room_history', { roomId, messages: cachedMessages.slice(-50) });
        }
        
        console.log(`📢 [WebSocket] Пользователь ${userId} присоединился к комнате ${roomId}`);
        
        // Уведомляем других участников
        socket.to(`room:${roomId}`).emit('user_joined', {
            userId,
            userName: socket.userName,
            timestamp: new Date().toISOString()
        });
    });
    
    // Покидание комнаты
    socket.on('leave_room', (data) => {
        const { roomId } = data;
        
        socket.leave(`room:${roomId}`);
        
        // Удаляем из памяти
        const userRoomsSet = userRooms.get(userId);
        if (userRoomsSet) {
            userRoomsSet.delete(roomId);
        }
        
        const roomUsersSet = roomUsers.get(roomId);
        if (roomUsersSet) {
            roomUsersSet.delete(userId);
        }
        
        // Уведомляем других участников
        socket.to(`room:${roomId}`).emit('user_left', {
            userId,
            userName: socket.userName,
            timestamp: new Date().toISOString()
        });
        
        console.log(`👋 [WebSocket] Пользователь ${userId} покинул комнату ${roomId}`);
    });
    
    // Отправка сообщения
    socket.on('send_message', async (data) => {
        const { roomId, text, photo, replyToId } = data;
        
        try {
            // Сохраняем сообщение в БД
            const message = await Message.create(
                parseInt(roomId),
                userId,
                text || null,
                photo || null,
                replyToId || null
            );
            
            const enrichedMessage = {
                ...message,
                sender: {
                    id: userId,
                    name: socket.userName,
                    avatar: socket.userAvatar
                }
            };
            
            // Кешируем сообщение
            const cachedMessages = await get(`room:${roomId}:messages`) || [];
            cachedMessages.push(enrichedMessage);
            if (cachedMessages.length > 200) {
                cachedMessages.shift();
            }
            await set(`room:${roomId}:messages`, cachedMessages, 86400);
            
            // Отправляем всем в комнате
            io.to(`room:${roomId}`).emit('new_message', enrichedMessage);
            
            // Обновляем последнюю активность в чате
            await Chat.updateActivity(parseInt(roomId));
            
            // Обновляем счётчик непрочитанных для получателей
            await updateUnreadCounts(roomId, userId);
            
            console.log(`💬 [WebSocket] Сообщение в комнату ${roomId} от ${userId}`);
        } catch (error) {
            console.error('Ошибка отправки сообщения:', error);
            socket.emit('error', { message: 'Failed to send message' });
        }
    });
    
    // Редактирование сообщения
    socket.on('edit_message', async (data) => {
        const { roomId, messageId, newText } = data;
        
        try {
            const result = await Message.query(
                `UPDATE messages SET text = $1, is_edited = true, edited_at = NOW()
                 WHERE id = $2 AND sender_id = $3 RETURNING *`,
                [newText, messageId, userId]
            );
            
            if (result.rows.length > 0) {
                io.to(`room:${roomId}`).emit('message_edited', {
                    messageId,
                    newText,
                    editedAt: result.rows[0].edited_at
                });
            }
        } catch (error) {
            console.error('Ошибка редактирования сообщения:', error);
            socket.emit('error', { message: 'Failed to edit message' });
        }
    });
    
    // Удаление сообщения
    socket.on('delete_message', async (data) => {
        const { roomId, messageId } = data;
        
        try {
            const result = await Message.query(
                `DELETE FROM messages WHERE id = $1 AND sender_id = $2 RETURNING *`,
                [messageId, userId]
            );
            
            if (result.rows.length > 0) {
                io.to(`room:${roomId}`).emit('message_deleted', { messageId });
                
                // Удаляем из кеша
                const cachedMessages = await get(`room:${roomId}:messages`);
                if (cachedMessages) {
                    const filtered = cachedMessages.filter(m => m.id !== messageId);
                    await set(`room:${roomId}:messages`, filtered, 86400);
                }
            }
        } catch (error) {
            console.error('Ошибка удаления сообщения:', error);
            socket.emit('error', { message: 'Failed to delete message' });
        }
    });
    
    // Пользователь печатает
    socket.on('typing_start', (data) => {
        const { roomId } = data;
        
        if (!typingUsers.has(roomId)) {
            typingUsers.set(roomId, new Set());
        }
        
        const typingSet = typingUsers.get(roomId);
        if (!typingSet.has(userId)) {
            typingSet.add(userId);
            socket.to(`room:${roomId}`).emit('user_typing', {
                userId,
                userName: socket.userName,
                isTyping: true
            });
        }
        
        // Автоматически сбрасываем через 3 секунды
        setTimeout(() => {
            if (typingSet.has(userId)) {
                typingSet.delete(userId);
                socket.to(`room:${roomId}`).emit('user_typing', {
                    userId,
                    isTyping: false
                });
            }
        }, 3000);
    });
    
    // Пользователь перестал печатать
    socket.on('typing_stop', (data) => {
        const { roomId } = data;
        
        const typingSet = typingUsers.get(roomId);
        if (typingSet && typingSet.has(userId)) {
            typingSet.delete(userId);
            socket.to(`room:${roomId}`).emit('user_typing', {
                userId,
                isTyping: false
            });
        }
    });
    
    // Сообщения прочитаны
    socket.on('messages_read', async (data) => {
        const { roomId, messageIds } = data;
        
        try {
            await Message.markAsRead(parseInt(roomId), userId, messageIds);
            
            // Обновляем счётчики
            await resetUnreadCount(roomId, userId);
            
            io.to(`room:${roomId}`).emit('messages_read', {
                userId,
                messageIds
            });
        } catch (error) {
            console.error('Ошибка отметки прочтения:', error);
        }
    });
    
    // Запрос статуса пользователя
    socket.on('get_user_status', async (data) => {
        const { targetUserId } = data;
        
        const isOnline = activeUsers.has(targetUserId);
        let lastSeen = null;
        
        if (!isOnline) {
            const user = await User.findById(targetUserId);
            lastSeen = user?.last_seen;
        }
        
        socket.emit('user_status_response', {
            userId: targetUserId,
            status: isOnline ? 'online' : 'offline',
            lastSeen
        });
    });
    
    // Пинг (keep-alive)
    socket.on('ping', () => {
        socket.emit('pong');
    });
}

// ============================================
= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

async function checkRoomAccess(userId, roomId) {
    const result = await Chat.query(
        `SELECT id FROM chats WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2)`,
        [roomId, userId]
    );
    return result.rows.length > 0;
}

async function updateUnreadCounts(roomId, senderId) {
    const chat = await Chat.findById(roomId);
    if (!chat) return;
    
    const receiverId = chat.buyer_id === senderId ? chat.seller_id : chat.buyer_id;
    
    const key = `chat:unread:${receiverId}:${roomId}`;
    const current = await get(key) || 0;
    await set(key, parseInt(current) + 1, 86400);
    
    // Обновляем общее количество непрочитанных
    const totalKey = `chat:unread:total:${receiverId}`;
    const total = await get(totalKey) || 0;
    await set(totalKey, parseInt(total) + 1, 86400);
    
    // Отправляем уведомление получателю
    const receiverSocketId = activeUsers.get(receiverId);
    if (receiverSocketId) {
        global.io?.to(receiverSocketId).emit('unread_count_update', {
            count: parseInt(total) + 1
        });
    }
}

async function resetUnreadCount(roomId, userId) {
    const key = `chat:unread:${userId}:${roomId}`;
    const oldCount = await get(key) || 0;
    await del(key);
    
    const totalKey = `chat:unread:total:${userId}`;
    const total = await get(totalKey) || 0;
    await set(totalKey, Math.max(0, parseInt(total) - parseInt(oldCount)), 86400);
}

async function updateUserStatus(userId, isOnline) {
    await set(`user:status:${userId}`, {
        online: isOnline,
        lastSeen: new Date().toISOString()
    }, 300);
}

// ============================================
= ПУБЛИЧНЫЕ ФУНКЦИИ ДЛЯ ВНЕШНЕГО ИСПОЛЬЗОВАНИЯ
// ============================================

async function sendToUser(userId, event, data) {
    const socketId = activeUsers.get(userId) || await get(`socket:user:${userId}`);
    if (socketId && global.io) {
        global.io.to(socketId).emit(event, data);
        return true;
    }
    return false;
}

async function sendToRoom(roomId, event, data) {
    if (global.io) {
        global.io.to(`room:${roomId}`).emit(event, data);
        return true;
    }
    return false;
}

function isUserOnline(userId) {
    return activeUsers.has(userId);
}

function getOnlineUsers() {
    return Array.from(activeUsers.keys());
}

async function getOnlineCount() {
    return activeUsers.size;
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    initWebSocketService,
    sendToUser,
    sendToRoom,
    isUserOnline,
    getOnlineUsers,
    getOnlineCount,
    activeUsers,
    activeSockets
};