/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/sockets/chatSocket.js
 * Описание: WebSocket обработчики для чатов (реальное время)
 */

const { Chat, Message, User, Blacklist } = require('../models');
const { get, set, del } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { sendNotification } = require('../services/notificationService');

// ============================================
// ХРАНИЛИЩА
// ============================================

const activeUsers = new Map();        // userId -> socketId
const userRooms = new Map();          // userId -> Set of roomIds
const typingUsers = new Map();        // roomId -> Set of userIds

// ============================================
= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

async function updateUnreadCount(chatId, userId, increment = 1) {
    const key = `chat:unread:${userId}:${chatId}`;
    const current = await get(key) || 0;
    const newCount = Math.max(0, parseInt(current) + increment);
    if (newCount > 0) {
        await set(key, newCount, 86400);
    } else {
        await del(key);
    }
    
    const totalKey = `chat:unread:total:${userId}`;
    const total = await get(totalKey) || 0;
    await set(totalKey, Math.max(0, parseInt(total) + increment), 86400);
    return newCount;
}

async function resetUnreadCount(chatId, userId) {
    const key = `chat:unread:${userId}:${chatId}`;
    const oldCount = await get(key) || 0;
    await del(key);
    
    const totalKey = `chat:unread:total:${userId}`;
    const total = await get(totalKey) || 0;
    await set(totalKey, Math.max(0, parseInt(total) - parseInt(oldCount)), 86400);
}

// ============================================
= ОСНОВНЫЕ ОБРАБОТЧИКИ
// ============================================

function setupChatSocket(io, socket) {
    const userId = socket.userId;
    const userName = socket.userName;
    const userAvatar = socket.userAvatar;
    
    // ========================================
    // ПРИСОЕДИНЕНИЕ К КОМНАТЕ (ЧАТУ)
    // ========================================
    socket.on('join_chat', async (data) => {
        const { chatId } = data;
        
        if (!chatId) return;
        
        try {
            // Проверяем доступ к чату
            const chat = await Chat.findById(chatId);
            if (!chat || (chat.buyer_id !== userId && chat.seller_id !== userId)) {
                socket.emit('error', { message: 'Доступ запрещён' });
                return;
            }
            
            socket.join(`chat_${chatId}`);
            
            if (!userRooms.has(userId)) {
                userRooms.set(userId, new Set());
            }
            userRooms.get(userId).add(chatId);
            
            // Получаем историю сообщений из кеша
            const cachedMessages = await get(`chat:${chatId}:messages`);
            if (cachedMessages) {
                socket.emit('chat_history', { messages: cachedMessages.slice(-50) });
            }
            
            console.log(`📢 [ChatSocket] Пользователь ${userId} присоединился к чату ${chatId}`);
            
            // Уведомляем собеседника
            const otherUserId = chat.buyer_id === userId ? chat.seller_id : chat.buyer_id;
            const otherSocketId = activeUsers.get(otherUserId);
            if (otherSocketId) {
                io.to(otherSocketId).emit('user_joined_chat', {
                    chatId,
                    userId,
                    userName
                });
            }
            
            // Отмечаем сообщения как прочитанные
            await Message.markAsRead(chatId, userId);
            await resetUnreadCount(chatId, userId);
            
        } catch (error) {
            console.error('Ошибка присоединения к чату:', error);
            socket.emit('error', { message: 'Ошибка подключения к чату' });
        }
    });
    
    // ========================================
    // ПОКИДАНИЕ КОМНАТЫ
    // ========================================
    socket.on('leave_chat', (data) => {
        const { chatId } = data;
        
        socket.leave(`chat_${chatId}`);
        
        const rooms = userRooms.get(userId);
        if (rooms) {
            rooms.delete(chatId);
            if (rooms.size === 0) {
                userRooms.delete(userId);
            }
        }
        
        console.log(`👋 [ChatSocket] Пользователь ${userId} покинул чат ${chatId}`);
    });
    
    // ========================================
    // ОТПРАВКА СООБЩЕНИЯ
    // ========================================
    socket.on('send_message', async (data) => {
        const { chatId, text, photo, replyToId } = data;
        
        try {
            // Получаем информацию о чате
            const chat = await Chat.findById(chatId);
            if (!chat || (chat.buyer_id !== userId && chat.seller_id !== userId)) {
                socket.emit('error', { message: 'Доступ запрещён' });
                return;
            }
            
            const otherUserId = chat.buyer_id === userId ? chat.seller_id : chat.buyer_id;
            
            // Проверяем блокировку
            const isBlocked = await Blacklist.isBlocked(otherUserId, userId);
            if (isBlocked) {
                socket.emit('error', { message: 'Вы заблокированы этим пользователем' });
                return;
            }
            
            // Сохраняем сообщение
            const message = await Message.create(
                chatId,
                userId,
                text || null,
                photo || null,
                replyToId || null
            );
            
            const enrichedMessage = {
                ...message,
                sender: {
                    id: userId,
                    name: userName,
                    avatar: userAvatar
                }
            };
            
            // Кешируем сообщение
            const cachedMessages = await get(`chat:${chatId}:messages`) || [];
            cachedMessages.push(enrichedMessage);
            if (cachedMessages.length > 200) {
                cachedMessages.shift();
            }
            await set(`chat:${chatId}:messages`, cachedMessages, 86400);
            
            // Отправляем всем в комнате
            io.to(`chat_${chatId}`).emit('new_message', enrichedMessage);
            
            // Обновляем счётчик непрочитанных для получателя
            await updateUnreadCount(chatId, otherUserId, 1);
            
            // Обновляем счётчики в таблице чатов
            if (userId === chat.buyer_id) {
                await Chat.query(`UPDATE chats SET seller_unread_count = seller_unread_count + 1, updated_at = NOW() WHERE id = $1`, [chatId]);
            } else {
                await Chat.query(`UPDATE chats SET buyer_unread_count = buyer_unread_count + 1, updated_at = NOW() WHERE id = $1`, [chatId]);
            }
            
            // Отправляем уведомление получателю
            await sendNotification(otherUserId, 'message', {
                title: 'Новое сообщение',
                message: text ? text.substring(0, 100) : '📷 Фото',
                senderName: userName,
                chatId,
                link: `/chats.html?chat=${chatId}`
            });
            
            console.log(`💬 [ChatSocket] Сообщение в чат ${chatId} от ${userId}`);
            
        } catch (error) {
            console.error('Ошибка отправки сообщения:', error);
            socket.emit('error', { message: 'Не удалось отправить сообщение' });
        }
    });
    
    // ========================================
    // РЕДАКТИРОВАНИЕ СООБЩЕНИЯ
    // ========================================
    socket.on('edit_message', async (data) => {
        const { chatId, messageId, newText } = data;
        
        try {
            const result = await Message.query(
                `UPDATE messages SET text = $1, is_edited = true, edited_at = NOW()
                 WHERE id = $2 AND sender_id = $3
                 RETURNING *`,
                [newText, messageId, userId]
            );
            
            if (result.rows.length > 0) {
                io.to(`chat_${chatId}`).emit('message_edited', {
                    messageId,
                    newText,
                    editedAt: result.rows[0].edited_at
                });
                
                // Обновляем кеш
                const cachedMessages = await get(`chat:${chatId}:messages`);
                if (cachedMessages) {
                    const updated = cachedMessages.map(m => 
                        m.id === messageId ? { ...m, text: newText, is_edited: true } : m
                    );
                    await set(`chat:${chatId}:messages`, updated, 86400);
                }
            }
        } catch (error) {
            console.error('Ошибка редактирования сообщения:', error);
            socket.emit('error', { message: 'Не удалось редактировать сообщение' });
        }
    });
    
    // ========================================
    // УДАЛЕНИЕ СООБЩЕНИЯ
    // ========================================
    socket.on('delete_message', async (data) => {
        const { chatId, messageId } = data;
        
        try {
            const result = await Message.query(
                `DELETE FROM messages WHERE id = $1 AND sender_id = $2 RETURNING *`,
                [messageId, userId]
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
    });
    
    // ========================================
    // ПОЛЬЗОВАТЕЛЬ ПЕЧАТАЕТ
    // ========================================
    socket.on('typing_start', (data) => {
        const { chatId } = data;
        
        if (!typingUsers.has(chatId)) {
            typingUsers.set(chatId, new Set());
        }
        
        const typingSet = typingUsers.get(chatId);
        if (!typingSet.has(userId)) {
            typingSet.add(userId);
            socket.to(`chat_${chatId}`).emit('user_typing', {
                userId,
                userName,
                isTyping: true
            });
        }
        
        // Автоматически сбрасываем через 3 секунды
        setTimeout(() => {
            if (typingSet.has(userId)) {
                typingSet.delete(userId);
                socket.to(`chat_${chatId}`).emit('user_typing', {
                    userId,
                    isTyping: false
                });
            }
        }, 3000);
    });
    
    socket.on('typing_stop', (data) => {
        const { chatId } = data;
        
        const typingSet = typingUsers.get(chatId);
        if (typingSet && typingSet.has(userId)) {
            typingSet.delete(userId);
            socket.to(`chat_${chatId}`).emit('user_typing', {
                userId,
                isTyping: false
            });
        }
    });
    
    // ========================================
    // СООБЩЕНИЯ ПРОЧИТАНЫ
    // ========================================
    socket.on('messages_read', async (data) => {
        const { chatId, messageIds } = data;
        
        try {
            await Message.markAsRead(chatId, userId, messageIds);
            await resetUnreadCount(chatId, userId);
            
            // Обновляем счётчики в чате
            const chat = await Chat.findById(chatId);
            if (chat) {
                if (userId === chat.buyer_id) {
                    await Chat.query(`UPDATE chats SET buyer_unread_count = 0 WHERE id = $1`, [chatId]);
                } else {
                    await Chat.query(`UPDATE chats SET seller_unread_count = 0 WHERE id = $1`, [chatId]);
                }
            }
            
            io.to(`chat_${chatId}`).emit('messages_read', {
                userId,
                messageIds
            });
        } catch (error) {
            console.error('Ошибка отметки прочтения:', error);
        }
    });
    
    // ========================================
    // ОТКЛЮЧЕНИЕ
    // ========================================
    socket.on('disconnect', () => {
        console.log(`🔌 [ChatSocket] Пользователь ${userId} отключился`);
        
        activeUsers.delete(userId);
        
        // Удаляем из всех комнат
        const rooms = userRooms.get(userId);
        if (rooms) {
            for (const roomId of rooms) {
                socket.leave(`chat_${roomId}`);
            }
            userRooms.delete(userId);
        }
    });
}

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    setupChatSocket,
    activeUsers,
    userRooms,
    typingUsers,
    updateUnreadCount,
    resetUnreadCount
};