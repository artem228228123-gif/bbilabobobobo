/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/controllers/listingController.js
 * Описание: Контроллер объявлений (CRUD, поиск, фильтры, модерация)
 */

const fs = require('fs');
const path = require('path');
const { Listing, ListingPhoto, Category, Favorite, User, Review, Blacklist } = require('../models');
const { get, set, del, incr, zincrby } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { processImage, generateAllThumbnails } = require('../services/imageService');
const { processVideo } = require('../services/videoService');
const { config } = require('../../config/env');

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

async function clearListingCache(listingId) {
    await del(`listing:${listingId}`);
    await del(`listing:${listingId}:full`);
    await del(`similar:${listingId}`);
}

async function updateListingScore(listingId) {
    const views = await get(`analytics:listing:views:${listingId}`) || 0;
    const likes = await get(`analytics:listing:likes:${listingId}`) || 0;
    const shares = await get(`analytics:listing:shares:${listingId}`) || 0;
    const chats = await get(`analytics:listing:chats:${listingId}`) || 0;
    
    const score = parseInt(views) + parseInt(likes) * 10 + parseInt(shares) * 5 + parseInt(chats) * 3;
    await zincrby('analytics:top:listings', score, listingId.toString());
}

// ============================================
// ПОЛУЧЕНИЕ СПИСКА ОБЪЯВЛЕНИЙ
// ============================================

async function getListings(req, res) {
    const {
        q,
        category_id,
        price_min,
        price_max,
        city,
        radius,
        lat,
        lng,
        seller_type = 'all',
        sort = 'created_desc',
        limit = 20,
        cursor
    } = req.query;

    try {
        const filters = {
            q,
            categoryId: category_id ? parseInt(category_id) : null,
            priceMin: price_min ? parseInt(price_min) : null,
            priceMax: price_max ? parseInt(price_max) : null,
            city: city || null,
            radius: radius ? parseInt(radius) : null,
            lat: lat ? parseFloat(lat) : null,
            lng: lng ? parseFloat(lng) : null,
            sellerType: seller_type,
            sort
        };

        const { listings, nextCursor, hasMore } = await Listing.search(filters, parseInt(limit), cursor);

        if (req.user) {
            for (const listing of listings) {
                listing.isFavorite = await Favorite.isFavorite(req.user.id, listing.id);
                listing.isSubscribed = await Blacklist.isBlocked(listing.user_id, req.user.id) === false;
            }
        }

        res.json({
            success: true,
            listings,
            nextCursor,
            hasMore,
            count: listings.length
        });
    } catch (error) {
        console.error('Ошибка получения объявлений:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОЛУЧЕНИЕ ОДНОГО ОБЪЯВЛЕНИЯ
// ============================================

async function getListing(req, res) {
    const { id } = req.params;

    try {
        await Listing.incrementViews(id);
        await incr(`analytics:listing:views:${id}`, 1);
        await updateListingScore(id);

        const listing = await Listing.findById(id, true);
        
        if (!listing || listing.status === 'deleted') {
            return res.status(404).json({ error: 'Объявление не найдено' });
        }

        const photos = await ListingPhoto.findByListing(id);
        const sellerStats = await User.getStats(listing.user_id);
        const sellerReviews = await Review.getAverageRating(listing.user_id);
        const isFavorite = req.user ? await Favorite.isFavorite(req.user.id, id) : false;
        const isSubscribed = req.user ? await Blacklist.isBlocked(listing.user_id, req.user.id) === false : false;

        const similar = await Listing.search({
            categoryId: listing.category_id,
            priceMin: listing.price * 0.7,
            priceMax: listing.price * 1.3,
            city: listing.city,
            limit: 6
        });

        const priceHistory = await Listing.query(
            `SELECT old_price, new_price, changed_at FROM price_history WHERE listing_id = $1 ORDER BY changed_at ASC`,
            [id]
        );

        res.json({
            success: true,
            listing: {
                ...listing,
                photos,
                price_history: priceHistory.rows,
                seller: {
                    id: listing.user_id,
                    name: listing.seller_name,
                    avatar: listing.seller_avatar,
                    rating: sellerReviews.rating,
                    reviews_count: sellerReviews.count,
                    stats: sellerStats,
                    registered_at: listing.user_created_at
                },
                isFavorite,
                isSubscribed
            },
            similar: similar.listings.filter(l => l.id !== parseInt(id)).slice(0, 6)
        });
    } catch (error) {
        console.error('Ошибка получения объявления:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// СОЗДАНИЕ ОБЪЯВЛЕНИЯ
// ============================================

async function createListing(req, res) {
    const {
        title,
        description,
        price,
        category_id,
        city,
        latitude,
        longitude,
        address,
        hide_address,
        phone,
        email,
        show_phone,
        type = 'regular',
        start_price,
        min_step,
        ends_at,
        specs
    } = req.body;

    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Необходимо загрузить хотя бы одно фото' });
    }

    try {
        const category = await Category.findById(category_id);
        if (!category) {
            return res.status(400).json({ error: 'Категория не найдена' });
        }

        const listing = await Listing.create({
            userId: req.user.id,
            categoryId: category_id,
            title,
            description: description || null,
            price: parseInt(price),
            city: city || null,
            latitude: latitude || null,
            longitude: longitude || null,
            address: address || null,
            hide_address: hide_address === 'true',
            phone: phone || null,
            email: email || null,
            show_phone: show_phone === 'true',
            type,
            startPrice: start_price ? parseInt(start_price) : null,
            minStep: min_step ? parseInt(min_step) : null,
            endsAt: ends_at || null
        });

        // Сохраняем характеристики
        if (specs && typeof specs === 'object') {
            for (const [key, value] of Object.entries(specs)) {
                if (key && value) {
                    await Listing.query(
                        `INSERT INTO listing_attributes (listing_id, attribute_key, attribute_value) VALUES ($1, $2, $3)`,
                        [listing.id, key, value]
                    );
                }
            }
        }

        // Обрабатываем фото в фоне
        await addJob('imageProcessing', 'processListingPhotos', {
            listingId: listing.id,
            files: req.files.map(f => ({
                path: f.path,
                originalname: f.originalname,
                size: f.size
            }))
        });

        await User.addBonus(req.user.id, 10, 'listing_create', listing.id);
        await incr(`analytics:user:${req.user.id}:listings`, 1);

        res.status(201).json({
            success: true,
            listing,
            message: 'Объявление создано. Фото обрабатываются.'
        });
    } catch (error) {
        console.error('Ошибка создания объявления:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ОБНОВЛЕНИЕ ОБЪЯВЛЕНИЯ
// ============================================

async function updateListing(req, res) {
    const { id } = req.params;
    const {
        title,
        description,
        price,
        category_id,
        city,
        latitude,
        longitude,
        address,
        hide_address,
        phone,
        email,
        show_phone,
        status,
        specs,
        deleted_photos
    } = req.body;

    try {
        const listing = await Listing.findById(id);
        if (!listing) {
            return res.status(404).json({ error: 'Объявление не найдено' });
        }

        // Сохраняем старую цену для истории
        if (price && parseInt(price) !== listing.price) {
            await Listing.query(
                `INSERT INTO price_history (listing_id, old_price, new_price, changed_at) VALUES ($1, $2, $3, NOW())`,
                [id, listing.price, parseInt(price)]
            );
        }

        const updates = {};
        if (title) updates.title = title;
        if (description !== undefined) updates.description = description;
        if (price) updates.price = parseInt(price);
        if (category_id) updates.category_id = category_id;
        if (city !== undefined) updates.city = city;
        if (latitude !== undefined) updates.latitude = latitude;
        if (longitude !== undefined) updates.longitude = longitude;
        if (address !== undefined) updates.address = address;
        if (hide_address !== undefined) updates.hide_address = hide_address === 'true';
        if (phone !== undefined) updates.phone = phone;
        if (email !== undefined) updates.email = email;
        if (show_phone !== undefined) updates.show_phone = show_phone === 'true';
        if (status) updates.status = status;

        if (Object.keys(updates).length > 0) {
            await Listing.update(id, updates);
        }

        // Обновляем характеристики
        if (specs && typeof specs === 'object') {
            await Listing.query(`DELETE FROM listing_attributes WHERE listing_id = $1`, [id]);
            for (const [key, value] of Object.entries(specs)) {
                if (key && value) {
                    await Listing.query(
                        `INSERT INTO listing_attributes (listing_id, attribute_key, attribute_value) VALUES ($1, $2, $3)`,
                        [id, key, value]
                    );
                }
            }
        }

        // Удаляем фото
        if (deleted_photos && deleted_photos.length > 0) {
            const deletedIds = JSON.parse(deleted_photos);
            for (const photoId of deletedIds) {
                const photo = await ListingPhoto.delete(photoId);
                if (photo) {
                    const filePath = path.join(__dirname, '../../uploads', photo.url);
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                }
            }
        }

        // Добавляем новые фото
        if (req.files && req.files.length > 0) {
            await addJob('imageProcessing', 'processListingPhotos', {
                listingId: parseInt(id),
                files: req.files.map(f => ({
                    path: f.path,
                    originalname: f.originalname,
                    size: f.size
                }))
            });
        }

        await clearListingCache(id);

        const updatedListing = await Listing.findById(id);
        const photos = await ListingPhoto.findByListing(id);

        res.json({
            success: true,
            listing: { ...updatedListing, photos }
        });
    } catch (error) {
        console.error('Ошибка обновления объявления:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// УДАЛЕНИЕ ОБЪЯВЛЕНИЯ
// ============================================

async function deleteListing(req, res) {
    const { id } = req.params;

    try {
        const listing = await Listing.findById(id);
        if (!listing) {
            return res.status(404).json({ error: 'Объявление не найдено' });
        }

        const photos = await ListingPhoto.findByListing(id);
        for (const photo of photos) {
            const filePath = path.join(__dirname, '../../uploads', photo.url);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            if (photo.thumbnail_url) {
                const thumbPath = path.join(__dirname, '../../uploads', photo.thumbnail_url);
                if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
            }
        }

        await Listing.softDelete(id);
        await clearListingCache(id);

        res.json({ success: true, message: 'Объявление удалено' });
    } catch (error) {
        console.error('Ошибка удаления объявления:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ЛАЙК / ИЗБРАННОЕ
// ============================================

async function toggleLike(req, res) {
    const { id } = req.params;

    try {
        const listing = await Listing.findById(id);
        if (!listing || listing.status !== 'active') {
            return res.status(404).json({ error: 'Объявление не найдено' });
        }

        const isFavorite = await Favorite.isFavorite(req.user.id, id);
        
        if (isFavorite) {
            await Favorite.remove(req.user.id, id);
            await incr(`analytics:listing:likes:${id}`, -1);
            await updateListingScore(id);
            res.json({ success: true, liked: false, message: 'Удалено из избранного' });
        } else {
            await Favorite.add(req.user.id, id);
            await incr(`analytics:listing:likes:${id}`, 1);
            await updateListingScore(id);
            
            await addJob('notificationQueue', 'newLikeNotification', {
                userId: listing.user_id,
                listingId: id,
                listingTitle: listing.title,
                likerName: req.user.name
            });
            
            res.json({ success: true, liked: true, message: 'Добавлено в избранное' });
        }
    } catch (error) {
        console.error('Ошибка лайка:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ОТМЕТКА "ПРОДАНО"
// ============================================

async function markAsSold(req, res) {
    const { id } = req.params;

    try {
        const listing = await Listing.markAsSold(id);
        await User.addBonus(req.user.id, 50, 'listing_sold', id);
        await clearListingCache(id);

        res.json({ 
            success: true, 
            listing,
            message: 'Объявление отмечено как проданное. +50 бонусов!'
        });
    } catch (error) {
        console.error('Ошибка отметки продажи:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОДНЯТИЕ ОБЪЯВЛЕНИЯ (Bump)
// ============================================

async function bumpListing(req, res) {
    const { id } = req.params;

    try {
        const listing = await Listing.findById(id);
        if (!listing) {
            return res.status(404).json({ error: 'Объявление не найдено' });
        }

        if (listing.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Доступ запрещён' });
        }

        // Проверяем, не поднималось ли уже сегодня
        const lastBump = listing.bumped_at;
        if (lastBump && new Date(lastBump) > new Date(Date.now() - 24 * 60 * 60 * 1000)) {
            return res.status(400).json({ error: 'Объявление можно поднимать не чаще раза в сутки' });
        }

        await Listing.update(id, { bumped_at: new Date(), created_at: new Date() });
        await clearListingCache(id);

        res.json({ success: true, message: 'Объявление поднято в топ' });
    } catch (error) {
        console.error('Ошибка поднятия объявления:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОХОЖИЕ ОБЪЯВЛЕНИЯ
// ============================================

async function getSimilarListings(req, res) {
    const { id } = req.params;
    const { limit = 10 } = req.query;

    try {
        const listing = await Listing.findById(id);
        if (!listing) {
            return res.status(404).json({ error: 'Объявление не найдено' });
        }

        const cacheKey = `similar:${id}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, listings: cached });
        }

        const { listings } = await Listing.search({
            categoryId: listing.category_id,
            priceMin: listing.price * 0.7,
            priceMax: listing.price * 1.3,
            city: listing.city,
            limit: parseInt(limit) + 1
        });

        const filtered = listings.filter(l => l.id !== parseInt(id)).slice(0, parseInt(limit));
        await set(cacheKey, filtered, 3600);

        res.json({ success: true, listings: filtered });
    } catch (error) {
        console.error('Ошибка получения похожих объявлений:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ЖАЛОБА НА ОБЪЯВЛЕНИЕ
// ============================================

async function reportListing(req, res) {
    const { id } = req.params;
    const { reason, description } = req.body;

    try {
        const listing = await Listing.findById(id);
        if (!listing) {
            return res.status(404).json({ error: 'Объявление не найдено' });
        }

        await Listing.query(
            `INSERT INTO complaints (user_id, complained_user_id, listing_id, reason, description, status, created_at)
             VALUES ($1, $2, $3, $4, $5, 'pending', NOW())`,
            [req.user.id, listing.user_id, id, reason, description || null]
        );

        await addJob('notificationQueue', 'notifyModerators', {
            type: 'new_complaint',
            listingId: id,
            reason
        });

        res.json({ success: true, message: 'Жалоба отправлена на модерацию' });
    } catch (error) {
        console.error('Ошибка отправки жалобы:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    getListings,
    getListing,
    createListing,
    updateListing,
    deleteListing,
    toggleLike,
    markAsSold,
    bumpListing,
    getSimilarListings,
    reportListing
};