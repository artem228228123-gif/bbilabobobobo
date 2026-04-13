/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/controllers/adminController.js
 * Описание: Контроллер административной панели (статистика, пользователи, модерация, настройки)
 */

const { User, Listing, Category, Review, Complaint } = require('../models');
const { get, set, del, incr, flushPattern } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { sendNotification } = require('../services/notificationService');
const { config } = require('../../config/env');

// ============================================
// КОНСТАНТЫ
// ============================================

const CACHE_TTL = {
    stats: 300,          // 5 минут
    adminStats: 300,     // 5 минут
    charts: 3600         // 1 час
};

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

async function checkAdminAccess(req, res) {
    if (req.user?.role !== 'admin' && req.user?.role !== 'moderator') {
        res.status(403).json({ error: 'Доступ запрещён. Требуются права администратора.' });
        return false;
    }
    return true;
}

async function checkSuperAdminAccess(req, res) {
    if (req.user?.role !== 'admin') {
        res.status(403).json({ error: 'Доступ запрещён. Требуются права суперадминистратора.' });
        return false;
    }
    return true;
}

// ============================================
= СТАТИСТИКА
// ============================================

async function getDashboardStats(req, res) {
    if (!await checkAdminAccess(req, res)) return;
    
    try {
        const cacheKey = 'admin:dashboard:stats';
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }
        
        // Пользователи
        const totalUsers = await User.query(`SELECT COUNT(*) FROM users WHERE deleted_at IS NULL`);
        const newUsersToday = await User.query(`SELECT COUNT(*) FROM users WHERE DATE(created_at) = CURRENT_DATE`);
        const activeUsers = await User.query(`SELECT COUNT(*) FROM users WHERE last_seen > NOW() - INTERVAL '1 hour'`);
        const blockedUsers = await User.query(`SELECT COUNT(*) FROM users WHERE status = 'blocked'`);
        
        // Объявления
        const totalListings = await Listing.query(`SELECT COUNT(*) FROM listings WHERE deleted_at IS NULL`);
        const newListingsToday = await Listing.query(`SELECT COUNT(*) FROM listings WHERE DATE(created_at) = CURRENT_DATE`);
        const pendingModeration = await Listing.query(`SELECT COUNT(*) FROM listings WHERE status = 'pending'`);
        const activeListings = await Listing.query(`SELECT COUNT(*) FROM listings WHERE status = 'active'`);
        const soldListings = await Listing.query(`SELECT COUNT(*) FROM listings WHERE status = 'sold'`);
        
        // Чаты и сообщения
        const totalChats = await Listing.query(`SELECT COUNT(*) FROM chats`);
        const totalMessages = await Listing.query(`SELECT COUNT(*) FROM messages`);
        const messagesToday = await Listing.query(`SELECT COUNT(*) FROM messages WHERE DATE(created_at) = CURRENT_DATE`);
        
        // Отзывы
        const totalReviews = await Review.query(`SELECT COUNT(*) FROM reviews`);
        const avgRating = await Review.query(`SELECT AVG(rating)::numeric(10,2) as avg FROM reviews`);
        
        // Жалобы
        const pendingComplaints = await Complaint.query(`SELECT COUNT(*) FROM complaints WHERE status = 'pending'`);
        
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
                active: parseInt(activeListings.rows[0].count),
                sold: parseInt(soldListings.rows[0].count)
            },
            chats: {
                total: parseInt(totalChats.rows[0].count),
                messages: parseInt(totalMessages.rows[0].count),
                messagesToday: parseInt(messagesToday.rows[0].count)
            },
            reviews: {
                total: parseInt(totalReviews.rows[0].count),
                averageRating: parseFloat(avgRating.rows[0].avg || 0)
            },
            complaints: {
                pending: parseInt(pendingComplaints.rows[0].count)
            },
            revenue,
            timestamp: new Date().toISOString()
        };
        
        await set(cacheKey, stats, CACHE_TTL.stats);
        res.json({ success: true, ...stats });
    } catch (error) {
        console.error('Ошибка получения статистики:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= ГРАФИКИ ДЛЯ ДАШБОРДА
// ============================================

async function getDashboardCharts(req, res) {
    if (!await checkAdminAccess(req, res)) return;
    
    const { period = 'week' } = req.query;
    
    try {
        const cacheKey = `admin:charts:${period}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }
        
        let interval, dateFormat;
        switch (period) {
            case 'week':
                interval = "INTERVAL '7 days'";
                dateFormat = "TO_CHAR(created_at, 'YYYY-MM-DD')";
                break;
            case 'month':
                interval = "INTERVAL '30 days'";
                dateFormat = "TO_CHAR(created_at, 'YYYY-MM-DD')";
                break;
            case 'year':
                interval = "INTERVAL '12 months'";
                dateFormat = "TO_CHAR(created_at, 'YYYY-MM')";
                break;
            default:
                interval = "INTERVAL '7 days'";
                dateFormat = "TO_CHAR(created_at, 'YYYY-MM-DD')";
        }
        
        // Регистрации пользователей
        const usersChart = await User.query(`
            SELECT ${dateFormat} as date, COUNT(*) as count
            FROM users
            WHERE created_at > NOW() - ${interval}
            GROUP BY date
            ORDER BY date
        `);
        
        // Новые объявления
        const listingsChart = await Listing.query(`
            SELECT ${dateFormat} as date, COUNT(*) as count
            FROM listings
            WHERE created_at > NOW() - ${interval}
            GROUP BY date
            ORDER BY date
        `);
        
        // Просмотры
        const viewsChart = await Listing.query(`
            SELECT ${dateFormat} as date, SUM(views) as total
            FROM listings
            WHERE created_at > NOW() - ${interval}
            GROUP BY date
            ORDER BY date
        `);
        
        // Доходы
        let revenueChart = [];
        if (config.modules.finance.enabled) {
            revenueChart = await Listing.query(`
                SELECT ${dateFormat} as date, SUM(amount) as total
                FROM payments
                WHERE status = 'completed' AND created_at > NOW() - ${interval}
                GROUP BY date
                ORDER BY date
            `);
        }
        
        const response = {
            period,
            charts: {
                users: usersChart.rows,
                listings: listingsChart.rows,
                views: viewsChart.rows,
                revenue: revenueChart
            }
        };
        
        await set(cacheKey, response, CACHE_TTL.charts);
        res.json({ success: true, ...response });
    } catch (error) {
        console.error('Ошибка получения данных для графиков:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯМИ
// ============================================

async function getUsers(req, res) {
    if (!await checkAdminAccess(req, res)) return;
    
    const { page = 1, limit = 20, role, status, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    try {
        let sql = `
            SELECT id, name, email, phone, city, avatar, role, status, 
                   bonus_balance, email_verified, created_at, last_seen,
                   (SELECT COUNT(*) FROM listings WHERE user_id = users.id AND deleted_at IS NULL) as listings_count,
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
        
        const countSql = sql.replace(/SELECT.*FROM/, 'SELECT COUNT(*) FROM');
        const countResult = await User.query(countSql, params);
        const total = parseInt(countResult.rows[0].count);
        
        sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(parseInt(limit), offset);
        
        const result = await User.query(sql, params);
        
        res.json({
            success: true,
            users: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('Ошибка получения пользователей:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function updateUserRole(req, res) {
    if (!await checkSuperAdminAccess(req, res)) return;
    
    const { id } = req.params;
    const { role } = req.body;
    
    if (parseInt(id) === req.user.id) {
        return res.status(400).json({ error: 'Нельзя изменить свою роль' });
    }
    
    try {
        const user = await User.update(parseInt(id), { role });
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

async function blockUser(req, res) {
    if (!await checkAdminAccess(req, res)) return;
    
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
        
        await addJob('emailQueue', 'sendAccountBlockedEmail', {
            userId: id,
            reason,
            duration
        });
        
        await flushPattern(`session:*`);
        await del(`user:${id}`);
        
        res.json({ success: true, user });
    } catch (error) {
        console.error('Ошибка блокировки:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function unblockUser(req, res) {
    if (!await checkAdminAccess(req, res)) return;
    
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

// ============================================
= МОДЕРАЦИЯ ОБЪЯВЛЕНИЙ
// ============================================

async function getPendingListings(req, res) {
    if (!await checkAdminAccess(req, res)) return;
    
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    try {
        const result = await Listing.query(`
            SELECT l.*, u.name as user_name, u.email as user_email, u.phone as user_phone,
                   (SELECT COUNT(*) FROM listing_photos WHERE listing_id = l.id) as photos_count
            FROM listings l
            JOIN users u ON u.id = l.user_id
            WHERE l.status = 'pending'
            ORDER BY l.created_at ASC
            LIMIT $1 OFFSET $2
        `, [parseInt(limit), offset]);
        
        const countResult = await Listing.query(`SELECT COUNT(*) FROM listings WHERE status = 'pending'`);
        const total = parseInt(countResult.rows[0].count);
        
        res.json({
            success: true,
            listings: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('Ошибка получения объявлений на модерацию:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function approveListing(req, res) {
    if (!await checkAdminAccess(req, res)) return;
    
    const { id } = req.params;
    const { comment } = req.body;
    
    try {
        const listing = await Listing.updateStatus(parseInt(id), 'active');
        if (!listing) {
            return res.status(404).json({ error: 'Объявление не найдено' });
        }
        
        await addJob('emailQueue', 'sendListingApprovedEmail', {
            userId: listing.user_id,
            listingId: id,
            listingTitle: listing.title,
            comment
        });
        
        await User.addBonus(listing.user_id, 10, 'listing_approved', id);
        
        res.json({ success: true, listing });
    } catch (error) {
        console.error('Ошибка одобрения:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function rejectListing(req, res) {
    if (!await checkAdminAccess(req, res)) return;
    
    const { id } = req.params;
    const { reason } = req.body;
    
    try {
        const listing = await Listing.updateStatus(parseInt(id), 'rejected');
        if (!listing) {
            return res.status(404).json({ error: 'Объявление не найдено' });
        }
        
        await Listing.query(`UPDATE listings SET rejection_reason = $1, rejected_at = NOW() WHERE id = $2`, [reason, id]);
        
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

// ============================================
= ЖАЛОБЫ
// ============================================

async function getComplaints(req, res) {
    if (!await checkAdminAccess(req, res)) return;
    
    const { status = 'pending', page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
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
        const countResult = await Complaint.query(countSql, params);
        const total = parseInt(countResult.rows[0].count);
        
        sql += ` ORDER BY c.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(parseInt(limit), offset);
        
        const result = await Complaint.query(sql, params);
        
        res.json({
            success: true,
            complaints: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('Ошибка получения жалоб:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function resolveComplaint(req, res) {
    if (!await checkAdminAccess(req, res)) return;
    
    const { id } = req.params;
    const { action, comment } = req.body;
    
    try {
        const complaint = await Complaint.query(`SELECT * FROM complaints WHERE id = $1`, [id]);
        if (complaint.rows.length === 0) {
            return res.status(404).json({ error: 'Жалоба не найдена' });
        }
        
        const complaintData = complaint.rows[0];
        
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
        
        await Complaint.query(`
            UPDATE complaints SET status = 'resolved', resolved_by = $1, resolved_at = NOW(), 
            resolution_action = $2, resolution_comment = $3 WHERE id = $4
        `, [req.user.id, action, comment || null, id]);
        
        res.json({ success: true, message: 'Жалоба обработана' });
    } catch (error) {
        console.error('Ошибка обработки жалобы:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= СИСТЕМНЫЕ НАСТРОЙКИ
// ============================================

async function getSystemSettings(req, res) {
    if (!await checkSuperAdminAccess(req, res)) return;
    
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
        
        res.json({ success: true, settings: settings || defaultSettings });
    } catch (error) {
        console.error('Ошибка получения настроек:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function updateSystemSettings(req, res) {
    if (!await checkSuperAdminAccess(req, res)) return;
    
    const { settings } = req.body;
    
    try {
        await set('admin:settings', settings, 86400 * 30);
        
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
}

// ============================================
= ЛОГИ ОШИБОК
// ============================================

async function getErrorLogs(req, res) {
    if (!await checkAdminAccess(req, res)) return;
    
    const { level, limit = 100, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    try {
        let sql = `SELECT * FROM error_logs WHERE 1=1`;
        const params = [];
        
        if (level) {
            sql += ` AND level = $${params.length + 1}`;
            params.push(level);
        }
        
        const countResult = await Complaint.query(sql.replace('SELECT *', 'SELECT COUNT(*)'), params);
        const total = parseInt(countResult.rows[0].count);
        
        sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(parseInt(limit), offset);
        
        const result = await Complaint.query(sql, params);
        
        res.json({
            success: true,
            logs: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('Ошибка получения логов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= ОЧИСТКА КЕША
// ============================================

async function clearCache(req, res) {
    if (!await checkSuperAdminAccess(req, res)) return;
    
    try {
        await flushPattern('admin:*');
        await flushPattern('categories:*');
        await flushPattern('search:*');
        await flushPattern('analytics:*');
        
        res.json({ success: true, message: 'Кеш очищен' });
    } catch (error) {
        console.error('Ошибка очистки кеша:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= РЕЖИМ ОБСЛУЖИВАНИЯ
// ============================================

async function toggleMaintenanceMode(req, res) {
    if (!await checkSuperAdminAccess(req, res)) return;
    
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

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    getDashboardStats,
    getDashboardCharts,
    getUsers,
    updateUserRole,
    blockUser,
    unblockUser,
    getPendingListings,
    approveListing,
    rejectListing,
    getComplaints,
    resolveComplaint,
    getSystemSettings,
    updateSystemSettings,
    getErrorLogs,
    clearCache,
    toggleMaintenanceMode
};