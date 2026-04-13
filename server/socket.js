/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/socket.js
 * Описание: WebSocket сервер для чатов, уведомлений в реальном времени, онлайн-статусов
 */

const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const { config } = require('../config/env');
const { get, set, del, sadd, srem, smembers, sismember } = require('../config/redis');
const { User, Message, Chat, Blacklist } = require('../models');

// ============================================
// ХРАНИЛИЩА
// ============================================

// Активные подключения: userId -> socketId
const activeUsers = new Map();
// Активные комнаты: chatId -> Set of socketIds
const activeRooms = new Map();
// Таймеры печатания: chatId -> timeout
const typingTimeouts = new Map();

// ============================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================

function initSocket(server) {
    const io = socketIO(server, {
        cors: {
            origin: config.app.clientUrl,
            credentials: true,
            methods: ['GET', 'POST']
        },
        pingTimeout: 60000,
        pingInterval: 25000,
        transports: ['websocket', 'polling']
    });

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

    // Обработка подключений
    io.on('connection', (socket) => {
        console.log(`🔌 [SOCKET] Пользователь ${socket.userId} подключился, socketId: ${socket.id}`);
        
        // Регистрируем пользователя
        handleUserConnect(socket, io);
        
        // Присоединение к чату
        socket.on('join_chat', (data) => handleJoinChat(socket, io, data));
        
        // Покинуть чат
        socket.on('leave_chat', (data) => handleLeaveChat(socket, data));
        
        // Отправка сообщения
        socket.on('send_message', (data) => handleSendMessage(socket, io, data));
        
        // Редактирование сообщения
        socket.on('edit_message', (data) => handleEditMessage(socket, io, data));
        
        // Удаление сообщения
        socket.on('delete_message', (data) => handleDeleteMessage(socket, io, data));
        
        // Пользователь печатает
        socket.on('typing_start', (data) => handleTypingStart(socket, io, data));
        
        // Пользователь перестал печатать
        socket.on('typing_stop', (data) => handleTypingStop(socket, io, data));
        
        // Сообщения прочитаны
        socket.on('messages_read', (data) => handleMessagesRead(socket, io, data));
        
        // Запрос онлайн-статуса
        socket.on('get_user_status', (data) => handleGetUserStatus(socket, data));
        
        // Отключение
        socket.on('disconnect', () => handleUserDisconnect(socket, io));
    });
    
    return io;
}

// ============================================
// ОБРАБОТЧИКИ СОБЫТИЙ
// ============================================

// Подключение пользователя
async function handleUserConnect(socket, io) {
    // Сохраняем в память
    activeUsers.set(socket.userId, socket.id);
    
    // Сохраняем в Redis для кластеризации
    await set(`user:socket:${socket.userId}`, socket.id, 86400);
    
    // Добавляем в глобальную комнату онлайн-пользователей
    await socket.join('online_users');
    
    // Уведомляем всех о новом онлайн-статусе
    io.emit('user_status', {
        userId: socket.userId,
        status: 'online',
        lastSeen: new Date().toISOString()
    });
    
    // Обновляем last_seen в БД
    await User.updateLastSeen(socket.userId);
    
    // Получаем непрочитанные уведомления
    const unreadCount = await get(`notifications:unread:${socket.userId}`);
    socket.emit('unread_count', { count: parseInt(unreadCount) || 0 });
}

// Отключение пользователя
async function handleUserDisconnect(socket, io) {
    console.log(`🔌 [SOCKET] Пользователь ${socket.userId} отключился`);
    
    // Удаляем из памяти
    activeUsers.delete(socket.userId);
    
    // Удаляем из Redis
    await del(`user:socket:${socket.userId}`);
    
    // Покидаем все комнаты
    const rooms = Array.from(socket.rooms);
    for (const room of rooms) {
        if (room.startsWith('chat_')) {
            const chatId = room.replace('chat_', '');
            const roomSockets = activeRooms.get(chatId);
            if (roomSockets) {
                roomSockets.delete(socket.id);
                if (roomSockets.size === 0) {
                    activeRooms.delete(chatId);
                }
            }
        }
    }
    
    // Уведомляем всех о офлайн-статусе
    io.emit('user_status', {
        userId: socket.userId,
        status: 'offline',
        lastSeen: new Date().toISOString()
    });
}

// Присоединение к чату
async function handleJoinChat(socket, io, { chatId }) {
    try {
        // Проверяем, имеет ли пользователь доступ к чату
        const chat = await Chat.findById(chatId);
        if (!chat || (chat.buyer_id !== socket.userId && chat.seller_id !== socket.userId)) {
            socket.emit('error', { message: 'Доступ запрещён' });
            return;
        }
        
        // Присоединяемся к комнате
        socket.join(`chat_${chatId}`);
        
        // Сохраняем в активные комнаты
        if (!activeRooms.has(chatId)) {
            activeRooms.set(chatId, new Set());
        }
        activeRooms.get(chatId).add(socket.id);
        
        // Получаем последние 50 сообщений из кеша
        const cachedMessages = await get(`chat:${chatId}:messages`);
        if (cachedMessages) {
            socket.emit('chat_history', { messages: cachedMessages.slice(-50) });
        }
        
        console.log(`📢 [SOCKET] Пользователь ${socket.userId} присоединился к чату ${chatId}`);
        
        // Уведомляем собеседника
        const otherUserId = chat.buyer_id === socket.userId ? chat.seller_id : chat.buyer_id;
        const otherSocketId = activeUsers.get(otherUserId);
        if (otherSocketId) {
            io.to(otherSocketId).emit('user_joined_chat', {
                chatId,
                userId: socket.userId,
                userName: socket.userName
            });
        }
        
        // Отмечаем сообщения как прочитанные
        await Message.markAsRead(chatId, socket.userId);
        await del(`chat:${chatId}:unread:${socket.userId}`);
        
    } catch (error) {
        console.error('Ошибка присоединения к чату:', error);
        socket.emit('error', { message: 'Ошибка подключения к чату' });
    }
}

// Покинуть чат
async function handleLeaveChat(socket, { chatId }) {
    socket.leave(`chat_${chatId}`);
    
    const roomSockets = activeRooms.get(chatId);
    if (roomSockets) {
        roomSockets.delete(socket.id);
        if (roomSockets.size === 0) {
            activeRooms.delete(chatId);
        }
    }
    
    console.log(`👋 [SOCKET] Пользователь ${socket.userId} покинул чат ${chatId}`);
}

// Отправка сообщения
async function handleSendMessage(socket, io, { chatId, text, photo, replyToId }) {
    try {
        // Проверяем доступ к чату
        const chat = await Chat.findById(chatId);
        if (!chat || (chat.buyer_id !== socket.userId && chat.seller_id !== socket.userId)) {
            socket.emit('error', { message: 'Доступ запрещён' });
            return;
        }
        
        // Проверяем чёрный список
        const otherUserId = chat.buyer_id === socket.userId ? chat.seller_id : chat.buyer_id;
        const isBlocked = await Blacklist.isBlocked(otherUserId, socket.userId);
        if (isBlocked) {
            socket.emit('error', { message: 'Вы заблокированы этим пользователем' });
            return;
        }
        
        // Сохраняем сообщение
        const message = await Message.create(
            chatId,
            socket.userId,
            text || null,
            photo || null,
            replyToId || null
        );
        
        // Обогащаем данными о отправителе
        const enrichedMessage = {
            ...message,
            sender: {
                id: socket.userId,
                name: socket.userName,
                avatar: socket.userAvatar
            }
        };
        
        // Кешируем сообщение
        const cachedMessages = await get(`chat:${chatId}:messages`) || [];
        cachedMessages.push(enrichedMessage);
        if (cachedMessages.length > 200) {
            cachedMessages.shift();
        }
        await set(`chat:${chatId}:messages`, cachedMessages, 86400);
        
        // Отправляем в комнату
        io.to(`chat_${chatId}`).emit('new_message', enrichedMessage);
        
        // Увеличиваем счётчик непрочитанных для получателя
        const unreadKey = `chat:${chatId}:unread:${otherUserId}`;
        const unreadCount = await get(unreadKey) || 0;
        await set(unreadKey, parseInt(unreadCount) + 1, 86400);
        
        // Отправляем уведомление получателю (если он не в чате)
        const otherSocketId = activeUsers.get(otherUserId);
        if (!otherSocketId || !activeRooms.get(chatId)?.has(otherSocketId)) {
            io.to(otherSocketId)?.emit('new_message_notification', {
                chatId,
                message: enrichedMessage,
                senderName: socket.userName
            });
        }
        
        // Обновляем последнюю активность в чате
        await Chat.updateActivity(chatId);
        
        console.log(`💬 [SOCKET] Сообщение в чат ${chatId} от ${socket.userId}`);
        
    } catch (error) {
        console.error('Ошибка отправки сообщения:', error);
        socket.emit('error', { message: 'Не удалось отправить сообщение' });
    }
}

// Редактирование сообщения
async function handleEditMessage(socket, io, { chatId, messageId, newText }) {
    try {
        // Обновляем сообщение
        const result = await Message.query(
            `UPDATE messages SET text = $1, is_edited = true, edited_at = NOW()
             WHERE id = $2 AND sender_id = $3
             RETURNING *`,
            [newText, messageId, socket.userId]
        );
        
        if (result.rows.length > 0) {
            io.to(`chat_${chatId}`).emit('message_edited', {
                messageId,
                newText,
                editedAt: result.rows[0].edited_at
            });
        }
    } catch (error) {
        console.error('Ошибка редактирования сообщения:', error);
        socket.emit('error', { message: 'Не удалось редактировать сообщение' });
    }
}

// Удаление сообщения
async function handleDeleteMessage(socket, io, { chatId, messageId }) {
    try {
        const result = await Message.query(
            `DELETE FROM messages WHERE id = $1 AND sender_id = $2 RETURNING *`,
            [messageId, socket.userId]
        );
        
        if (result.rows.length > 0) {
            io.to(`chat_${chatId}`).emit('message_deleted', { messageId });
            
            // Удаляем из кеша
            const cachedMessages = await get(`chat:${chatId}:messages`);
            if (cachedMessages) {
                const filtered = cachedMessages.filter(m => m.id !== messageId);
                await set(`chat:${chatId}:messages`, filtered, 86400);
            }
        }
    } catch (error) {
        console.error('Ошибка удаления сообщения:', error);
        socket.emit('error', { message: 'Не удалось удалить сообщение' });
    }
}

// Пользователь печатает
function handleTypingStart(socket, io, { chatId }) {
    // Очищаем предыдущий таймер
    const timeoutKey = `${chatId}:${socket.userId}`;
    if (typingTimeouts.has(timeoutKey)) {
        clearTimeout(typingTimeouts.get(timeoutKey));
    }
    
    // Устанавливаем новый таймер (3 секунды)
    const timeout = setTimeout(() => {
        handleTypingStop(socket, io, { chatId });
        typingTimeouts.delete(timeoutKey);
    }, 3000);
    
    typingTimeouts.set(timeoutKey, timeout);
    
    // Уведомляем собеседника
    socket.to(`chat_${chatId}`).emit('user_typing', {
        chatId,
        userId: socket.userId,
        userName: socket.userName,
        isTyping: true
    });
}

// Пользователь перестал печатать
function handleTypingStop(socket, io, { chatId }) {
    socket.to(`chat_${chatId}`).emit('user_typing', {
        chatId,
        userId: socket.userId,
        isTyping: false
    });
}

// Сообщения прочитаны
async function handleMessagesRead(socket, io, { chatId, messageIds }) {
    try {
        await Message.markAsRead(chatId, socket.userId, messageIds);
        
        // Очищаем кеш непрочитанных
        await del(`chat:${chatId}:unread:${socket.userId}`);
        
        // Уведомляем собеседника
        socket.to(`chat_${chatId}`).emit('messages_read', {
            chatId,
            userId: socket.userId,
            messageIds
        });
    } catch (error) {
        console.error('Ошибка отметки прочтения:', error);
    }
}

// Получение онлайн-статуса пользователя
async function handleGetUserStatus(socket, { userId }) {
    const isOnline = activeUsers.has(userId);
    let lastSeen = null;
    
    if (!isOnline) {
        const user = await User.findById(userId);
        lastSeen = user?.last_seen;
    }
    
    socket.emit('user_status_response', {
        userId,
        status: isOnline ? 'online' : 'offline',
        lastSeen
    });
}

// ============================================
// УТИЛИТЫ ДЛЯ ВНЕШНЕГО ИСПОЛЬЗОВАНИЯ
// ============================================

// Отправка уведомления пользователю
async function sendNotificationToUser(userId, event, data) {
    const socketId = await get(`user:socket:${userId}`);
    if (socketId && global.io) {
        global.io.to(socketId).emit(event, data);
        return true;
    }
    return false;
}

// Отправка уведомления в чат
function sendToChat(chatId, event, data) {
    if (global.io) {
        global.io.to(`chat_${chatId}`).emit(event, data);
        return true;
    }
    return false;
}

// Получение онлайн-статуса
function isUserOnline(userId) {
    return activeUsers.has(userId);
}

// Получение списка онлайн-пользователей
function getOnlineUsers() {
    return Array.from(activeUsers.keys());
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    initSocket,
    sendNotificationToUser,
    sendToChat,
    isUserOnline,
    getOnlineUsers
};