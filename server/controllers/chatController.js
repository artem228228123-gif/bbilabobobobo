/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/controllers/chatController.js
 * Описание: Контроллер чатов (список чатов, сообщения, автоответчик, быстрые ответы)
 */

const { Chat, Message, User, Listing, Blacklist } = require('../models');
const { get, set, del, incr, sadd, smembers, srem } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { sendNotification } = require('../services/notificationService');
const { processImage } = require('../services/imageService');
const fs = require('fs');
const path = require('path');
const { config } = require('../../config/env');

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

const CACHE_TTL = {
    chatList: 300,       // 5 минут
    messages: 3600,      // 1 час
    unreadCount: 300,    // 5 минут
    autoReply: 86400     // 24 часа
};

async function clearChatCache(chatId, userId) {
    await del(`chat:${chatId}`);
    await del(`chat:${chatId}:messages`);
    await del(`chats:user:${userId}`);
    await del(`chat:unread:${userId}`);
}

async function updateUnreadCount(chatId, userId, increment = 1) {
    const key = `chat:unread:${userId}:${chatId}`;
    const current = await get(key) || 0;
    const newCount = Math.max(0, parseInt(current) + increment);
    if (newCount > 0) {
        await set(key, newCount, CACHE_TTL.unreadCount);
    } else {
        await del(key);
    }
    // Обновляем общее количество непрочитанных
    const totalKey = `chat:unread:total:${userId}`;
    const total = await get(totalKey) || 0;
    await set(totalKey, Math.max(0, parseInt(total) + increment), CACHE_TTL.unreadCount);
    return newCount;
}

async function getTotalUnreadCount(userId) {
    const cached = await get(`chat:unread:total:${userId}`);
    if (cached !== null) return parseInt(cached);
    
    const result = await Message.query(
        `SELECT COUNT(*) FROM messages m
         JOIN chats c ON c.id = m.chat_id
         WHERE (c.buyer_id = $1 OR c.seller_id = $1) 
         AND m.sender_id != $1 
         AND m.is_read = false`,
        [userId]
    );
    const count = parseInt(result.rows[0].count);
    await set(`chat:unread:total:${userId}`, count, CACHE_TTL.unreadCount);
    return count;
}

// ============================================
// ПОЛУЧЕНИЕ СПИСКА ЧАТОВ
// ============================================

async function getChats(req, res) {
    try {
        const cacheKey = `chats:user:${req.user.id}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, chats: cached, fromCache: true });
        }
        
        const result = await Chat.query(`
            SELECT c.*, 
                   l.title as listing_title, l.price as listing_price, 
                   (SELECT url FROM listing_photos WHERE listing_id = c.listing_id ORDER BY order_index ASC LIMIT 1) as listing_photo,
                   CASE 
                       WHEN c.buyer_id = $1 THEN s.name
                       ELSE b.name
                   END as other_user_name,
                   CASE 
                       WHEN c.buyer_id = $1 THEN s.avatar
                       ELSE b.avatar
                   END as other_user_avatar,
                   CASE 
                       WHEN c.buyer_id = $1 THEN s.id
                       ELSE b.id
                   END as other_user_id,
                   (SELECT text FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
                   (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_time,
                   COALESCE(${req.user.id === 'c.buyer_id' ? 'c.seller_unread_count' : 'c.buyer_unread_count'}, 0) as unread_count
            FROM chats c
            JOIN listings l ON l.id = c.listing_id
            JOIN users b ON b.id = c.buyer_id
            JOIN users s ON s.id = c.seller_id
            WHERE (c.buyer_id = $1 OR c.seller_id = $1) AND c.deleted_by IS NULL
            ORDER BY last_message_time DESC NULLS LAST
        `, [req.user.id]);
        
        // Добавляем онлайн-статус
        const chatsWithStatus = await Promise.all(result.rows.map(async (chat) => {
            const isOnline = await get(`user:socket:${chat.other_user_id}`) !== null;
            return { ...chat, other_user_online: isOnline };
        }));
        
        await set(cacheKey, chatsWithStatus, CACHE_TTL.chatList);
        res.json({ success: true, chats: chatsWithStatus });
    } catch (error) {
        console.error('Ошибка получения чатов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// СОЗДАНИЕ ЧАТА
// ============================================

async function createChat(req, res) {
    const { listing_id, seller_id } = req.body;
    
    if (req.user.id === parseInt(seller_id)) {
        return res.status(400).json({ error: 'Нельзя создать чат с самим собой' });
    }
    
    try {
        // Проверяем блокировку
        const isBlocked = await Blacklist.isBlocked(seller_id, req.user.id);
        if (isBlocked) {
            return res.status(403).json({ error: 'Вы заблокированы этим пользователем' });
        }
        
        const isBlockedByUser = await Blacklist.isBlocked(req.user.id, seller_id);
        if (isBlockedByUser) {
            return res.status(403).json({ error: 'Вы заблокировали этого пользователя' });
        }
        
        const listing = await Listing.findById(listing_id);
        if (!listing) {
            return res.status(404).json({ error: 'Объявление не найдено' });
        }
        
        // Проверяем, существует ли уже чат
        const existing = await Chat.query(
            `SELECT id FROM chats WHERE listing_id = $1 AND buyer_id = $2 AND seller_id = $3`,
            [listing_id, req.user.id, seller_id]
        );
        
        if (existing.rows.length > 0) {
            return res.json({ success: true, chat: existing.rows[0], exists: true });
        }
        
        const result = await Chat.query(
            `INSERT INTO chats (listing_id, buyer_id, seller_id, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())
             RETURNING *`,
            [listing_id, req.user.id, seller_id]
        );
        
        const chat = result.rows[0];
        await clearChatCache(chat.id, req.user.id);
        
        // Отправляем уведомление продавцу
        await addJob('notificationQueue', 'newChatNotification', {
            userId: seller_id,
            chatId: chat.id,
            buyerName: req.user.name,
            listingTitle: listing.title
        });
        
        res.status(201).json({ success: true, chat });
    } catch (error) {
        console.error('Ошибка создания чата:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОЛУЧЕНИЕ ИНФОРМАЦИИ О ЧАТЕ
// ============================================

async function getChat(req, res) {
    const { id } = req.params;
    
    try {
        const result = await Chat.query(`
            SELECT c.*, 
                   l.title as listing_title, l.price as listing_price,
                   b.name as buyer_name, b.avatar as buyer_avatar,
                   s.name as seller_name, s.avatar as seller_avatar
            FROM chats c
            JOIN listings l ON l.id = c.listing_id
            JOIN users b ON b.id = c.buyer_id
            JOIN users s ON s.id = c.seller_id
            WHERE c.id = $1
        `, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Чат не найден' });
        }
        
        const chat = result.rows[0];
        
        if (chat.buyer_id !== req.user.id && chat.seller_id !== req.user.id) {
            return res.status(403).json({ error: 'Доступ запрещён' });
        }
        
        const otherUser = chat.buyer_id === req.user.id 
            ? { id: chat.seller_id, name: chat.seller_name, avatar: chat.seller_avatar }
            : { id: chat.buyer_id, name: chat.buyer_name, avatar: chat.buyer_avatar };
        
        const isOnline = await get(`user:socket:${otherUser.id}`) !== null;
        
        res.json({
            success: true,
            chat: {
                ...chat,
                other_user: { ...otherUser, online: isOnline }
            }
        });
    } catch (error) {
        console.error('Ошибка получения чата:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// УДАЛЕНИЕ ЧАТА
// ============================================

async function deleteChat(req, res) {
    const { id } = req.params;
    
    try {
        const result = await Chat.query(
            `UPDATE chats SET deleted_by = $1, deleted_at = NOW() WHERE id = $2 AND (buyer_id = $1 OR seller_id = $1) RETURNING *`,
            [req.user.id, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Чат не найден' });
        }
        
        await clearChatCache(id, req.user.id);
        res.json({ success: true, message: 'Чат удалён' });
    } catch (error) {
        console.error('Ошибка удаления чата:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОЛУЧЕНИЕ СООБЩЕНИЙ
// ============================================

async function getMessages(req, res) {
    const { id } = req.params;
    const { limit = 50, before } = req.query;
    
    try {
        // Проверяем доступ
        const chatCheck = await Chat.query(
            `SELECT id FROM chats WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2)`,
            [id, req.user.id]
        );
        
        if (chatCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Доступ запрещён' });
        }
        
        let sql = `
            SELECT m.*, u.name as sender_name, u.avatar as sender_avatar
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.chat_id = $1 AND m.is_deleted = false
        `;
        const params = [id];
        
        if (before) {
            sql += ` AND m.id < $2`;
            params.push(before);
        }
        
        sql += ` ORDER BY m.id DESC LIMIT $${params.length + 1}`;
        params.push(parseInt(limit) + 1);
        
        const result = await Message.query(sql, params);
        const hasMore = result.rows.length > parseInt(limit);
        const messages = hasMore ? result.rows.slice(0, -1) : result.rows;
        const nextCursor = hasMore ? messages[messages.length - 1]?.id : null;
        
        // Отмечаем сообщения как прочитанные
        const unreadMessages = messages.filter(m => m.sender_id !== req.user.id && !m.is_read);
        if (unreadMessages.length > 0) {
            await Message.query(
                `UPDATE messages SET is_read = true, read_at = NOW() WHERE id = ANY($1::int[])`,
                [unreadMessages.map(m => m.id)]
            );
            
            // Обновляем счётчики непрочитанных в чате
            if (req.user.id === chatCheck.rows[0].buyer_id) {
                await Chat.query(`UPDATE chats SET buyer_unread_count = 0 WHERE id = $1`, [id]);
            } else {
                await Chat.query(`UPDATE chats SET seller_unread_count = 0 WHERE id = $1`, [id]);
            }
            
            await updateUnreadCount(id, req.user.id, -unreadMessages.length);
        }
        
        res.json({
            success: true,
            messages: messages.reverse(),
            nextCursor,
            hasMore,
            count: messages.length
        });
    } catch (error) {
        console.error('Ошибка получения сообщений:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ОТПРАВКА СООБЩЕНИЯ
// ============================================

async function sendMessage(req, res) {
    const { id } = req.params;
    const { text, reply_to_id } = req.body;
    let photoUrl = null;
    
    if (!text && !req.file) {
        return res.status(400).json({ error: 'Введите текст или прикрепите фото' });
    }
    
    try {
        // Получаем информацию о чате
        const chatResult = await Chat.query(
            `SELECT * FROM chats WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2)`,
            [id, req.user.id]
        );
        
        if (chatResult.rows.length === 0) {
            return res.status(403).json({ error: 'Доступ запрещён' });
        }
        
        const chat = chatResult.rows[0];
        const otherUserId = chat.buyer_id === req.user.id ? chat.seller_id : chat.buyer_id;
        
        // Проверяем блокировку
        const isBlocked = await Blacklist.isBlocked(otherUserId, req.user.id);
        if (isBlocked) {
            return res.status(403).json({ error: 'Вы заблокированы этим пользователем' });
        }
        
        // Проверяем автоответчик получателя
        const autoReplySettings = await get(`user:autoreply:${otherUserId}`);
        if (autoReplySettings && autoReplySettings.enabled) {
            const now = new Date();
            const currentHour = now.getHours();
            const [startHour] = autoReplySettings.start_time.split(':');
            const [endHour] = autoReplySettings.end_time.split(':');
            
            if (currentHour >= parseInt(startHour) || currentHour < parseInt(endHour)) {
                // Отправляем автоответ
                await Message.query(
                    `INSERT INTO messages (chat_id, sender_id, text, created_at, is_read)
                     VALUES ($1, $2, $3, NOW(), false)`,
                    [id, otherUserId, autoReplySettings.text]
                );
            }
        }
        
        // Обрабатываем фото
        if (req.file) {
            const processed = await processImage(req.file.buffer, {
                width: 1200,
                quality: 80
            });
            
            const photoFilename = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}.webp`;
            const photoPath = path.join(__dirname, '../../uploads/chats', photoFilename);
            fs.writeFileSync(photoPath, processed.buffer);
            photoUrl = `/uploads/chats/${photoFilename}`;
            
            if (fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
        }
        
        // Сохраняем сообщение
        const result = await Message.query(
            `INSERT INTO messages (chat_id, sender_id, text, photo, reply_to_id, created_at, is_read)
             VALUES ($1, $2, $3, $4, $5, NOW(), false)
             RETURNING *`,
            [id, req.user.id, text || null, photoUrl, reply_to_id || null]
        );
        
        const message = result.rows[0];
        
        // Обновляем счётчик непрочитанных для получателя
        await updateUnreadCount(id, otherUserId, 1);
        
        // Обновляем счётчики в таблице чатов
        if (req.user.id === chat.buyer_id) {
            await Chat.query(`UPDATE chats SET seller_unread_count = seller_unread_count + 1, updated_at = NOW() WHERE id = $1`, [id]);
        } else {
            await Chat.query(`UPDATE chats SET buyer_unread_count = buyer_unread_count + 1, updated_at = NOW() WHERE id = $1`, [id]);
        }
        
        // Очищаем кеш
        await clearChatCache(id, req.user.id);
        await clearChatCache(id, otherUserId);
        
        // Отправляем уведомление получателю
        await sendNotification(otherUserId, 'message', {
            title: 'Новое сообщение',
            message: text ? text.substring(0, 100) : '📷 Фото',
            senderName: req.user.name,
            chatId: id,
            link: `/chats.html?chat=${id}`
        });
        
        // Отправляем через WebSocket
        const socketId = await get(`user:socket:${otherUserId}`);
        if (socketId && global.io) {
            global.io.to(socketId).emit('new_message', {
                ...message,
                sender: {
                    id: req.user.id,
                    name: req.user.name,
                    avatar: req.user.avatar
                }
            });
        }
        
        res.status(201).json({
            success: true,
            message: {
                ...message,
                sender: {
                    id: req.user.id,
                    name: req.user.name,
                    avatar: req.user.avatar
                }
            }
        });
    } catch (error) {
        console.error('Ошибка отправки сообщения:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ОТМЕТКА СООБЩЕНИЙ КАК ПРОЧИТАННЫХ
// ============================================

async function markMessagesAsRead(req, res) {
    const { id } = req.params;
    const { message_ids } = req.body;
    
    try {
        // Получаем информацию о чате
        const chatResult = await Chat.query(
            `SELECT * FROM chats WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2)`,
            [id, req.user.id]
        );
        
        if (chatResult.rows.length === 0) {
            return res.status(403).json({ error: 'Доступ запрещён' });
        }
        
        const chat = chatResult.rows[0];
        
        let query = `
            UPDATE messages SET is_read = true, read_at = NOW()
            WHERE chat_id = $1 AND sender_id != $2 AND is_read = false
        `;
        const params = [id, req.user.id];
        
        if (message_ids && message_ids.length > 0) {
            query += ` AND id = ANY($3::int[])`;
            params.push(message_ids);
        }
        
        const result = await Message.query(query, params);
        
        // Обновляем счётчики в чате
        if (req.user.id === chat.buyer_id) {
            await Chat.query(`UPDATE chats SET buyer_unread_count = 0 WHERE id = $1`, [id]);
        } else {
            await Chat.query(`UPDATE chats SET seller_unread_count = 0 WHERE id = $1`, [id]);
        }
        
        await updateUnreadCount(id, req.user.id, -result.rowCount);
        
        res.json({ success: true, marked_count: result.rowCount });
    } catch (error) {
        console.error('Ошибка отметки прочтения:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// УДАЛЕНИЕ СООБЩЕНИЯ
// ============================================

async function deleteMessage(req, res) {
    const { id, messageId } = req.params;
    
    try {
        // Проверяем, что сообщение принадлежит пользователю
        const result = await Message.query(
            `UPDATE messages SET is_deleted = true, deleted_at = NOW()
             WHERE id = $1 AND sender_id = $2 AND chat_id = $3
             RETURNING *`,
            [messageId, req.user.id, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Сообщение не найдено' });
        }
        
        // Удаляем фото если есть
        if (result.rows[0].photo) {
            const photoPath = path.join(__dirname, '../../uploads/chats', path.basename(result.rows[0].photo));
            if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
        }
        
        await clearChatCache(id, req.user.id);
        
        // Уведомляем через WebSocket
        const chatResult = await Chat.query(`SELECT buyer_id, seller_id FROM chats WHERE id = $1`, [id]);
        if (chatResult.rows.length > 0) {
            const otherUserId = chatResult.rows[0].buyer_id === req.user.id 
                ? chatResult.rows[0].seller_id 
                : chatResult.rows[0].buyer_id;
            const socketId = await get(`user:socket:${otherUserId}`);
            if (socketId && global.io) {
                global.io.to(socketId).emit('message_deleted', { messageId });
            }
        }
        
        res.json({ success: true, message: 'Сообщение удалено' });
    } catch (error) {
        console.error('Ошибка удаления сообщения:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// НАСТРОЙКИ АВТООТВЕТЧИКА
// ============================================

async function getAutoReplySettings(req, res) {
    try {
        const settings = await get(`user:autoreply:${req.user.id}`);
        const defaultSettings = {
            enabled: false,
            text: 'Здравствуйте! Я сейчас отсутствую, но отвечу вам при первой возможности. Спасибо за понимание!',
            start_time: '22:00',
            end_time: '09:00',
            days_of_week: [1, 2, 3, 4, 5, 6, 7]
        };
        res.json({ success: true, settings: settings || defaultSettings });
    } catch (error) {
        console.error('Ошибка получения настроек автоответчика:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function updateAutoReplySettings(req, res) {
    const { enabled, text, start_time, end_time, days_of_week } = req.body;
    
    try {
        const settings = {
            enabled: enabled !== undefined ? enabled : false,
            text: text || 'Здравствуйте! Я сейчас отсутствую, но отвечу вам при первой возможности. Спасибо за понимание!',
            start_time: start_time || '22:00',
            end_time: end_time || '09:00',
            days_of_week: days_of_week || [1, 2, 3, 4, 5, 6, 7]
        };
        
        await set(`user:autoreply:${req.user.id}`, settings, CACHE_TTL.autoReply);
        res.json({ success: true, settings });
    } catch (error) {
        console.error('Ошибка обновления настроек автоответчика:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= БЫСТРЫЕ ОТВЕТЫ (ШАБЛОНЫ)
// ============================================

async function getQuickReplies(req, res) {
    try {
        const result = await Message.query(
            `SELECT * FROM quick_replies WHERE user_id = $1 ORDER BY order_index ASC`,
            [req.user.id]
        );
        res.json({ success: true, replies: result.rows });
    } catch (error) {
        console.error('Ошибка получения быстрых ответов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function createQuickReply(req, res) {
    const { title, text, shortcut, order_index } = req.body;
    
    if (!title || !text) {
        return res.status(400).json({ error: 'Название и текст обязательны' });
    }
    
    try {
        const result = await Message.query(
            `INSERT INTO quick_replies (user_id, title, text, shortcut, order_index, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             RETURNING *`,
            [req.user.id, title, text, shortcut || null, order_index || 0]
        );
        res.status(201).json({ success: true, reply: result.rows[0] });
    } catch (error) {
        console.error('Ошибка создания быстрого ответа:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function updateQuickReply(req, res) {
    const { id } = req.params;
    const { title, text, shortcut, order_index } = req.body;
    
    try {
        const updates = [];
        const params = [];
        let idx = 1;
        
        if (title !== undefined) {
            updates.push(`title = $${idx}`);
            params.push(title);
            idx++;
        }
        if (text !== undefined) {
            updates.push(`text = $${idx}`);
            params.push(text);
            idx++;
        }
        if (shortcut !== undefined) {
            updates.push(`shortcut = $${idx}`);
            params.push(shortcut);
            idx++;
        }
        if (order_index !== undefined) {
            updates.push(`order_index = $${idx}`);
            params.push(order_index);
            idx++;
        }
        
        updates.push(`updated_at = NOW()`);
        params.push(id, req.user.id);
        
        const result = await Message.query(
            `UPDATE quick_replies SET ${updates.join(', ')} WHERE id = $${idx} AND user_id = $${idx + 1} RETURNING *`,
            params
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Быстрый ответ не найден' });
        }
        
        res.json({ success: true, reply: result.rows[0] });
    } catch (error) {
        console.error('Ошибка обновления быстрого ответа:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function deleteQuickReply(req, res) {
    const { id } = req.params;
    
    try {
        const result = await Message.query(
            `DELETE FROM quick_replies WHERE id = $1 AND user_id = $2 RETURNING *`,
            [id, req.user.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Быстрый ответ не найден' });
        }
        
        res.json({ success: true, message: 'Быстрый ответ удалён' });
    } catch (error) {
        console.error('Ошибка удаления быстрого ответа:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// НЕПРОЧИТАННЫЕ СООБЩЕНИЯ
// ============================================

async function getUnreadCount(req, res) {
    try {
        const count = await getTotalUnreadCount(req.user.id);
        res.json({ success: true, count });
    } catch (error) {
        console.error('Ошибка получения количества непрочитанных:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// УДАЛЕНИЕ ВСЕХ ЧАТОВ
// ============================================

async function clearAllChats(req, res) {
    try {
        await Chat.query(
            `UPDATE chats SET deleted_by = $1, deleted_at = NOW() WHERE buyer_id = $1 OR seller_id = $1`,
            [req.user.id]
        );
        
        await del(`chats:user:${req.user.id}`);
        await del(`chat:unread:total:${req.user.id}`);
        
        res.json({ success: true, message: 'Все чаты удалены' });
    } catch (error) {
        console.error('Ошибка удаления всех чатов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ЖАЛОБА НА ЧАТ/ПОЛЬЗОВАТЕЛЯ
// ============================================

async function reportChat(req, res) {
    const { id } = req.params;
    const { reason, description } = req.body;
    
    try {
        const chatResult = await Chat.query(
            `SELECT * FROM chats WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2)`,
            [id, req.user.id]
        );
        
        if (chatResult.rows.length === 0) {
            return res.status(403).json({ error: 'Доступ запрещён' });
        }
        
        const chat = chatResult.rows[0];
        const reportedUserId = chat.buyer_id === req.user.id ? chat.seller_id : chat.buyer_id;
        
        await Message.query(
            `INSERT INTO complaints (user_id, complained_user_id, chat_id, reason, description, status, created_at)
             VALUES ($1, $2, $3, $4, $5, 'pending', NOW())`,
            [req.user.id, reportedUserId, id, reason, description || null]
        );
        
        await addJob('notificationQueue', 'notifyModerators', {
            type: 'chat_complaint',
            chatId: id,
            reason
        });
        
        res.json({ success: true, message: 'Жалоба отправлена' });
    } catch (error) {
        console.error('Ошибка отправки жалобы:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    getChats,
    createChat,
    getChat,
    deleteChat,
    getMessages,
    sendMessage,
    markMessagesAsRead,
    deleteMessage,
    getAutoReplySettings,
    updateAutoReplySettings,
    getQuickReplies,
    createQuickReply,
    updateQuickReply,
    deleteQuickReply,
    getUnreadCount,
    clearAllChats,
    reportChat
};