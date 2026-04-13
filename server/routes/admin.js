/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/routes/admin.js
 * Описание: Административная панель (пользователи, модерация, статистика, настройки)
 */

const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');

const router = express.Router();
const { User, Listing, Category, Blacklist } = require('../models');
const { authenticate, isAdmin, isAdminOrModerator } = require('../middleware/auth');
const { get, set, del, flushPattern } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { config, isModuleEnabled, updateModuleConfig } = require('../../config/env');
const { sendEmail } = require('../services/emailService');

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

function validate(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    return null;
}

// ============================================
// GET /api/v1/admin/stats
// Получение общей статистики
// ============================================
router.get('/stats', authenticate, isAdmin, async (req, res) => {
    try {
        const cacheKey = 'admin:stats';
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }

        // Пользователи
        const totalUsers = await User.query('SELECT COUNT(*) FROM users');
        const newUsersToday = await User.query(
            "SELECT COUNT(*) FROM users WHERE DATE(created_at) = CURRENT_DATE"
        );
        const activeUsers = await User.query(
            "SELECT COUNT(*) FROM users WHERE last_seen > NOW() - INTERVAL '1 hour'"
        );
        const blockedUsers = await User.query(
            "SELECT COUNT(*) FROM users WHERE status = 'blocked'"
        );

        // Объявления
        const totalListings = await Listing.query('SELECT COUNT(*) FROM listings');
        const newListingsToday = await Listing.query(
            "SELECT COUNT(*) FROM listings WHERE DATE(created_at) = CURRENT_DATE"
        );
        const pendingModeration = await Listing.query(
            "SELECT COUNT(*) FROM listings WHERE status = 'pending'"
        );
        const activeListings = await Listing.query(
            "SELECT COUNT(*) FROM listings WHERE status = 'active'"
        );

        // Чаты и сообщения
        const totalChats = await Listing.query('SELECT COUNT(*) FROM chats');
        const totalMessages = await Listing.query('SELECT COUNT(*) FROM messages');
        const messagesToday = await Listing.query(
            "SELECT COUNT(*) FROM messages WHERE DATE(created_at) = CURRENT_DATE"
        );

        // Жалобы
        const pendingComplaints = await Listing.query(
            "SELECT COUNT(*) FROM complaints WHERE status = 'pending'"
        );

        // Финансы (если включены)
        let revenue = { today: 0, week: 0, month: 0, total: 0 };
        if (config.modules.finance.enabled) {
            const revenueData = await Listing.query(`
                SELECT 
                    SUM(CASE WHEN DATE(created_at) = CURRENT_DATE THEN amount ELSE 0 END) as today,
                    SUM(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN amount ELSE 0 END) as week,
                    SUM(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN amount ELSE 0 END) as month,
                    SUM(amount) as total
                FROM payments WHERE status = 'completed'
            `);
            revenue = revenueData.rows[0];
        }

        const stats = {
            users: {
                total: parseInt(totalUsers.rows[0].count),
                newToday: parseInt(newUsersToday.rows[0].count),
                active: parseInt(activeUsers.rows[0].count),
                blocked: parseInt(blockedUsers.rows[0].count)
            },
            listings: {
                total: parseInt(totalListings.rows[0].count),
                newToday: parseInt(newListingsToday.rows[0].count),
                pending: parseInt(pendingModeration.rows[0].count),
                active: parseInt(activeListings.rows[0].count)
            },
            chats: {
                total: parseInt(totalChats.rows[0].count),
                messages: parseInt(totalMessages.rows[0].count),
                messagesToday: parseInt(messagesToday.rows[0].count)
            },
            complaints: {
                pending: parseInt(pendingComplaints.rows[0].count)
            },
            revenue,
            timestamp: new Date().toISOString()
        };

        await set(cacheKey, stats, 300); // кеш на 5 минут
        res.json({ success: true, ...stats });

    } catch (error) {
        console.error('Ошибка получения статистики:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// GET /api/v1/admin/users
// Список пользователей с фильтрацией
// ============================================
router.get(
    '/users',
    authenticate,
    isAdmin,
    [
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('role').optional().isIn(['user', 'moderator', 'admin']),
        query('status').optional().isIn(['active', 'blocked', 'deleted']),
        query('search').optional().isString().isLength({ max: 100 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { page = 1, limit = 20, role, status, search } = req.query;
        const offset = (page - 1) * limit;

        try {
            let sql = `
                SELECT id, name, email, phone, city, avatar, role, status, 
                       bonus_balance, email_verified, created_at, last_seen,
                       (SELECT COUNT(*) FROM listings WHERE user_id = users.id) as listings_count,
                       (SELECT COUNT(*) FROM complaints WHERE complained_user_id = users.id AND status = 'pending') as complaints_count
                FROM users
                WHERE deleted_at IS NULL
            `;
            const params = [];

            if (role) {
                sql += ` AND role = $${params.length + 1}`;
                params.push(role);
            }
            if (status) {
                sql += ` AND status = $${params.length + 1}`;
                params.push(status);
            }
            if (search) {
                sql += ` AND (name ILIKE $${params.length + 1} OR email ILIKE $${params.length + 1})`;
                params.push(`%${search}%`);
            }

            const countQuery = sql.replace(
                /SELECT.*FROM users/,
                'SELECT COUNT(*) FROM users'
            ).replace(/ORDER BY.*$/, '');
            
            const countResult = await User.query(countQuery, params);
            const total = parseInt(countResult.rows[0].count);

            sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
            params.push(limit, offset);

            const result = await User.query(sql, params);

            res.json({
                success: true,
                users: result.rows,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / limit)
                }
            });

        } catch (error) {
            console.error('Ошибка получения пользователей:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// PUT /api/v1/admin/users/:id/role
// Изменение роли пользователя
// ============================================
router.put(
    '/users/:id/role',
    authenticate,
    isAdmin,
    [
        param('id').isInt(),
        body('role').isIn(['user', 'moderator', 'admin'])
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { id } = req.params;
        const { role } = req.body;

        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ error: 'Нельзя изменить свою роль' });
        }

        try {
            const user = await User.update(id, { role });
            if (!user) {
                return res.status(404).json({ error: 'Пользователь не найден' });
            }

            await del(`user:${id}`);
            await addJob('notificationQueue', 'roleChangedNotification', {
                userId: id,
                newRole: role
            });

            res.json({ success: true, user });

        } catch (error) {
            console.error('Ошибка изменения роли:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/admin/users/:id/block
// Блокировка пользователя
// ============================================
router.post(
    '/users/:id/block',
    authenticate,
    isAdmin,
    [
        param('id').isInt(),
        body('reason').isString().isLength({ min: 5, max: 500 }),
        body('duration').isIn(['24h', '7d', 'permanent'])
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { id } = req.params;
        const { reason, duration } = req.body;

        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ error: 'Нельзя заблокировать себя' });
        }

        try {
            let hours = null;
            if (duration === '24h') hours = 24;
            if (duration === '7d') hours = 168;

            const user = await User.block(parseInt(id), reason, hours);
            if (!user) {
                return res.status(404).json({ error: 'Пользователь не найден' });
            }

            // Отправляем уведомление
            await addJob('emailQueue', 'sendAccountBlockedEmail', {
                userId: id,
                reason,
                duration
            });

            // Очищаем все сессии пользователя
            await flushPattern(`session:*`);
            await del(`user:${id}`);

            res.json({ success: true, user });

        } catch (error) {
            console.error('Ошибка блокировки:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// DELETE /api/v1/admin/users/:id/block
// Разблокировка пользователя
// ============================================
router.delete(
    '/users/:id/block',
    authenticate,
    isAdmin,
    [
        param('id').isInt()
    ],
    async (req, res) => {
        const { id } = req.params;

        try {
            const user = await User.unblock(parseInt(id));
            if (!user) {
                return res.status(404).json({ error: 'Пользователь не найден' });
            }

            await del(`user:${id}`);
            res.json({ success: true, user });

        } catch (error) {
            console.error('Ошибка разблокировки:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/admin/listings/moderation
// Объявления на модерации
// ============================================
router.get(
    '/listings/moderation',
    authenticate,
    isAdminOrModerator,
    [
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 50 })
    ],
    async (req, res) => {
        const { page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;

        try {
            const result = await Listing.query(
                `SELECT l.*, u.name as user_name, u.email as user_email, u.phone as user_phone,
                        (SELECT COUNT(*) FROM listing_photos WHERE listing_id = l.id) as photos_count
                 FROM listings l
                 JOIN users u ON u.id = l.user_id
                 WHERE l.status = 'pending'
                 ORDER BY l.created_at ASC
                 LIMIT $1 OFFSET $2`,
                [parseInt(limit), offset]
            );

            const countResult = await Listing.query(
                `SELECT COUNT(*) FROM listings WHERE status = 'pending'`
            );
            const total = parseInt(countResult.rows[0].count);

            res.json({
                success: true,
                listings: result.rows,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / limit)
                }
            });

        } catch (error) {
            console.error('Ошибка получения объявлений на модерацию:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/admin/listings/:id/approve
// Одобрение объявления
// ============================================
router.post(
    '/listings/:id/approve',
    authenticate,
    isAdminOrModerator,
    [
        param('id').isInt(),
        body('comment').optional().isString().isLength({ max: 500 })
    ],
    async (req, res) => {
        const { id } = req.params;
        const { comment } = req.body;

        try {
            const listing = await Listing.updateStatus(parseInt(id), 'active');
            if (!listing) {
                return res.status(404).json({ error: 'Объявление не найдено' });
            }

            // Уведомляем пользователя
            await addJob('emailQueue', 'sendListingApprovedEmail', {
                userId: listing.user_id,
                listingId: id,
                listingTitle: listing.title,
                comment
            });

            // Начисляем бонус за публикацию
            await User.addBonus(listing.user_id, 10, 'listing_approved', id);

            res.json({ success: true, listing });

        } catch (error) {
            console.error('Ошибка одобрения:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/admin/listings/:id/reject
// Отклонение объявления
// ============================================
router.post(
    '/listings/:id/reject',
    authenticate,
    isAdminOrModerator,
    [
        param('id').isInt(),
        body('reason').isString().isLength({ min: 10, max: 1000 })
    ],
    async (req, res) => {
        const { id } = req.params;
        const { reason } = req.body;

        try {
            const listing = await Listing.updateStatus(parseInt(id), 'rejected');
            if (!listing) {
                return res.status(404).json({ error: 'Объявление не найдено' });
            }

            // Сохраняем причину отклонения
            await Listing.query(
                `UPDATE listings SET rejection_reason = $1, rejected_at = NOW() WHERE id = $2`,
                [reason, id]
            );

            // Уведомляем пользователя
            await addJob('emailQueue', 'sendListingRejectedEmail', {
                userId: listing.user_id,
                listingId: id,
                listingTitle: listing.title,
                reason
            });

            res.json({ success: true, listing });

        } catch (error) {
            console.error('Ошибка отклонения:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// Конец ЧАСТИ 1/2. Напишите "ЧАСТЬ 2" для продолжения админ-панели (жалобы, настройки, экспорт)
// ============================================
// GET /api/v1/admin/complaints
// Список жалоб
// ============================================
router.get(
    '/complaints',
    authenticate,
    isAdminOrModerator,
    [
        query('status').optional().isIn(['pending', 'resolved', 'ignored']),
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 50 })
    ],
    async (req, res) => {
        const { status = 'pending', page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;

        try {
            let sql = `
                SELECT c.*, 
                       u.name as user_name, u.email as user_email,
                       l.title as listing_title, l.id as listing_id,
                       cu.name as complained_user_name, cu.email as complained_user_email
                FROM complaints c
                LEFT JOIN users u ON u.id = c.user_id
                LEFT JOIN listings l ON l.id = c.listing_id
                LEFT JOIN users cu ON cu.id = c.complained_user_id
                WHERE 1=1
            `;
            const params = [];

            if (status) {
                sql += ` AND c.status = $${params.length + 1}`;
                params.push(status);
            }

            const countSql = sql.replace(/SELECT.*FROM/, 'SELECT COUNT(*) FROM');
            const countResult = await Listing.query(countSql, params);
            const total = parseInt(countResult.rows[0].count);

            sql += ` ORDER BY c.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
            params.push(parseInt(limit), offset);

            const result = await Listing.query(sql, params);

            res.json({
                success: true,
                complaints: result.rows,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / limit)
                }
            });

        } catch (error) {
            console.error('Ошибка получения жалоб:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/admin/complaints/:id/resolve
// Решение жалобы
// ============================================
router.post(
    '/complaints/:id/resolve',
    authenticate,
    isAdminOrModerator,
    [
        param('id').isInt(),
        body('action').isIn(['ignore', 'warn', 'delete_listing', 'block_user']),
        body('comment').optional().isString().isLength({ max: 500 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { id } = req.params;
        const { action, comment } = req.body;

        try {
            // Получаем жалобу
            const complaint = await Listing.query(
                `SELECT * FROM complaints WHERE id = $1`,
                [id]
            );
            if (complaint.rows.length === 0) {
                return res.status(404).json({ error: 'Жалоба не найдена' });
            }

            const complaintData = complaint.rows[0];

            // Выполняем действие
            if (action === 'delete_listing' && complaintData.listing_id) {
                await Listing.softDelete(complaintData.listing_id);
                await addJob('emailQueue', 'sendListingDeletedEmail', {
                    userId: complaintData.complained_user_id,
                    listingId: complaintData.listing_id,
                    reason: comment || 'Нарушение правил'
                });
            } else if (action === 'block_user' && complaintData.complained_user_id) {
                await User.block(complaintData.complained_user_id, comment || 'Нарушение правил', 168);
            } else if (action === 'warn' && complaintData.complained_user_id) {
                await addJob('emailQueue', 'sendWarningEmail', {
                    userId: complaintData.complained_user_id,
                    reason: comment || 'Нарушение правил'
                });
            }

            // Обновляем статус жалобы
            await Listing.query(
                `UPDATE complaints SET status = 'resolved', resolved_by = $1, resolved_at = NOW(), 
                 resolution_action = $2, resolution_comment = $3
                 WHERE id = $4`,
                [req.user.id, action, comment || null, id]
            );

            res.json({ success: true, message: 'Жалоба обработана' });

        } catch (error) {
            console.error('Ошибка обработки жалобы:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/admin/settings
// Получение настроек системы
// ============================================
router.get('/settings', authenticate, isAdmin, async (req, res) => {
    try {
        const settings = await get('admin:settings');
        
        const defaultSettings = {
            site_name: 'АЙДА',
            site_description: 'Премиальная доска объявлений',
            contact_email: 'support@aida.ru',
            contact_phone: '+7 (800) 123-45-67',
            modules: {
                finance: { enabled: config.modules.finance.enabled, testMode: config.modules.finance.testMode },
                delivery: { enabled: config.modules.delivery.enabled, virtualMode: config.modules.delivery.virtualMode },
                bonuses: { enabled: config.modules.bonuses.enabled, dailyAmount: config.modules.bonuses.dailyAmount },
                lottery: { enabled: config.modules.lottery.enabled, ticketPrice: config.modules.lottery.ticketPrice },
                auction: { enabled: config.modules.auction.enabled },
                tiktok: { enabled: config.modules.tiktok.enabled }
            },
            moderation: {
                auto_approve: false,
                max_photos: 10,
                max_video_size_mb: 100,
                nsfw_detection: false
            },
            security: {
                rate_limit_requests: 100,
                rate_limit_window_minutes: 15,
                max_login_attempts: 5,
                block_duration_minutes: 15
            },
            maintenance_mode: false,
            maintenance_message: 'Сайт на техническом обслуживании. Скоро вернёмся!'
        };

        const currentSettings = settings || defaultSettings;
        res.json({ success: true, settings: currentSettings });

    } catch (error) {
        console.error('Ошибка получения настроек:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// PUT /api/v1/admin/settings
// Обновление настроек системы
// ============================================
router.put('/settings', authenticate, isAdmin, async (req, res) => {
    const { settings } = req.body;

    try {
        await set('admin:settings', settings, 86400 * 30);
        
        // Применяем некоторые настройки сразу
        if (settings.maintenance_mode) {
            await set('system:maintenance', {
                enabled: true,
                message: settings.maintenance_message
            }, 3600);
        } else {
            await del('system:maintenance');
        }

        res.json({ success: true, message: 'Настройки сохранены' });

    } catch (error) {
        console.error('Ошибка сохранения настроек:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// GET /api/v1/admin/operators
// Список операторов поддержки
// ============================================
router.get('/operators', authenticate, isAdmin, async (req, res) => {
    try {
        const result = await Listing.query(
            `SELECT * FROM support_operators ORDER BY created_at DESC`
        );
        res.json({ success: true, operators: result.rows });
    } catch (error) {
        console.error('Ошибка получения операторов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// POST /api/v1/admin/operators
// Добавление оператора
// ============================================
router.post(
    '/operators',
    authenticate,
    isAdmin,
    [
        body('telegram_id').isString().notEmpty(),
        body('name').isString().isLength({ min: 2, max: 100 }),
        body('role').isIn(['operator', 'senior_operator', 'supervisor'])
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { telegram_id, name, role } = req.body;

        try {
            const result = await Listing.query(
                `INSERT INTO support_operators (telegram_id, name, role, is_active, created_at)
                 VALUES ($1, $2, $3, true, NOW())
                 RETURNING *`,
                [telegram_id, name, role]
            );
            res.status(201).json({ success: true, operator: result.rows[0] });
        } catch (error) {
            console.error('Ошибка добавления оператора:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// DELETE /api/v1/admin/operators/:id
// Удаление оператора
// ============================================
router.delete(
    '/operators/:id',
    authenticate,
    isAdmin,
    [
        param('id').isInt()
    ],
    async (req, res) => {
        const { id } = req.params;

        try {
            await Listing.query(`DELETE FROM support_operators WHERE id = $1`, [id]);
            res.json({ success: true });
        } catch (error) {
            console.error('Ошибка удаления оператора:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/admin/logs
// Логи ошибок
// ============================================
router.get(
    '/logs',
    authenticate,
    isAdmin,
    [
        query('level').optional().isIn(['error', 'warning', 'info']),
        query('limit').optional().isInt({ min: 1, max: 500 }),
        query('page').optional().isInt({ min: 1 })
    ],
    async (req, res) => {
        const { level, limit = 100, page = 1 } = req.query;
        const offset = (page - 1) * limit;

        try {
            let sql = `SELECT * FROM error_logs WHERE 1=1`;
            const params = [];

            if (level) {
                sql += ` AND level = $${params.length + 1}`;
                params.push(level);
            }

            const countResult = await Listing.query(
                sql.replace('SELECT *', 'SELECT COUNT(*)'),
                params
            );
            const total = parseInt(countResult.rows[0].count);

            sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
            params.push(parseInt(limit), offset);

            const result = await Listing.query(sql, params);

            res.json({
                success: true,
                logs: result.rows,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / limit)
                }
            });

        } catch (error) {
            console.error('Ошибка получения логов:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/admin/export
// Экспорт данных
// ============================================
router.post(
    '/export',
    authenticate,
    isAdmin,
    [
        body('type').isIn(['users', 'listings', 'payments', 'logs']),
        body('format').isIn(['csv', 'json', 'xlsx']),
        body('date_from').optional().isISO8601(),
        body('date_to').optional().isISO8601()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { type, format, date_from, date_to } = req.body;

        try {
            // Создаём задачу на экспорт в фоне
            const jobId = `export_${type}_${Date.now()}`;
            
            await addJob('exportQueue', 'exportData', {
                jobId,
                type,
                format,
                date_from,
                date_to,
                requestedBy: req.user.id
            });

            res.json({
                success: true,
                message: 'Экспорт запущен. Ссылка будет отправлена на email.',
                jobId
            });

        } catch (error) {
            console.error('Ошибка экспорта:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/admin/promotions
// Настройка платных услуг (цены)
// ============================================
router.get('/promotions', authenticate, isAdmin, async (req, res) => {
    try {
        const promotions = await get('admin:promotions');
        
        const defaultPromotions = {
            listing_promotion: {
                bump: { price: 500, duration_days: 7, enabled: true },
                vip: { price: 1000, duration_days: 30, enabled: true },
                highlight: { price: 300, duration_days: 7, enabled: true }
            },
            subscriptions: {
                premium_month: { price: 5000, enabled: true },
                premium_year: { price: 50000, enabled: true },
                business_month: { price: 15000, enabled: false }
            },
            commissions: {
                platform_percent: 3.5,
                delivery_percent: 5,
                escrow_percent: 1
            }
        };

        res.json({
            success: true,
            promotions: promotions || defaultPromotions
        });

    } catch (error) {
        console.error('Ошибка получения настроек платных услуг:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// PUT /api/v1/admin/promotions
// Сохранение настроек платных услуг
// ============================================
router.put('/promotions', authenticate, isAdmin, async (req, res) => {
    const { promotions } = req.body;

    try {
        await set('admin:promotions', promotions, 86400 * 30);
        res.json({ success: true, message: 'Настройки сохранены' });
    } catch (error) {
        console.error('Ошибка сохранения настроек платных услуг:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// POST /api/v1/admin/clear-cache
// Очистка кеша
// ============================================
router.post('/clear-cache', authenticate, isAdmin, async (req, res) => {
    try {
        await flushPattern('*');
        res.json({ success: true, message: 'Кеш очищен' });
    } catch (error) {
        console.error('Ошибка очистки кеша:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// POST /api/v1/admin/maintenance
// Включение/выключение режима обслуживания
// ============================================
router.post(
    '/maintenance',
    authenticate,
    isAdmin,
    [
        body('enabled').isBoolean(),
        body('message').optional().isString().isLength({ max: 500 })
    ],
    async (req, res) => {
        const { enabled, message } = req.body;

        try {
            if (enabled) {
                await set('system:maintenance', {
                    enabled: true,
                    message: message || 'Сайт на техническом обслуживании. Скоро вернёмся!',
                    started_by: req.user.id,
                    started_at: new Date().toISOString()
                }, 3600);
            } else {
                await del('system:maintenance');
            }

            res.json({ success: true, maintenance_mode: enabled });
        } catch (error) {
            console.error('Ошибка переключения режима обслуживания:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/admin/dashboard/charts
// Данные для графиков на дашборде
// ============================================
router.get(
    '/dashboard/charts',
    authenticate,
    isAdmin,
    [
        query('period').optional().isIn(['week', 'month', 'year'])
    ],
    async (req, res) => {
        const { period = 'week' } = req.query;

        try {
            let interval;
            let format;
            
            switch (period) {
                case 'week':
                    interval = "INTERVAL '7 days'";
                    format = "TO_CHAR(created_at, 'YYYY-MM-DD')";
                    break;
                case 'month':
                    interval = "INTERVAL '30 days'";
                    format = "TO_CHAR(created_at, 'YYYY-MM-DD')";
                    break;
                case 'year':
                    interval = "INTERVAL '12 months'";
                    format = "TO_CHAR(created_at, 'YYYY-MM')";
                    break;
                default:
                    interval = "INTERVAL '7 days'";
                    format = "TO_CHAR(created_at, 'YYYY-MM-DD')";
            }

            // Регистрации пользователей
            const usersChart = await Listing.query(`
                SELECT ${format} as date, COUNT(*) as count
                FROM users
                WHERE created_at > NOW() - ${interval}
                GROUP BY date
                ORDER BY date
            `);

            // Новые объявления
            const listingsChart = await Listing.query(`
                SELECT ${format} as date, COUNT(*) as count
                FROM listings
                WHERE created_at > NOW() - ${interval}
                GROUP BY date
                ORDER BY date
            `);

            // Просмотры
            const viewsChart = await Listing.query(`
                SELECT ${format} as date, SUM(views) as total
                FROM listings
                WHERE created_at > NOW() - ${interval}
                GROUP BY date
                ORDER BY date
            `);

            res.json({
                success: true,
                period,
                charts: {
                    users: usersChart.rows,
                    listings: listingsChart.rows,
                    views: viewsChart.rows
                }
            });

        } catch (error) {
            console.error('Ошибка получения данных для графиков:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = router;