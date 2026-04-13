/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/routes/chats.js
 * Описание: Маршруты для чатов (список чатов, сообщения, WebSocket интеграция)
 */

const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();
const { Chat, Message, Listing, User, Blacklist } = require('../models');
const { authenticate } = require('../middleware/auth');
const { processImage } = require('../services/imageService');
const { addJob } = require('../../config/redis');
const { get, set, del } = require('../../config/redis');
const { config } = require('../../config/env');

// ============================================
// НАСТРОЙКА ЗАГРУЗКИ ФАЙЛОВ
// ============================================

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const chatDir = path.join(__dirname, '../../uploads/chats');
        if (!fs.existsSync(chatDir)) fs.mkdirSync(chatDir, { recursive: true });
        cb(null, chatDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Неподдерживаемый формат'), false);
        }
    }
});

function validate(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    return null;
}

// ============================================
// GET /api/v1/chats
// Получение списка чатов пользователя
// ============================================
router.get('/', authenticate, async (req, res) => {
    try {
        const chats = await Chat.findByUser(req.user.id);
        
        // Добавляем информацию о непрочитанных
        for (const chat of chats) {
            const unreadKey = `chat:${chat.id}:unread:${req.user.id}`;
            const unreadCount = await get(unreadKey);
            chat.unread_count = parseInt(unreadCount) || 0;
        }
        
        res.json({
            success: true,
            chats,
            count: chats.length
        });
        
    } catch (error) {
        console.error('Ошибка получения чатов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// POST /api/v1/chats
// Создание нового чата
// ============================================
router.post(
    '/',
    authenticate,
    [
        body('listing_id').isInt().withMessage('ID объявления обязателен'),
        body('seller_id').isInt().withMessage('ID продавца обязателен')
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { listing_id, seller_id } = req.body;

        if (req.user.id === parseInt(seller_id)) {
            return res.status(400).json({ error: 'Нельзя создать чат с самим собой' });
        }

        try {
            // Проверяем, не заблокирован ли продавец
            const isBlocked = await Blacklist.isBlocked(seller_id, req.user.id);
            if (isBlocked) {
                return res.status(403).json({ error: 'Вы заблокированы этим пользователем' });
            }
            
            const isBlockedByUser = await Blacklist.isBlocked(req.user.id, seller_id);
            if (isBlockedByUser) {
                return res.status(403).json({ error: 'Вы заблокировали этого пользователя' });
            }
            
            // Проверяем существование объявления
            const listing = await Listing.findById(listing_id);
            if (!listing) {
                return res.status(404).json({ error: 'Объявление не найдено' });
            }
            
            // Создаём чат
            const chat = await Chat.create(listing_id, req.user.id, seller_id);
            
            // Отправляем уведомление продавцу (в фоне)
            await addJob('notificationQueue', 'newChatNotification', {
                userId: seller_id,
                chatId: chat.id,
                buyerName: req.user.name,
                listingTitle: listing.title
            });
            
            res.status(201).json({
                success: true,
                chat
            });
            
        } catch (error) {
            console.error('Ошибка создания чата:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/chats/:id
// Получение информации о чате
// ============================================
router.get(
    '/:id',
    authenticate,
    [
        param('id').isInt()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { id } = req.params;

        try {
            const chat = await Chat.findById(id);
            
            if (!chat) {
                return res.status(404).json({ error: 'Чат не найден' });
            }
            
            // Проверяем, является ли пользователь участником чата
            if (chat.buyer_id !== req.user.id && chat.seller_id !== req.user.id) {
                return res.status(403).json({ error: 'Доступ запрещён' });
            }
            
            // Определяем данные собеседника
            const otherUser = chat.buyer_id === req.user.id 
                ? { id: chat.seller_id, name: chat.seller_name, avatar: chat.seller_avatar }
                : { id: chat.buyer_id, name: chat.buyer_name, avatar: chat.buyer_avatar };
            
            res.json({
                success: true,
                chat: {
                    ...chat,
                    other_user: otherUser
                }
            });
            
        } catch (error) {
            console.error('Ошибка получения чата:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// DELETE /api/v1/chats/:id
// Удаление чата
// ============================================
router.delete(
    '/:id',
    authenticate,
    [
        param('id').isInt()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { id } = req.params;

        try {
            const chat = await Chat.findById(id);
            
            if (!chat) {
                return res.status(404).json({ error: 'Чат не найден' });
            }
            
            if (chat.buyer_id !== req.user.id && chat.seller_id !== req.user.id) {
                return res.status(403).json({ error: 'Доступ запрещён' });
            }
            
            await Chat.deleteForUser(id, req.user.id);
            
            // Очищаем кеш
            await del(`chat:${id}:messages`);
            
            res.json({ success: true, message: 'Чат удалён' });
            
        } catch (error) {
            console.error('Ошибка удаления чата:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/chats/:id/messages
// Получение истории сообщений
// ============================================
router.get(
    '/:id/messages',
    authenticate,
    [
        param('id').isInt(),
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('before').optional().isInt()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { id } = req.params;
        const { limit = 50, before } = req.query;

        try {
            const chat = await Chat.findById(id);
            
            if (!chat) {
                return res.status(404).json({ error: 'Чат не найден' });
            }
            
            if (chat.buyer_id !== req.user.id && chat.seller_id !== req.user.id) {
                return res.status(403).json({ error: 'Доступ запрещён' });
            }
            
            // Получаем сообщения
            const { messages, nextCursor, hasMore } = await Message.findByChat(
                parseInt(id), 
                parseInt(limit), 
                before ? parseInt(before) : null
            );
            
            // Отмечаем сообщения как прочитанные
            const unreadMessages = messages.filter(m => m.sender_id !== req.user.id && !m.is_read);
            if (unreadMessages.length > 0) {
                await Message.markAsRead(id, req.user.id, unreadMessages.map(m => m.id));
                
                // Очищаем кеш непрочитанных
                await del(`chat:${id}:unread:${req.user.id}`);
            }
            
            res.json({
                success: true,
                messages,
                nextCursor,
                hasMore,
                count: messages.length
            });
            
        } catch (error) {
            console.error('Ошибка получения сообщений:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/chats/:id/messages
// Отправка сообщения
// ============================================
router.post(
    '/:id/messages',
    authenticate,
    upload.single('photo'),
    [
        param('id').isInt(),
        body('text').optional().isString().isLength({ max: 2000 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { id } = req.params;
        const { text, reply_to_id } = req.body;
        
        // Проверяем, есть ли хоть что-то
        if (!text && !req.file) {
            return res.status(400).json({ error: 'Введите текст или прикрепите фото' });
        }

        try {
            const chat = await Chat.findById(id);
            
            if (!chat) {
                return res.status(404).json({ error: 'Чат не найден' });
            }
            
            // Проверяем участника
            const otherUserId = chat.buyer_id === req.user.id ? chat.seller_id : chat.buyer_id;
            
            // Проверяем блокировку
            const isBlocked = await Blacklist.isBlocked(otherUserId, req.user.id);
            if (isBlocked) {
                return res.status(403).json({ error: 'Вы заблокированы этим пользователем' });
            }
            
            let photoUrl = null;
            
            // Обрабатываем фото
            if (req.file) {
                const processed = await processImage(req.file.buffer, {
                    width: 1200,
                    quality: 80
                });
                
                const photoFilename = `${Date.now()}-${req.file.filename}.webp`;
                const photoPath = path.join(__dirname, '../../uploads/chats', photoFilename);
                fs.writeFileSync(photoPath, processed.buffer);
                photoUrl = `/uploads/chats/${photoFilename}`;
                
                // Удаляем временный файл
                fs.unlinkSync(req.file.path);
            }
            
            // Сохраняем сообщение
            const message = await Message.create(
                parseInt(id),
                req.user.id,
                text || null,
                photoUrl,
                reply_to_id || null
            );
            
            // Обновляем кеш непрочитанных для получателя
            const unreadKey = `chat:${id}:unread:${otherUserId}`;
            await set(unreadKey, parseInt(await get(unreadKey) || 0) + 1, 86400);
            
            // Отправляем уведомление через WebSocket
            const io = req.app.get('io');
            if (io) {
                io.to(`chat_${id}`).emit('new_message', {
                    ...message,
                    sender: {
                        id: req.user.id,
                        name: req.user.name,
                        avatar: req.user.avatar
                    }
                });
            }
            
            // Отправляем push-уведомление (в фоне)
            await addJob('notificationQueue', 'newMessageNotification', {
                userId: otherUserId,
                chatId: id,
                message: text?.substring(0, 100) || '📷 Фото',
                senderName: req.user.name
            });
            
            res.status(201).json({
                success: true,
                message
            });
            
        } catch (error) {
            console.error('Ошибка отправки сообщения:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// PUT /api/v1/chats/:id/read
// Отметить все сообщения как прочитанные
// ============================================
router.put(
    '/:id/read',
    authenticate,
    [
        param('id').isInt()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { id } = req.params;

        try {
            const chat = await Chat.findById(id);
            
            if (!chat) {
                return res.status(404).json({ error: 'Чат не найден' });
            }
            
            if (chat.buyer_id !== req.user.id && chat.seller_id !== req.user.id) {
                return res.status(403).json({ error: 'Доступ запрещён' });
            }
            
            const count = await Message.markAsRead(parseInt(id), req.user.id);
            
            // Очищаем кеш непрочитанных
            await del(`chat:${id}:unread:${req.user.id}`);
            
            res.json({
                success: true,
                marked_count: count
            });
            
        } catch (error) {
            console.error('Ошибка отметки прочтения:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// DELETE /api/v1/chats/:id/messages/:messageId
// Удаление сообщения
// ============================================
router.delete(
    '/:id/messages/:messageId',
    authenticate,
    [
        param('id').isInt(),
        param('messageId').isInt()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { id, messageId } = req.params;

        try {
            const message = await Message.delete(parseInt(messageId), req.user.id);
            
            if (!message) {
                return res.status(404).json({ error: 'Сообщение не найдено' });
            }
            
            // Удаляем фото если есть
            if (message.photo) {
                const photoPath = path.join(__dirname, '../../uploads/chats', path.basename(message.photo));
                if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
            }
            
            // Уведомляем через WebSocket
            const io = req.app.get('io');
            if (io) {
                io.to(`chat_${id}`).emit('message_deleted', { messageId });
            }
            
            res.json({ success: true, message: 'Сообщение удалено' });
            
        } catch (error) {
            console.error('Ошибка удаления сообщения:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/chats/auto-reply
// Настройка автоответчика
// ============================================
router.post(
    '/auto-reply',
    authenticate,
    [
        body('enabled').isBoolean(),
        body('text').optional().isString().isLength({ max: 500 }),
        body('start_time').optional().matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/),
        body('end_time').optional().matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { enabled, text, start_time, end_time } = req.body;

        try {
            const settings = {
                enabled,
                text: text || 'Здравствуйте! Я сейчас отсутствую, но отвечу вам при первой возможности. Спасибо за понимание!',
                start_time: start_time || '22:00',
                end_time: end_time || '09:00'
            };
            
            await set(`user:autoreply:${req.user.id}`, settings, 86400 * 30);
            
            res.json({
                success: true,
                settings
            });
            
        } catch (error) {
            console.error('Ошибка настройки автоответчика:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/chats/auto-reply
// Получение настроек автоответчика
// ============================================
router.get('/auto-reply', authenticate, async (req, res) => {
    try {
        const settings = await get(`user:autoreply:${req.user.id}`);
        
        res.json({
            success: true,
            settings: settings || {
                enabled: false,
                text: 'Здравствуйте! Я сейчас отсутствую, но отвечу вам при первой возможности.',
                start_time: '22:00',
                end_time: '09:00'
            }
        });
        
    } catch (error) {
        console.error('Ошибка получения настроек:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// POST /api/v1/chats/:id/report
// Пожаловаться на чат/пользователя
// ============================================
router.post(
    '/:id/report',
    authenticate,
    [
        param('id').isInt(),
        body('reason').isString().isLength({ min: 10, max: 500 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { id } = req.params;
        const { reason } = req.body;

        try {
            const chat = await Chat.findById(id);
            
            if (!chat) {
                return res.status(404).json({ error: 'Чат не найден' });
            }
            
            const reportedUserId = chat.buyer_id === req.user.id ? chat.seller_id : chat.buyer_id;
            
            // Сохраняем жалобу
            await require('../models').query(
                `INSERT INTO complaints (user_id, complained_user_id, chat_id, reason, created_at, status)
                 VALUES ($1, $2, $3, $4, NOW(), 'pending')`,
                [req.user.id, reportedUserId, id, reason]
            );
            
            // Проверяем автоблокировку
            await Blacklist.checkAutoBlock(reportedUserId);
            
            // Уведомляем модераторов
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
);

// ============================================
// POST /api/v1/chats/clear-all
// Удалить все чаты пользователя
// ============================================
router.post('/clear-all', authenticate, async (req, res) => {
    try {
        await require('../models').query(
            `UPDATE chats SET deleted_by = $1 WHERE buyer_id = $1 OR seller_id = $1`,
            [req.user.id]
        );
        
        res.json({ success: true, message: 'Все чаты удалены' });
        
    } catch (error) {
        console.error('Ошибка удаления чатов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = router;