/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/routes/map.js
 * Описание: Маршруты для карты (маркеры, поиск адресов, геокодинг, радиус)
 */

const express = require('express');
const { query, param, validationResult } = require('express-validator');
const axios = require('axios');

const router = express.Router();
const { Listing } = require('../models');
const { get, set } = require('../../config/redis');
const { config } = require('../../config/env');

// ============================================
// КОНСТАНТЫ
// ============================================

const DEFAULT_LAT = 55.751244;  // Москва
const DEFAULT_LNG = 37.618423;
const DEFAULT_ZOOM = 10;
const MAX_MARKERS = 500;
const CACHE_TTL = 300; // 5 минут

// OpenStreetMap Nominatim (бесплатный геокодер)
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'AIDA/3.0 (https://aida.ru)';

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

// Вычисление расстояния между координатами (формула гаверсинуса)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Радиус Земли в км
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Проверка, находится ли точка в радиусе
function isWithinRadius(lat, lng, centerLat, centerLng, radiusKm) {
    const distance = calculateDistance(lat, lng, centerLat, centerLng);
    return distance <= radiusKm;
}

// ============================================
// GET /api/v1/map/markers
// Получение маркеров для карты с фильтрацией
// ============================================
router.get(
    '/markers',
    [
        query('lat').optional().isFloat({ min: -90, max: 90 }),
        query('lng').optional().isFloat({ min: -180, max: 180 }),
        query('radius').optional().isInt({ min: 1, max: 500 }),
        query('category_id').optional().isInt(),
        query('price_min').optional().isInt({ min: 0 }),
        query('price_max').optional().isInt({ min: 0 }),
        query('city').optional().isString().isLength({ max: 100 }),
        query('limit').optional().isInt({ min: 1, max: 500 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const {
            lat,
            lng,
            radius = 50,
            category_id,
            price_min,
            price_max,
            city,
            limit = MAX_MARKERS
        } = req.query;

        // Кеш-ключ
        const cacheKey = `map:markers:${JSON.stringify(req.query)}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({
                success: true,
                markers: cached,
                fromCache: true,
                count: cached.length
            });
        }

        try {
            let markers = [];
            let listings = [];

            // Если есть координаты и радиус — ищем по геолокации
            if (lat && lng) {
                // Получаем все активные объявления с координатами
                const result = await Listing.search({
                    categoryId: category_id ? parseInt(category_id) : null,
                    priceMin: price_min ? parseInt(price_min) : null,
                    priceMax: price_max ? parseInt(price_max) : null,
                    status: 'active',
                    limit: 1000 // Большой лимит для карты
                });

                // Фильтруем по радиусу
                listings = result.listings.filter(listing => 
                    listing.latitude && listing.longitude &&
                    isWithinRadius(
                        parseFloat(listing.latitude), 
                        parseFloat(listing.longitude),
                        parseFloat(lat), 
                        parseFloat(lng), 
                        parseInt(radius)
                    )
                );
            } 
            // Если есть город — ищем по городу
            else if (city) {
                const result = await Listing.search({
                    categoryId: category_id ? parseInt(category_id) : null,
                    priceMin: price_min ? parseInt(price_min) : null,
                    priceMax: price_max ? parseInt(price_max) : null,
                    city: city,
                    status: 'active',
                    limit: 1000
                });
                listings = result.listings;
            }
            // Иначе — просто последние объявления
            else {
                const result = await Listing.search({
                    categoryId: category_id ? parseInt(category_id) : null,
                    priceMin: price_min ? parseInt(price_min) : null,
                    priceMax: price_max ? parseInt(price_max) : null,
                    status: 'active',
                    sort: 'created_desc',
                    limit: parseInt(limit)
                });
                listings = result.listings;
            }

            // Формируем маркеры
            markers = listings
                .filter(l => l.latitude && l.longitude)
                .slice(0, parseInt(limit))
                .map(listing => ({
                    id: listing.id,
                    lat: parseFloat(listing.latitude),
                    lng: parseFloat(listing.longitude),
                    title: listing.title,
                    price: listing.price,
                    priceFormatted: formatPrice(listing.price),
                    image: listing.photos?.[0] || listing.photo_url || null,
                    categoryId: listing.category_id,
                    city: listing.city,
                    views: listing.views,
                    likes: listing.likes,
                    seller: {
                        id: listing.user_id,
                        name: listing.seller_name,
                        avatar: listing.seller_avatar,
                        rating: listing.seller_rating
                    },
                    created_at: listing.created_at
                }));

            // Сохраняем в кеш
            await set(cacheKey, markers, CACHE_TTL);

            res.json({
                success: true,
                markers,
                count: markers.length,
                center: lat && lng ? { lat: parseFloat(lat), lng: parseFloat(lng) } : null,
                radius: radius
            });

        } catch (error) {
            console.error('Ошибка получения маркеров:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/map/cities
// Поиск городов (автодополнение)
// ============================================
router.get(
    '/cities',
    [
        query('q').isString().isLength({ min: 2, max: 100 }).withMessage('Введите минимум 2 символа'),
        query('limit').optional().isInt({ min: 1, max: 20 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { q, limit = 10 } = req.query;

        // Кеш-ключ
        const cacheKey = `map:cities:${q}:${limit}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, cities: cached, fromCache: true });
        }

        try {
            // Сначала ищем в своей базе
            const dbResult = await require('../models').query(
                `SELECT DISTINCT city, COUNT(*) as count 
                 FROM listings 
                 WHERE city ILIKE $1 AND city IS NOT NULL AND city != ''
                 GROUP BY city 
                 ORDER BY count DESC 
                 LIMIT $2`,
                [`%${q}%`, parseInt(limit) * 2]
            );

            let cities = dbResult.rows.map(row => ({
                name: row.city,
                count: parseInt(row.count),
                source: 'database'
            }));

            // Если не хватает, используем Nominatim
            if (cities.length < parseInt(limit)) {
                try {
                    const nominatimUrl = `${NOMINATIM_URL}/search`;
                    const response = await axios.get(nominatimUrl, {
                        params: {
                            q: q,
                            format: 'json',
                            limit: parseInt(limit),
                            countrycodes: 'ru,kz,by,ua',
                            addressdetails: 1
                        },
                        headers: {
                            'User-Agent': USER_AGENT
                        },
                        timeout: 3000
                    });

                    const externalCities = response.data.map(item => ({
                        name: item.display_name.split(',')[0],
                        lat: item.lat,
                        lon: item.lon,
                        source: 'nominatim'
                    }));

                    // Добавляем только новые города
                    const existingNames = new Set(cities.map(c => c.name.toLowerCase()));
                    for (const city of externalCities) {
                        if (!existingNames.has(city.name.toLowerCase()) && cities.length < parseInt(limit)) {
                            cities.push(city);
                        }
                    }
                } catch (error) {
                    console.error('Nominatim error:', error.message);
                }
            }

            // Ограничиваем результат
            cities = cities.slice(0, parseInt(limit));

            // Сохраняем в кеш на 1 час
            await set(cacheKey, cities, 3600);

            res.json({
                success: true,
                cities,
                query: q
            });

        } catch (error) {
            console.error('Ошибка поиска городов:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/map/geocode
// Геокодирование адреса (адрес → координаты)
// ============================================
router.get(
    '/geocode',
    [
        query('address').isString().isLength({ min: 3, max: 200 }).withMessage('Введите адрес')
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { address } = req.query;

        // Кеш-ключ
        const cacheKey = `map:geocode:${address}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }

        try {
            const nominatimUrl = `${NOMINATIM_URL}/search`;
            const response = await axios.get(nominatimUrl, {
                params: {
                    q: address,
                    format: 'json',
                    limit: 1,
                    addressdetails: 1
                },
                headers: {
                    'User-Agent': USER_AGENT
                },
                timeout: 5000
            });

            if (response.data && response.data.length > 0) {
                const result = response.data[0];
                const data = {
                    lat: parseFloat(result.lat),
                    lng: parseFloat(result.lon),
                    displayName: result.display_name,
                    address: result.address
                };
                
                await set(cacheKey, data, 86400); // Кеш на 24 часа
                res.json({ success: true, ...data });
            } else {
                res.status(404).json({ error: 'Адрес не найден' });
            }

        } catch (error) {
            console.error('Ошибка геокодирования:', error);
            res.status(500).json({ error: 'Ошибка геокодирования' });
        }
    }
);

// ============================================
// GET /api/v1/map/reverse
// Обратное геокодирование (координаты → адрес)
// ============================================
router.get(
    '/reverse',
    [
        query('lat').isFloat({ min: -90, max: 90 }).withMessage('Неверная широта'),
        query('lng').isFloat({ min: -180, max: 180 }).withMessage('Неверная долгота')
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { lat, lng } = req.query;

        // Кеш-ключ
        const cacheKey = `map:reverse:${lat}:${lng}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }

        try {
            const nominatimUrl = `${NOMINATIM_URL}/reverse`;
            const response = await axios.get(nominatimUrl, {
                params: {
                    lat: lat,
                    lon: lng,
                    format: 'json',
                    zoom: 18,
                    addressdetails: 1
                },
                headers: {
                    'User-Agent': USER_AGENT
                },
                timeout: 5000
            });

            if (response.data) {
                const data = {
                    address: response.data.display_name,
                    city: response.data.address?.city || 
                          response.data.address?.town || 
                          response.data.address?.village ||
                          response.data.address?.municipality,
                    street: response.data.address?.road,
                    house: response.data.address?.house_number,
                    country: response.data.address?.country,
                    postalCode: response.data.address?.postcode
                };
                
                await set(cacheKey, data, 86400);
                res.json({ success: true, ...data });
            } else {
                res.status(404).json({ error: 'Адрес не найден' });
            }

        } catch (error) {
            console.error('Ошибка обратного геокодирования:', error);
            res.status(500).json({ error: 'Ошибка обратного геокодирования' });
        }
    }
);

// ============================================
// GET /api/v1/map/route
// Построение маршрута (возвращает ссылку на карты)
// ============================================
router.get(
    '/route',
    [
        query('from_lat').isFloat(),
        query('from_lng').isFloat(),
        query('to_lat').isFloat(),
        query('to_lng').isFloat(),
        query('provider').optional().isIn(['yandex', 'google', '2gis'])
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { from_lat, from_lng, to_lat, to_lng, provider = 'yandex' } = req.query;

        let routeUrl = '';
        
        switch (provider) {
            case 'yandex':
                routeUrl = `https://yandex.ru/maps/?rtext=${from_lat},${from_lng}~${to_lat},${to_lng}&rtt=auto`;
                break;
            case 'google':
                routeUrl = `https://www.google.com/maps/dir/${from_lat},${from_lng}/${to_lat},${to_lng}`;
                break;
            case '2gis':
                routeUrl = `https://2gis.ru/route/points/${from_lng},${from_lat}/${to_lng},${to_lat}`;
                break;
            default:
                routeUrl = `https://yandex.ru/maps/?rtext=${from_lat},${from_lng}~${to_lat},${to_lng}&rtt=auto`;
        }

        res.json({
            success: true,
            url: routeUrl,
            provider,
            from: { lat: from_lat, lng: from_lng },
            to: { lat: to_lat, lng: to_lng }
        });
    }
);

// ============================================
// GET /api/v1/map/cluster
// Кластеризация маркеров (для производительности)
// ============================================
router.post(
    '/cluster',
    [
        query('zoom').isInt({ min: 1, max: 18 }).withMessage('Укажите уровень зума'),
        query('bounds').optional().isString()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { zoom, bounds } = req.query;
        const { markers } = req.body;

        if (!markers || !Array.isArray(markers) || markers.length === 0) {
            return res.json({ clusters: [] });
        }

        try {
            // Простая кластеризация на основе грида
            const gridSize = getGridSizeByZoom(parseInt(zoom));
            const clusters = new Map();

            for (const marker of markers) {
                const gridX = Math.floor(marker.lat / gridSize);
                const gridY = Math.floor(marker.lng / gridSize);
                const key = `${gridX}:${gridY}`;

                if (!clusters.has(key)) {
                    clusters.set(key, {
                        count: 0,
                        lat: 0,
                        lng: 0,
                        items: [],
                        priceMin: Infinity,
                        priceMax: -Infinity
                    });
                }

                const cluster = clusters.get(key);
                cluster.count++;
                cluster.lat += marker.lat;
                cluster.lng += marker.lng;
                cluster.priceMin = Math.min(cluster.priceMin, marker.price);
                cluster.priceMax = Math.max(cluster.priceMax, marker.price);
                
                if (cluster.items.length < 5) {
                    cluster.items.push(marker);
                }
            }

            // Преобразуем в массив
            const result = Array.from(clusters.values()).map(cluster => ({
                count: cluster.count,
                lat: cluster.lat / cluster.count,
                lng: cluster.lng / cluster.count,
                priceMin: cluster.priceMin === Infinity ? 0 : cluster.priceMin,
                priceMax: cluster.priceMax === -Infinity ? 0 : cluster.priceMax,
                items: cluster.items,
                isCluster: cluster.count > 1
            }));

            res.json({
                success: true,
                clusters: result,
                originalCount: markers.length,
                clusterCount: result.length
            });

        } catch (error) {
            console.error('Ошибка кластеризации:', error);
            res.status(500).json({ error: 'Ошибка кластеризации' });
        }
    }
);

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

function getGridSizeByZoom(zoom) {
    // Размер грида в зависимости от зума
    const sizes = {
        1: 5.0, 2: 2.5, 3: 1.25, 4: 0.625,
        5: 0.3125, 6: 0.15625, 7: 0.078125,
        8: 0.0390625, 9: 0.01953125, 10: 0.009765625,
        11: 0.0048828125, 12: 0.00244140625, 13: 0.001220703125,
        14: 0.0006103515625, 15: 0.00030517578125, 16: 0.000152587890625,
        17: 0.0000762939453125, 18: 0.00003814697265625
    };
    return sizes[zoom] || 0.01;
}

function formatPrice(price) {
    return new Intl.NumberFormat('ru-RU').format(price) + ' ₽';
}

// ============================================
// GET /api/v1/map/address-suggest
// Подсказки адресов при вводе
// ============================================
router.get(
    '/address-suggest',
    [
        query('q').isString().isLength({ min: 2, max: 200 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { q, limit = 10 } = req.query;

        try {
            const response = await axios.get(`${NOMINATIM_URL}/search`, {
                params: {
                    q: q,
                    format: 'json',
                    limit: limit,
                    countrycodes: 'ru,kz,by,ua',
                    addressdetails: 1,
                    'accept-language': 'ru'
                },
                headers: { 'User-Agent': USER_AGENT },
                timeout: 3000
            });

            const suggestions = response.data.map(item => ({
                address: item.display_name,
                lat: item.lat,
                lon: item.lon,
                importance: item.importance
            }));

            res.json({
                success: true,
                suggestions,
                query: q
            });

        } catch (error) {
            console.error('Ошибка подсказок адресов:', error);
            res.status(500).json({ error: 'Ошибка получения подсказок' });
        }
    }
);

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = router;