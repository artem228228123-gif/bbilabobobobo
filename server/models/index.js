/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/models/index.js
 * Описание: Все модели данных (пользователи, объявления, чаты, отзывы, бонусы, аукцион, гараж, резюме)
 */

const { query, transaction } = require('../../config/database');
const { redis, get, set, del } = require('../../config/redis');

// ============================================
// МОДЕЛЬ ПОЛЬЗОВАТЕЛЯ (User)
// ============================================

const User = {
    // Создание пользователя
    async create(userData) {
        const { name, email, passwordHash, phone, city, referralCode } = userData;
        
        const result = await query(
            `INSERT INTO users (name, email, password_hash, phone, city, referral_code, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             RETURNING id, name, email, phone, city, avatar, role, bonus_balance, referral_code, created_at`,
            [name, email, passwordHash, phone || null, city || null, referralCode || null]
        );
        
        return result.rows[0];
    },
    
    // Поиск по email
    async findByEmail(email) {
        const result = await query(
            `SELECT id, name, email, password_hash, phone, city, avatar, role, status, 
                    bonus_balance, referral_code, referred_by, email_verified, created_at, last_seen
             FROM users WHERE email = $1`,
            [email]
        );
        return result.rows[0] || null;
    },
    
    // Поиск по ID (с кешем)
    async findById(id) {
        const cacheKey = `user:${id}`;
        const cached = await get(cacheKey);
        if (cached) return cached;
        
        const result = await query(
            `SELECT id, name, email, phone, city, avatar, role, status, bonus_balance, 
                    referral_code, referred_by, email_verified, created_at, last_seen
             FROM users WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        
        const user = result.rows[0] || null;
        if (user) {
            await set(cacheKey, user, 300); // кеш на 5 минут
        }
        return user;
    },
    
    // Обновление пользователя
    async update(id, updates) {
        const fields = [];
        const values = [];
        let idx = 1;
        
        for (const [key, value] of Object.entries(updates)) {
            if (value !== undefined) {
                fields.push(`${key} = $${idx}`);
                values.push(value);
                idx++;
            }
        }
        
        if (fields.length === 0) return null;
        
        values.push(id);
        const result = await query(
            `UPDATE users SET ${fields.join(', ')}, updated_at = NOW()
             WHERE id = $${idx}
             RETURNING id, name, email, phone, city, avatar, role, status, bonus_balance, created_at`,
            values
        );
        
        // Очищаем кеш
        await del(`user:${id}`);
        
        return result.rows[0] || null;
    },
    
    // Обновление последнего визита
    async updateLastSeen(id) {
        await query(`UPDATE users SET last_seen = NOW() WHERE id = $1`, [id]);
        await del(`user:${id}`);
    },
    
    // Инкремент бонусов
    async addBonus(id, amount, type, referenceId = null) {
        return await transaction(async (client) => {
            const result = await client.query(
                `UPDATE users SET bonus_balance = bonus_balance + $1
                 WHERE id = $2
                 RETURNING bonus_balance`,
                [amount, id]
            );
            
            await client.query(
                `INSERT INTO bonus_transactions (user_id, amount, type, reference_id, created_at)
                 VALUES ($1, $2, $3, $4, NOW())`,
                [id, amount, type, referenceId]
            );
            
            await del(`user:${id}`);
            return result.rows[0].bonus_balance;
        });
    },
    
    // Получение статистики пользователя
    async getStats(id) {
        const [listingsCount, reviewsCount, rating, favoritesCount] = await Promise.all([
            query(`SELECT COUNT(*) FROM listings WHERE user_id = $1 AND status != 'deleted'`, [id]),
            query(`SELECT COUNT(*) FROM reviews WHERE to_user_id = $1`, [id]),
            query(`SELECT AVG(rating)::numeric(10,1) FROM reviews WHERE to_user_id = $1`, [id]),
            query(`SELECT COUNT(*) FROM favorites WHERE user_id = $1`, [id]),
        ]);
        
        return {
            listingsCount: parseInt(listingsCount.rows[0].count),
            reviewsCount: parseInt(reviewsCount.rows[0].count),
            rating: rating.rows[0].avg ? parseFloat(rating.rows[0].avg) : 0,
            favoritesCount: parseInt(favoritesCount.rows[0].count),
        };
    },
    
    // Блокировка пользователя
    async block(id, reason, durationHours = null) {
        const blockedUntil = durationHours ? `NOW() + INTERVAL '${durationHours} hours'` : null;
        
        const result = await query(
            `UPDATE users SET status = 'blocked', block_reason = $1, blocked_until = ${blockedUntil || 'NULL'}
             WHERE id = $2
             RETURNING id, status, block_reason, blocked_until`,
            [reason, id]
        );
        
        await del(`user:${id}`);
        return result.rows[0];
    },
    
    // Разблокировка
    async unblock(id) {
        const result = await query(
            `UPDATE users SET status = 'active', block_reason = NULL, blocked_until = NULL
             WHERE id = $1
             RETURNING id, status`,
            [id]
        );
        
        await del(`user:${id}`);
        return result.rows[0];
    },
    
    // Мягкое удаление
    async softDelete(id) {
        await query(
            `UPDATE users SET deleted_at = NOW(), status = 'deleted', email = CONCAT(email, '.deleted')
             WHERE id = $1`,
            [id]
        );
        
        await del(`user:${id}`);
    },
};

// ============================================
// МОДЕЛЬ ОБЪЯВЛЕНИЯ (Listing)
// ============================================

const Listing = {
    // Создание объявления
    async create(data) {
        const {
            userId, categoryId, title, description, price, city, latitude, longitude,
            type = 'regular', startPrice = null, minStep = null, endsAt = null
        } = data;
        
        const result = await query(
            `INSERT INTO listings (user_id, category_id, title, description, price, city, latitude, longitude,
                                   type, start_price, min_step, ends_at, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', NOW())
             RETURNING *`,
            [userId, categoryId, title, description, price, city, latitude || null, longitude || null,
             type, startPrice || null, minStep || null, endsAt || null]
        );
        
        return result.rows[0];
    },
    
    // Получение объявления по ID (с кешем)
    async findById(id, incrementView = false) {
        const cacheKey = `listing:${id}`;
        
        if (!incrementView) {
            const cached = await get(cacheKey);
            if (cached) return cached;
        }
        
        const result = await query(
            `SELECT l.*, u.name as seller_name, u.avatar as seller_avatar, u.rating as seller_rating,
                    COALESCE((
                        SELECT json_agg(json_build_object('url', url, 'order', order_index))
                        FROM listing_photos WHERE listing_id = l.id
                    ), '[]') as photos
             FROM listings l
             LEFT JOIN users u ON l.user_id = u.id
             WHERE l.id = $1 AND l.status != 'deleted'`,
            [id]
        );
        
        const listing = result.rows[0] || null;
        
        if (listing && !incrementView) {
            await set(cacheKey, listing, 300);
        }
        
        return listing;
    },
    
    // Инкремент просмотров
    async incrementViews(id) {
        await query(`UPDATE listings SET views = views + 1 WHERE id = $1`, [id]);
        await del(`listing:${id}`);
    },
    
    // Инкремент лайков
    async incrementLikes(id) {
        const result = await query(
            `UPDATE listings SET likes = likes + 1 WHERE id = $1 RETURNING likes`,
            [id]
        );
        await del(`listing:${id}`);
        return result.rows[0]?.likes || 0;
    },
    
    // Декремент лайков
    async decrementLikes(id) {
        const result = await query(
            `UPDATE listings SET likes = likes - 1 WHERE id = $1 AND likes > 0 RETURNING likes`,
            [id]
        );
        await del(`listing:${id}`);
        return result.rows[0]?.likes || 0;
    },
    
    // Обновление объявления
    async update(id, updates) {
        const fields = [];
        const values = [];
        let idx = 1;
        
        for (const [key, value] of Object.entries(updates)) {
            if (value !== undefined) {
                fields.push(`${key} = $${idx}`);
                values.push(value);
                idx++;
            }
        }
        
        if (fields.length === 0) return null;
        
        values.push(id);
        const result = await query(
            `UPDATE listings SET ${fields.join(', ')}, updated_at = NOW()
             WHERE id = $${idx}
             RETURNING *`,
            values
        );
        
        await del(`listing:${id}`);
        return result.rows[0] || null;
    },
    
    // Изменение статуса
    async updateStatus(id, status) {
        const result = await query(
            `UPDATE listings SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
            [status, id]
        );
        await del(`listing:${id}`);
        return result.rows[0];
    },
    
    // Отметить как проданное
    async markAsSold(id) {
        const result = await query(
            `UPDATE listings SET status = 'sold', sold_at = NOW() WHERE id = $1 RETURNING *`,
            [id]
        );
        await del(`listing:${id}`);
        return result.rows[0];
    },
    
    // Удаление (мягкое)
    async softDelete(id) {
        await query(`UPDATE listings SET status = 'deleted', deleted_at = NOW() WHERE id = $1`, [id]);
        await del(`listing:${id}`);
    },
    
    // Получение объявлений пользователя
    async findByUser(userId, status = null, limit = 20, cursor = null) {
        let sql = `SELECT * FROM listings WHERE user_id = $1 AND status != 'deleted'`;
        const params = [userId];
        
        if (status) {
            sql += ` AND status = $${params.length + 1}`;
            params.push(status);
        }
        
        if (cursor) {
            sql += ` AND id < $${params.length + 1}`;
            params.push(cursor);
        }
        
        sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
        params.push(limit + 1);
        
        const result = await query(sql, params);
        const hasMore = result.rows.length > limit;
        const listings = hasMore ? result.rows.slice(0, -1) : result.rows;
        const nextCursor = hasMore ? listings[listings.length - 1]?.id : null;
        
        return { listings, nextCursor, hasMore };
    },
    
    // Поиск объявлений с фильтрами
    async search(filters, limit = 20, cursor = null) {
        const conditions = [];
        const params = [];
        let idx = 1;
        
        if (filters.q) {
            conditions.push(`to_tsvector('russian', title || ' ' || COALESCE(description, '')) @@ plainto_tsquery('russian', $${idx})`);
            params.push(filters.q);
            idx++;
        }
        
        if (filters.categoryId) {
            conditions.push(`category_id = $${idx}`);
            params.push(filters.categoryId);
            idx++;
        }
        
        if (filters.priceMin !== undefined) {
            conditions.push(`price >= $${idx}`);
            params.push(filters.priceMin);
            idx++;
        }
        
        if (filters.priceMax !== undefined) {
            conditions.push(`price <= $${idx}`);
            params.push(filters.priceMax);
            idx++;
        }
        
        if (filters.city) {
            conditions.push(`city ILIKE $${idx}`);
            params.push(`%${filters.city}%`);
            idx++;
        }
        
        if (filters.sellerType === 'private') {
            conditions.push(`user_id NOT IN (SELECT user_id FROM company_profiles)`);
        } else if (filters.sellerType === 'company') {
            conditions.push(`user_id IN (SELECT user_id FROM company_profiles)`);
        }
        
        conditions.push(`status = 'active'`);
        
        let sql = `SELECT * FROM listings WHERE ${conditions.join(' AND ')}`;
        
        if (cursor) {
            sql += ` AND id < $${idx}`;
            params.push(cursor);
            idx++;
        }
        
        const sortOrder = filters.sort === 'price_asc' ? 'price ASC' :
                          filters.sort === 'price_desc' ? 'price DESC' :
                          filters.sort === 'popular' ? 'views DESC' : 'created_at DESC';
        
        sql += ` ORDER BY ${sortOrder} LIMIT $${idx}`;
        params.push(limit + 1);
        
        const result = await query(sql, params);
        const hasMore = result.rows.length > limit;
        const listings = hasMore ? result.rows.slice(0, -1) : result.rows;
        const nextCursor = hasMore ? listings[listings.length - 1]?.id : null;
        
        return { listings, nextCursor, hasMore };
    },
};

// ============================================
// МОДЕЛЬ ФОТОГРАФИЙ (ListingPhoto)
// ============================================

const ListingPhoto = {
    // Добавление фото
    async add(listingId, url, orderIndex) {
        const result = await query(
            `INSERT INTO listing_photos (listing_id, url, order_index, created_at)
             VALUES ($1, $2, $3, NOW())
             RETURNING *`,
            [listingId, url, orderIndex]
        );
        
        await del(`listing:${listingId}`);
        return result.rows[0];
    },
    
    // Добавление нескольких фото
    async addMany(listingId, urls) {
        await transaction(async (client) => {
            for (let i = 0; i < urls.length; i++) {
                await client.query(
                    `INSERT INTO listing_photos (listing_id, url, order_index, created_at)
                     VALUES ($1, $2, $3, NOW())`,
                    [listingId, urls[i], i]
                );
            }
        });
        
        await del(`listing:${listingId}`);
    },
    
    // Получение всех фото объявления
    async findByListing(listingId) {
        const result = await query(
            `SELECT * FROM listing_photos WHERE listing_id = $1 ORDER BY order_index ASC`,
            [listingId]
        );
        return result.rows;
    },
    
    // Удаление фото
    async delete(id) {
        const result = await query(`DELETE FROM listing_photos WHERE id = $1 RETURNING listing_id`, [id]);
        if (result.rows[0]) {
            await del(`listing:${result.rows[0].listing_id}`);
        }
        return result.rows[0];
    },
    
    // Обновление порядка
    async reorder(listingId, photoIds) {
        await transaction(async (client) => {
            for (let i = 0; i < photoIds.length; i++) {
                await client.query(
                    `UPDATE listing_photos SET order_index = $1 WHERE id = $2 AND listing_id = $3`,
                    [i, photoIds[i], listingId]
                );
            }
        });
        
        await del(`listing:${listingId}`);
    },
};

// Конец ЧАСТИ 1/3. Напишите "ЧАСТЬ 2" для продолжения моделей (Категории, Избранное, Чаты, Отзывы)
// ============================================
// МОДЕЛЬ КАТЕГОРИИ (Category)
// ============================================

const Category = {
    // Создание категории
    async create(data) {
        const { name, parentId, slug, icon, orderIndex } = data;
        
        const result = await query(
            `INSERT INTO categories (name, parent_id, slug, icon, order_index, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             RETURNING *`,
            [name, parentId || null, slug, icon || null, orderIndex || 0]
        );
        
        // Очищаем кеш категорий
        await del('categories:tree');
        await del('categories:list');
        
        return result.rows[0];
    },
    
    // Получение всех категорий (плоский список)
    async findAll() {
        const cached = await get('categories:list');
        if (cached) return cached;
        
        const result = await query(
            `SELECT * FROM categories ORDER BY parent_id NULLS FIRST, order_index ASC`
        );
        
        await set('categories:list', result.rows, 3600);
        return result.rows;
    },
    
    // Получение дерева категорий
    async getTree() {
        const cached = await get('categories:tree');
        if (cached) return cached;
        
        const categories = await this.findAll();
        const map = new Map();
        const roots = [];
        
        for (const cat of categories) {
            map.set(cat.id, { ...cat, children: [] });
        }
        
        for (const cat of categories) {
            if (cat.parent_id) {
                const parent = map.get(cat.parent_id);
                if (parent) {
                    parent.children.push(map.get(cat.id));
                }
            } else {
                roots.push(map.get(cat.id));
            }
        }
        
        await set('categories:tree', roots, 3600);
        return roots;
    },
    
    // Поиск категории по ID с полным путём
    async findByIdWithPath(id) {
        const result = await query(
            `WITH RECURSIVE category_path AS (
                SELECT id, name, parent_id, 1 as level
                FROM categories WHERE id = $1
                UNION ALL
                SELECT c.id, c.name, c.parent_id, cp.level + 1
                FROM categories c
                INNER JOIN category_path cp ON c.id = cp.parent_id
            )
            SELECT id, name, level FROM category_path ORDER BY level DESC`,
            [id]
        );
        
        return {
            category: await this.findById(id),
            path: result.rows.map(row => ({ id: row.id, name: row.name }))
        };
    },
    
    // Поиск категории по ID
    async findById(id) {
        const result = await query(`SELECT * FROM categories WHERE id = $1`, [id]);
        return result.rows[0] || null;
    },
    
    // Поиск по slug
    async findBySlug(slug) {
        const result = await query(`SELECT * FROM categories WHERE slug = $1`, [slug]);
        return result.rows[0] || null;
    },
    
    // Получение подкатегорий
    async getChildren(id) {
        const result = await query(
            `SELECT * FROM categories WHERE parent_id = $1 ORDER BY order_index ASC`,
            [id]
        );
        return result.rows;
    },
    
    // Обновление категории
    async update(id, updates) {
        const fields = [];
        const values = [];
        let idx = 1;
        
        for (const [key, value] of Object.entries(updates)) {
            if (value !== undefined) {
                fields.push(`${key} = $${idx}`);
                values.push(value);
                idx++;
            }
        }
        
        if (fields.length === 0) return null;
        
        values.push(id);
        const result = await query(
            `UPDATE categories SET ${fields.join(', ')}, updated_at = NOW()
             WHERE id = $${idx}
             RETURNING *`,
            values
        );
        
        await del('categories:tree');
        await del('categories:list');
        
        return result.rows[0];
    },
    
    // Удаление категории (каскадно)
    async delete(id) {
        await query(`DELETE FROM categories WHERE id = $1`, [id]);
        await del('categories:tree');
        await del('categories:list');
    },
};

// ============================================
// МОДЕЛЬ ИЗБРАННОГО (Favorite)
// ============================================

const Favorite = {
    // Добавить в избранное
    async add(userId, listingId) {
        const result = await query(
            `INSERT INTO favorites (user_id, listing_id, created_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (user_id, listing_id) DO NOTHING
             RETURNING *`,
            [userId, listingId]
        );
        
        if (result.rows[0]) {
            await Listing.incrementLikes(listingId);
        }
        
        return result.rows[0];
    },
    
    // Удалить из избранного
    async remove(userId, listingId) {
        const result = await query(
            `DELETE FROM favorites WHERE user_id = $1 AND listing_id = $2 RETURNING *`,
            [userId, listingId]
        );
        
        if (result.rows[0]) {
            await Listing.decrementLikes(listingId);
        }
        
        return result.rows[0];
    },
    
    // Проверить в избранном
    async isFavorite(userId, listingId) {
        const result = await query(
            `SELECT 1 FROM favorites WHERE user_id = $1 AND listing_id = $2`,
            [userId, listingId]
        );
        return result.rows.length > 0;
    },
    
    // Получить все избранные объявления пользователя
    async findByUser(userId, limit = 20, cursor = null) {
        let sql = `
            SELECT l.*, u.name as seller_name, u.avatar as seller_avatar,
                   f.created_at as favorited_at
            FROM favorites f
            JOIN listings l ON l.id = f.listing_id
            JOIN users u ON u.id = l.user_id
            WHERE f.user_id = $1 AND l.status = 'active'
        `;
        const params = [userId];
        
        if (cursor) {
            sql += ` AND f.id < $${params.length + 1}`;
            params.push(cursor);
        }
        
        sql += ` ORDER BY f.id DESC LIMIT $${params.length + 1}`;
        params.push(limit + 1);
        
        const result = await query(sql, params);
        const hasMore = result.rows.length > limit;
        const listings = hasMore ? result.rows.slice(0, -1) : result.rows;
        const nextCursor = hasMore ? listings[listings.length - 1]?.id : null;
        
        return { listings, nextCursor, hasMore };
    },
    
    // Количество избранных у объявления
    async count(listingId) {
        const result = await query(
            `SELECT COUNT(*) FROM favorites WHERE listing_id = $1`,
            [listingId]
        );
        return parseInt(result.rows[0].count);
    },
};

// ============================================
// МОДЕЛЬ ЧАТА (Chat)
// ============================================

const Chat = {
    // Создание чата
    async create(listingId, buyerId, sellerId) {
        // Проверяем, существует ли уже чат
        const existing = await query(
            `SELECT id FROM chats WHERE listing_id = $1 AND buyer_id = $2 AND seller_id = $3`,
            [listingId, buyerId, sellerId]
        );
        
        if (existing.rows[0]) {
            return existing.rows[0];
        }
        
        const result = await query(
            `INSERT INTO chats (listing_id, buyer_id, seller_id, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())
             RETURNING *`,
            [listingId, buyerId, sellerId]
        );
        
        return result.rows[0];
    },
    
    // Получение чата по ID
    async findById(id) {
        const result = await query(
            `SELECT c.*, 
                    l.title as listing_title, l.price as listing_price, l.photos[1] as listing_photo,
                    b.name as buyer_name, b.avatar as buyer_avatar,
                    s.name as seller_name, s.avatar as seller_avatar
             FROM chats c
             JOIN listings l ON l.id = c.listing_id
             JOIN users b ON b.id = c.buyer_id
             JOIN users s ON s.id = c.seller_id
             WHERE c.id = $1`,
            [id]
        );
        
        return result.rows[0] || null;
    },
    
    // Получение всех чатов пользователя
    async findByUser(userId, limit = 50) {
        const result = await query(
            `SELECT c.*, 
                    l.title as listing_title, l.price as listing_price, l.photos[1] as listing_photo,
                    CASE 
                        WHEN c.buyer_id = $1 THEN s.name
                        ELSE b.name
                    END as other_user_name,
                    CASE 
                        WHEN c.buyer_id = $1 THEN s.avatar
                        ELSE b.avatar
                    END as other_user_avatar,
                    (SELECT text FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
                    (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_time,
                    (SELECT COUNT(*) FROM messages WHERE chat_id = c.id AND is_read = false AND sender_id != $1) as unread_count
             FROM chats c
             JOIN listings l ON l.id = c.listing_id
             JOIN users b ON b.id = c.buyer_id
             JOIN users s ON s.id = c.seller_id
             WHERE c.buyer_id = $1 OR c.seller_id = $1
             ORDER BY last_message_time DESC NULLS LAST
             LIMIT $2`,
            [userId, limit]
        );
        
        return result.rows;
    },
    
    // Обновление времени последнего сообщения
    async updateActivity(chatId) {
        await query(
            `UPDATE chats SET updated_at = NOW() WHERE id = $1`,
            [chatId]
        );
    },
    
    // Удаление чата (для пользователя)
    async deleteForUser(chatId, userId) {
        await query(
            `UPDATE chats SET deleted_by = $1 WHERE id = $2`,
            [userId, chatId]
        );
    },
};

// ============================================
// МОДЕЛЬ СООБЩЕНИЯ (Message)
// ============================================

const Message = {
    // Отправка сообщения
    async create(chatId, senderId, text, photo = null, replyToId = null) {
        const result = await query(
            `INSERT INTO messages (chat_id, sender_id, text, photo, reply_to_id, created_at, is_read)
             VALUES ($1, $2, $3, $4, $5, NOW(), false)
             RETURNING *`,
            [chatId, senderId, text, photo, replyToId]
        );
        
        await Chat.updateActivity(chatId);
        
        return result.rows[0];
    },
    
    // Получение сообщений чата
    async findByChat(chatId, limit = 50, before = null) {
        let sql = `
            SELECT m.*, u.name as sender_name, u.avatar as sender_avatar
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.chat_id = $1
        `;
        const params = [chatId];
        
        if (before) {
            sql += ` AND m.id < $${params.length + 1}`;
            params.push(before);
        }
        
        sql += ` ORDER BY m.id DESC LIMIT $${params.length + 1}`;
        params.push(limit + 1);
        
        const result = await query(sql, params);
        const hasMore = result.rows.length > limit;
        const messages = hasMore ? result.rows.slice(0, -1) : result.rows;
        const nextCursor = hasMore ? messages[messages.length - 1]?.id : null;
        
        return { messages: messages.reverse(), nextCursor, hasMore };
    },
    
    // Отметить сообщения как прочитанные
    async markAsRead(chatId, userId, messageIds = null) {
        let sql = `UPDATE messages SET is_read = true, read_at = NOW() 
                   WHERE chat_id = $1 AND sender_id != $2 AND is_read = false`;
        const params = [chatId, userId];
        
        if (messageIds && messageIds.length > 0) {
            sql += ` AND id = ANY($${params.length + 1})`;
            params.push(messageIds);
        }
        
        const result = await query(sql, params);
        return result.rowCount;
    },
    
    // Удаление сообщения (для всех)
    async delete(messageId, userId) {
        const result = await query(
            `DELETE FROM messages WHERE id = $1 AND sender_id = $2 RETURNING *`,
            [messageId, userId]
        );
        return result.rows[0];
    },
};

// ============================================
// МОДЕЛЬ ОТЗЫВА (Review)
// ============================================

const Review = {
    // Создание отзыва
    async create(fromUserId, toUserId, listingId, rating, text) {
        const result = await query(
            `INSERT INTO reviews (from_user_id, to_user_id, listing_id, rating, text, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (from_user_id, listing_id) DO UPDATE
             SET rating = $4, text = $5, updated_at = NOW()
             RETURNING *`,
            [fromUserId, toUserId, listingId, rating, text]
        );
        
        // Обновляем рейтинг пользователя
        const avgRating = await query(
            `SELECT AVG(rating)::numeric(10,1) as avg FROM reviews WHERE to_user_id = $1`,
            [toUserId]
        );
        
        await query(`UPDATE users SET rating = $1 WHERE id = $2`, [avgRating.rows[0].avg, toUserId]);
        
        return result.rows[0];
    },
    
    // Получение отзывов о пользователе
    async findByUser(toUserId, limit = 20, page = 1) {
        const offset = (page - 1) * limit;
        
        const result = await query(
            `SELECT r.*, u.name as from_user_name, u.avatar as from_user_avatar,
                    l.title as listing_title
             FROM reviews r
             JOIN users u ON u.id = r.from_user_id
             JOIN listings l ON l.id = r.listing_id
             WHERE r.to_user_id = $1
             ORDER BY r.created_at DESC
             LIMIT $2 OFFSET $3`,
            [toUserId, limit, offset]
        );
        
        const countResult = await query(
            `SELECT COUNT(*) FROM reviews WHERE to_user_id = $1`,
            [toUserId]
        );
        
        return {
            reviews: result.rows,
            total: parseInt(countResult.rows[0].count),
            page,
            totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
        };
    },
    
    // Получение среднего рейтинга
    async getAverageRating(userId) {
        const result = await query(
            `SELECT COALESCE(AVG(rating), 0)::numeric(10,1) as avg, COUNT(*) as count
             FROM reviews WHERE to_user_id = $1`,
            [userId]
        );
        
        return {
            rating: parseFloat(result.rows[0].avg),
            count: parseInt(result.rows[0].count),
        };
    },
    
    // Ответ на отзыв
    async reply(reviewId, replyText) {
        const result = await query(
            `UPDATE reviews SET reply = $1, reply_created_at = NOW() WHERE id = $2 RETURNING *`,
            [replyText, reviewId]
        );
        return result.rows[0];
    },
    
    // Удаление отзыва
    async delete(reviewId, userId) {
        const review = await query(`SELECT to_user_id FROM reviews WHERE id = $1`, [reviewId]);
        
        if (review.rows[0]?.to_user_id !== userId) {
            return null;
        }
        
        const result = await query(`DELETE FROM reviews WHERE id = $1 RETURNING *`, [reviewId]);
        
        // Обновляем рейтинг
        const avgRating = await query(
            `SELECT AVG(rating)::numeric(10,1) as avg FROM reviews WHERE to_user_id = $1`,
            [userId]
        );
        
        await query(`UPDATE users SET rating = $1 WHERE id = $2`, [avgRating.rows[0].avg, userId]);
        
        return result.rows[0];
    },
};

// Конец ЧАСТИ 2/3. Напишите "ЧАСТЬ 3" для продолжения моделей (Бонусы, Лотерея, Гараж, Резюме, Аукцион, Чёрный список)
// ============================================
// МОДЕЛЬ БОНУСОВ (Bonus)
// ============================================

const Bonus = {
    // Получение баланса пользователя
    async getBalance(userId) {
        const result = await query(
            `SELECT bonus_balance FROM users WHERE id = $1`,
            [userId]
        );
        return result.rows[0]?.bonus_balance || 0;
    },
    
    // Получение истории транзакций
    async getHistory(userId, limit = 50, offset = 0) {
        const result = await query(
            `SELECT id, amount, type, reference_id, created_at,
                    CASE 
                        WHEN amount > 0 THEN 'Начисление'
                        ELSE 'Списание'
                    END as operation_type
             FROM bonus_transactions 
             WHERE user_id = $1 
             ORDER BY created_at DESC 
             LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
        );
        
        const countResult = await query(
            `SELECT COUNT(*) FROM bonus_transactions WHERE user_id = $1`,
            [userId]
        );
        
        return {
            transactions: result.rows,
            total: parseInt(countResult.rows[0].count),
            balance: await this.getBalance(userId),
        };
    },
    
    // Ежедневный бонус
    async claimDaily(userId) {
        const today = new Date().toISOString().split('T')[0];
        
        // Проверяем, получал ли уже сегодня
        const lastClaim = await query(
            `SELECT created_at FROM bonus_transactions 
             WHERE user_id = $1 AND type = 'daily' 
             AND DATE(created_at) = CURRENT_DATE`,
            [userId]
        );
        
        if (lastClaim.rows.length > 0) {
            return { success: false, message: 'Сегодня уже получали бонус' };
        }
        
        // Получаем текущий streak
        const streakResult = await query(
            `SELECT streak_count FROM user_daily_streak WHERE user_id = $1`,
            [userId]
        );
        
        let streak = streakResult.rows[0]?.streak_count || 0;
        
        // Проверяем, был ли вчера
        const yesterday = await query(
            `SELECT created_at FROM bonus_transactions 
             WHERE user_id = $1 AND type = 'daily' 
             AND DATE(created_at) = CURRENT_DATE - INTERVAL '1 day'`,
            [userId]
        );
        
        if (yesterday.rows.length === 0) {
            streak = 0;
        }
        
        streak++;
        
        // Рассчитываем бонус (базовый 100 + 10% за каждый день streak, макс 200)
        const baseBonus = 100;
        const streakBonus = Math.min(streak * 10, 100);
        const totalBonus = baseBonus + streakBonus;
        
        // Начисляем
        await User.addBonus(userId, totalBonus, 'daily');
        
        // Обновляем streak
        await query(
            `INSERT INTO user_daily_streak (user_id, streak_count, last_claim_date)
             VALUES ($1, $2, CURRENT_DATE)
             ON CONFLICT (user_id) DO UPDATE
             SET streak_count = $2, last_claim_date = CURRENT_DATE`,
            [userId, streak]
        );
        
        return {
            success: true,
            amount: totalBonus,
            streak,
            newBalance: await this.getBalance(userId),
        };
    },
    
    // Получение текущего streak
    async getStreak(userId) {
        const result = await query(
            `SELECT streak_count, last_claim_date FROM user_daily_streak WHERE user_id = $1`,
            [userId]
        );
        
        if (result.rows.length === 0) {
            return { streak: 0, lastClaim: null };
        }
        
        return {
            streak: result.rows[0].streak_count,
            lastClaim: result.rows[0].last_claim_date,
        };
    },
};

// ============================================
// МОДЕЛЬ ЛОТЕРЕИ (Lottery)
// ============================================

const Lottery = {
    // Получение текущего розыгрыша
    async getCurrentDraw() {
        const result = await query(
            `SELECT * FROM lottery_draws 
             WHERE status = 'active' 
             ORDER BY draw_date DESC LIMIT 1`,
            []
        );
        
        if (result.rows.length === 0) {
            // Создаём новый розыгрыш
            const weekNumber = this.getWeekNumber(new Date());
            const drawDate = this.getNextDrawDate();
            
            const newDraw = await query(
                `INSERT INTO lottery_draws (week_number, year, prize_pool, status, draw_date)
                 VALUES ($1, $2, 0, 'active', $3)
                 RETURNING *`,
                [weekNumber, new Date().getFullYear(), drawDate]
            );
            
            return newDraw.rows[0];
        }
        
        return result.rows[0];
    },
    
    // Покупка билета
    async buyTicket(userId, quantity = 1) {
        const draw = await this.getCurrentDraw();
        const ticketPrice = 100; // 100 бонусов за билет
        
        const totalCost = ticketPrice * quantity;
        const balance = await Bonus.getBalance(userId);
        
        if (balance < totalCost) {
            return { success: false, message: 'Недостаточно бонусов' };
        }
        
        // Списываем бонусы
        await User.addBonus(userId, -totalCost, 'lottery_ticket', draw.id);
        
        // Добавляем билеты
        const tickets = [];
        for (let i = 0; i < quantity; i++) {
            const ticketNumber = this.generateTicketNumber();
            const result = await query(
                `INSERT INTO lottery_tickets (draw_id, user_id, ticket_number, created_at)
                 VALUES ($1, $2, $3, NOW())
                 RETURNING *`,
                [draw.id, userId, ticketNumber]
            );
            tickets.push(result.rows[0]);
        }
        
        // Обновляем призовой фонд
        await query(
            `UPDATE lottery_draws SET prize_pool = prize_pool + $1 WHERE id = $2`,
            [totalCost, draw.id]
        );
        
        return {
            success: true,
            tickets,
            totalCost,
            newBalance: await Bonus.getBalance(userId),
        };
    },
    
    // Получение билетов пользователя
    async getUserTickets(userId, drawId = null) {
        let sql = `SELECT * FROM lottery_tickets WHERE user_id = $1`;
        const params = [userId];
        
        if (drawId) {
            sql += ` AND draw_id = $2`;
            params.push(drawId);
        }
        
        sql += ` ORDER BY created_at DESC`;
        
        const result = await query(sql, params);
        return result.rows;
    },
    
    // Проведение розыгрыша
    async performDraw(drawId) {
        // Получаем все билеты
        const tickets = await query(
            `SELECT id, user_id, ticket_number FROM lottery_tickets WHERE draw_id = $1`,
            [drawId]
        );
        
        if (tickets.rows.length === 0) {
            return { success: false, message: 'Нет билетов для розыгрыша' };
        }
        
        // Выбираем победителя
        const randomIndex = Math.floor(Math.random() * tickets.rows.length);
        const winner = tickets.rows[randomIndex];
        
        // Получаем призовой фонд
        const draw = await query(`SELECT prize_pool FROM lottery_draws WHERE id = $1`, [drawId]);
        const prizePool = draw.rows[0].prize_pool;
        const winnerPrize = Math.floor(prizePool * 0.7); // 70% победителю
        
        // Начисляем приз
        await User.addBonus(winner.user_id, winnerPrize, 'lottery_win', drawId);
        
        // Обновляем розыгрыш
        await query(
            `UPDATE lottery_draws 
             SET status = 'completed', winner_id = $1, winner_prize = $2, completed_at = NOW()
             WHERE id = $3`,
            [winner.user_id, winnerPrize, drawId]
        );
        
        return {
            success: true,
            winner,
            prizePool,
            winnerPrize,
        };
    },
    
    // Получение победителей
    async getWinners(limit = 10) {
        const result = await query(
            `SELECT d.*, u.name as winner_name, u.avatar as winner_avatar
             FROM lottery_draws d
             JOIN users u ON u.id = d.winner_id
             WHERE d.status = 'completed' AND d.winner_id IS NOT NULL
             ORDER BY d.draw_date DESC
             LIMIT $1`,
            [limit]
        );
        
        return result.rows;
    },
    
    // Вспомогательные функции
    getWeekNumber(date) {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
        const week1 = new Date(d.getFullYear(), 0, 4);
        return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
    },
    
    getNextDrawDate() {
        const now = new Date();
        const daysUntilSunday = (7 - now.getDay()) % 7;
        const nextSunday = new Date(now);
        nextSunday.setDate(now.getDate() + daysUntilSunday);
        nextSunday.setHours(20, 0, 0, 0);
        return nextSunday;
    },
    
    generateTicketNumber() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < 8; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    },
};

// ============================================
// МОДЕЛЬ ГАРАЖА (Garage)
// ============================================

const Garage = {
    // Добавление автомобиля
    async add(userId, data) {
        const { brand, model, year, vin, mileage, color, photoUrl } = data;
        
        const result = await query(
            `INSERT INTO garage (user_id, brand, model, year, vin, mileage, color, photo_url, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             RETURNING *`,
            [userId, brand, model, year, vin || null, mileage || null, color || null, photoUrl || null]
        );
        
        return result.rows[0];
    },
    
    // Получение всех авто пользователя
    async findByUser(userId) {
        const result = await query(
            `SELECT * FROM garage WHERE user_id = $1 ORDER BY is_main DESC, created_at DESC`,
            [userId]
        );
        return result.rows;
    },
    
    // Получение главного авто
    async getMain(userId) {
        const result = await query(
            `SELECT * FROM garage WHERE user_id = $1 AND is_main = true LIMIT 1`,
            [userId]
        );
        return result.rows[0] || null;
    },
    
    // Обновление авто
    async update(id, userId, updates) {
        const fields = [];
        const values = [];
        let idx = 1;
        
        for (const [key, value] of Object.entries(updates)) {
            if (value !== undefined) {
                fields.push(`${key} = $${idx}`);
                values.push(value);
                idx++;
            }
        }
        
        if (fields.length === 0) return null;
        
        values.push(id, userId);
        const result = await query(
            `UPDATE garage SET ${fields.join(', ')}, updated_at = NOW()
             WHERE id = $${idx} AND user_id = $${idx + 1}
             RETURNING *`,
            values
        );
        
        return result.rows[0] || null;
    },
    
    // Сделать главным
    async setMain(id, userId) {
        await transaction(async (client) => {
            // Снимаем флаг со всех авто пользователя
            await client.query(
                `UPDATE garage SET is_main = false WHERE user_id = $1`,
                [userId]
            );
            
            // Устанавливаем флаг на выбранное авто
            await client.query(
                `UPDATE garage SET is_main = true WHERE id = $1 AND user_id = $2`,
                [id, userId]
            );
        });
        
        return true;
    },
    
    // Удаление авто
    async delete(id, userId) {
        const result = await query(
            `DELETE FROM garage WHERE id = $1 AND user_id = $2 RETURNING *`,
            [id, userId]
        );
        return result.rows[0];
    },
    
    // Декодирование VIN (заглушка, реальный API будет отдельно)
    async decodeVin(vin) {
        // Здесь будет реальный запрос к внешнему API
        // Пока возвращаем заглушку
        return {
            vin,
            brand: 'Unknown',
            model: 'Unknown',
            year: null,
            engine: null,
        };
    },
};

// ============================================
// МОДЕЛЬ РЕЗЮМЕ (Resume)
// ============================================

const Resume = {
    // Создание резюме
    async create(userId, data) {
        const { fullName, birthDate, education, experience, skills, phone, email } = data;
        
        const result = await query(
            `INSERT INTO resumes (user_id, full_name, birth_date, education, experience, skills, phone, email, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             ON CONFLICT (user_id) DO UPDATE
             SET full_name = $2, birth_date = $3, education = $4, experience = $5, 
                 skills = $6, phone = $7, email = $8, updated_at = NOW()
             RETURNING *`,
            [userId, fullName, birthDate, education, experience, skills, phone, email]
        );
        
        return result.rows[0];
    },
    
    // Получение резюме пользователя
    async findByUser(userId) {
        const result = await query(
            `SELECT * FROM resumes WHERE user_id = $1`,
            [userId]
        );
        return result.rows[0] || null;
    },
    
    // Поиск резюме (для работодателей)
    async search(filters, limit = 20, offset = 0) {
        const conditions = [];
        const params = [];
        let idx = 1;
        
        if (filters.q) {
            conditions.push(`(full_name ILIKE $${idx} OR skills ILIKE $${idx} OR experience ILIKE $${idx})`);
            params.push(`%${filters.q}%`);
            idx++;
        }
        
        if (filters.skills) {
            conditions.push(`skills ILIKE $${idx}`);
            params.push(`%${filters.skills}%`);
            idx++;
        }
        
        let sql = `SELECT r.*, u.name as user_name, u.avatar as user_avatar
                   FROM resumes r
                   JOIN users u ON u.id = r.user_id
                   WHERE u.status = 'active'`;
        
        if (conditions.length > 0) {
            sql += ` AND ${conditions.join(' AND ')}`;
        }
        
        sql += ` ORDER BY r.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
        params.push(limit, offset);
        
        const result = await query(sql, params);
        
        const countResult = await query(
            `SELECT COUNT(*) FROM resumes r
             JOIN users u ON u.id = r.user_id
             WHERE u.status = 'active' ${conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : ''}`,
            params.slice(0, -2)
        );
        
        return {
            resumes: result.rows,
            total: parseInt(countResult.rows[0].count),
            limit,
            offset,
        };
    },
    
    // Удаление резюме
    async delete(userId) {
        const result = await query(
            `DELETE FROM resumes WHERE user_id = $1 RETURNING *`,
            [userId]
        );
        return result.rows[0];
    },
};

// ============================================
// МОДЕЛЬ АУКЦИОНА (Auction)
// ============================================

const Auction = {
    // Создание ставки
    async placeBid(listingId, userId, amount) {
        return await transaction(async (client) => {
            // Получаем текущую информацию об аукционе
            const listing = await client.query(
                `SELECT start_price, min_step, current_bid, ends_at, user_id as seller_id
                 FROM listings WHERE id = $1 AND type = 'auction' AND status = 'active'`,
                [listingId]
            );
            
            if (listing.rows.length === 0) {
                throw new Error('Аукцион не найден или неактивен');
            }
            
            const auction = listing.rows[0];
            const currentBid = auction.current_bid || auction.start_price;
            const minBid = currentBid + auction.min_step;
            
            if (amount < minBid) {
                throw new Error(`Минимальная ставка: ${minBid}₽`);
            }
            
            if (new Date(auction.ends_at) < new Date()) {
                throw new Error('Аукцион завершён');
            }
            
            if (userId === auction.seller_id) {
                throw new Error('Нельзя делать ставки на свой аукцион');
            }
            
            // Сохраняем ставку
            const bid = await client.query(
                `INSERT INTO auction_bids (listing_id, user_id, amount, created_at)
                 VALUES ($1, $2, $3, NOW())
                 RETURNING *`,
                [listingId, userId, amount]
            );
            
            // Обновляем текущую ставку
            await client.query(
                `UPDATE listings SET current_bid = $1, current_bidder_id = $2, updated_at = NOW()
                 WHERE id = $3`,
                [amount, userId, listingId]
            );
            
            return bid.rows[0];
        });
    },
    
    // Получение всех ставок на аукцион
    async getBids(listingId, limit = 50) {
        const result = await query(
            `SELECT b.*, u.name as user_name, u.avatar as user_avatar
             FROM auction_bids b
             JOIN users u ON u.id = b.user_id
             WHERE b.listing_id = $1
             ORDER BY b.amount DESC
             LIMIT $2`,
            [listingId, limit]
        );
        
        return result.rows;
    },
    
    // Получение ставок пользователя
    async getUserBids(userId, limit = 50) {
        const result = await query(
            `SELECT b.*, l.title as listing_title, l.current_bid, l.ends_at
             FROM auction_bids b
             JOIN listings l ON l.id = b.listing_id
             WHERE b.user_id = $1
             ORDER BY b.created_at DESC
             LIMIT $2`,
            [userId, limit]
        );
        
        return result.rows;
    },
    
    // Завершение аукциона (вызов по крону)
    async completeExpiredAuctions() {
        const result = await query(
            `UPDATE listings 
             SET status = 'completed', updated_at = NOW()
             WHERE type = 'auction' AND status = 'active' AND ends_at < NOW()
             RETURNING id, current_bidder_id, current_bid`,
            []
        );
        
        for (const auction of result.rows) {
            if (auction.current_bidder_id && auction.current_bid) {
                // Уведомляем победителя
                await query(
                    `INSERT INTO notifications (user_id, type, title, message, data, created_at)
                     VALUES ($1, 'auction_win', 'Вы выиграли аукцион!', 
                             'Ваша ставка ${auction.current_bid}₽ победила', 
                             $2, NOW())`,
                    [auction.current_bidder_id, JSON.stringify({ listingId: auction.id })]
                );
            }
        }
        
        return result.rows;
    },
};

// ============================================
// МОДЕЛЬ ЧЁРНОГО СПИСКА (Blacklist)
// ============================================

const Blacklist = {
    // Добавление в чёрный список
    async add(userId, blockedUserId, reason) {
        const result = await query(
            `INSERT INTO blacklist (user_id, blocked_user_id, reason, created_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (user_id, blocked_user_id) DO NOTHING
             RETURNING *`,
            [userId, blockedUserId, reason]
        );
        
        return result.rows[0];
    },
    
    // Удаление из чёрного списка
    async remove(userId, blockedUserId) {
        const result = await query(
            `DELETE FROM blacklist WHERE user_id = $1 AND blocked_user_id = $2 RETURNING *`,
            [userId, blockedUserId]
        );
        
        return result.rows[0];
    },
    
    // Проверка в чёрном списке
    async isBlocked(userId, blockedUserId) {
        const result = await query(
            `SELECT 1 FROM blacklist WHERE user_id = $1 AND blocked_user_id = $2`,
            [userId, blockedUserId]
        );
        
        return result.rows.length > 0;
    },
    
    // Получение чёрного списка пользователя
    async getUserBlacklist(userId, limit = 50, offset = 0) {
        const result = await query(
            `SELECT b.*, u.name as blocked_user_name, u.avatar as blocked_user_avatar
             FROM blacklist b
             JOIN users u ON u.id = b.blocked_user_id
             WHERE b.user_id = $1
             ORDER BY b.created_at DESC
             LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
        );
        
        const countResult = await query(
            `SELECT COUNT(*) FROM blacklist WHERE user_id = $1`,
            [userId]
        );
        
        return {
            blocked: result.rows,
            total: parseInt(countResult.rows[0].count),
        };
    },
    
    // Автоматическая блокировка при 3+ жалобах за час
    async checkAutoBlock(userId) {
        const result = await query(
            `SELECT COUNT(*) FROM complaints 
             WHERE complained_user_id = $1 
             AND created_at > NOW() - INTERVAL '1 hour'`,
            [userId]
        );
        
        const complaintsCount = parseInt(result.rows[0].count);
        
        if (complaintsCount >= 3) {
            await User.block(userId, 'Автоматическая блокировка: 3+ жалоб за час', 24);
            return true;
        }
        
        return false;
    },
};

// ============================================
// ЭКСПОРТ ВСЕХ МОДЕЛЕЙ
// ============================================

module.exports = {
    User,
    Listing,
    ListingPhoto,
    Category,
    Favorite,
    Chat,
    Message,
    Review,
    Bonus,
    Lottery,
    Garage,
    Resume,
    Auction,
    Blacklist,
};