/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/controllers/mapController.js
 * Описание: Контроллер карты (маркеры, кластеризация, геокодинг, маршруты)
 */

const { Listing, Category } = require('../models');
const { get, set, del } = require('../../config/redis');
const axios = require('axios');
const { config } = require('../../config/env');

// ============================================
// КОНСТАНТЫ
// ============================================

const CACHE_TTL = {
    markers: 300,        // 5 минут
    geocode: 86400,      // 24 часа
    reverse: 86400,      // 24 часа
    cities: 3600,        // 1 час
    route: 3600          // 1 час
};

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'AIDA/3.0 (https://aida.ru)';

// Список популярных городов России и СНГ
const POPULAR_CITIES = [
    { name: 'Москва', lat: 55.751244, lng: 37.618423 },
    { name: 'Санкт-Петербург', lat: 59.931058, lng: 30.360909 },
    { name: 'Новосибирск', lat: 55.030199, lng: 82.920430 },
    { name: 'Екатеринбург', lat: 56.838011, lng: 60.597474 },
    { name: 'Казань', lat: 55.796127, lng: 49.106405 },
    { name: 'Нижний Новгород', lat: 56.296503, lng: 43.936059 },
    { name: 'Челябинск', lat: 55.164441, lng: 61.436843 },
    { name: 'Омск', lat: 54.988480, lng: 73.324236 },
    { name: 'Самара', lat: 53.241504, lng: 50.221246 },
    { name: 'Ростов-на-Дону', lat: 47.222078, lng: 39.720358 },
    { name: 'Уфа', lat: 54.734853, lng: 55.957855 },
    { name: 'Красноярск', lat: 56.008377, lng: 92.870179 },
    { name: 'Пермь', lat: 58.010456, lng: 56.229443 },
    { name: 'Воронеж', lat: 51.660781, lng: 39.200269 },
    { name: 'Волгоград', lat: 48.707103, lng: 44.516939 },
    { name: 'Краснодар', lat: 45.035470, lng: 38.975313 },
    { name: 'Саратов', lat: 51.533557, lng: 46.034257 },
    { name: 'Тюмень', lat: 57.153033, lng: 65.534328 },
    { name: 'Тольятти', lat: 53.507836, lng: 49.420393 },
    { name: 'Ижевск', lat: 56.852775, lng: 53.211463 },
    { name: 'Барнаул', lat: 53.347996, lng: 83.779806 },
    { name: 'Ульяновск', lat: 54.317002, lng: 48.386243 },
    { name: 'Иркутск', lat: 52.286387, lng: 104.280660 },
    { name: 'Хабаровск', lat: 48.480223, lng: 135.071917 },
    { name: 'Ярославль', lat: 57.626569, lng: 39.893822 },
    { name: 'Владивосток', lat: 43.115128, lng: 131.885575 },
    { name: 'Махачкала', lat: 42.984913, lng: 47.504646 },
    { name: 'Томск', lat: 56.484636, lng: 84.947649 },
    { name: 'Оренбург', lat: 51.768199, lng: 55.096959 },
    { name: 'Кемерово', lat: 55.354968, lng: 86.087830 },
    { name: 'Новокузнецк', lat: 53.759594, lng: 87.121550 },
    { name: 'Рязань', lat: 54.629111, lng: 39.735896 },
    { name: 'Астрахань', lat: 46.347869, lng: 48.033574 },
    { name: 'Набережные Челны', lat: 55.743553, lng: 52.395822 },
    { name: 'Пенза', lat: 53.194546, lng: 45.019529 },
    { name: 'Липецк', lat: 52.603654, lng: 39.593408 },
    { name: 'Киров', lat: 58.603667, lng: 49.667977 },
    { name: 'Чебоксары', lat: 56.143612, lng: 47.247879 },
    { name: 'Курск', lat: 51.730362, lng: 36.192647 },
    { name: 'Тверь', lat: 56.859611, lng: 35.911896 },
    { name: 'Магнитогорск', lat: 53.407226, lng: 58.979240 },
    { name: 'Брянск', lat: 53.242335, lng: 34.365271 },
    { name: 'Иваново', lat: 56.999367, lng: 40.972927 },
    { name: 'Владимир', lat: 56.128056, lng: 40.408967 },
    { name: 'Севастополь', lat: 44.616650, lng: 33.525367 },
    { name: 'Симферополь', lat: 44.948236, lng: 34.100340 },
    { name: 'Калининград', lat: 54.734855, lng: 20.523025 },
    { name: 'Минск', lat: 53.904540, lng: 27.561524 },
    { name: 'Киев', lat: 50.450001, lng: 30.523333 },
    { name: 'Алматы', lat: 43.222015, lng: 76.851248 }
];

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

function isWithinRadius(lat, lng, centerLat, centerLng, radiusKm) {
    return calculateDistance(lat, lng, centerLat, centerLng) <= radiusKm;
}

function getGridSizeByZoom(zoom) {
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
    return new Intl.NumberFormat('ru-RU').format(price);
}

// ============================================
// ПОЛУЧЕНИЕ МАРКЕРОВ ДЛЯ КАРТЫ
// ============================================

async function getMarkers(req, res) {
    const {
        lat,
        lng,
        radius = 50,
        ne_lat,
        ne_lng,
        sw_lat,
        sw_lng,
        category_id,
        price_min,
        price_max,
        limit = 500
    } = req.query;

    try {
        const cacheKey = `map:markers:${lat}:${lng}:${radius}:${category_id}:${price_min}:${price_max}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, markers: cached, fromCache: true });
        }

        let sql = `
            SELECT l.id, l.title, l.price, l.city, l.latitude, l.longitude, 
                   l.views, l.likes, l.created_at,
                   u.name as seller_name, u.avatar as seller_avatar, u.rating as seller_rating,
                   (SELECT url FROM listing_photos WHERE listing_id = l.id ORDER BY order_index ASC LIMIT 1) as photo
            FROM listings l
            JOIN users u ON u.id = l.user_id
            WHERE l.status = 'active'
            AND l.latitude IS NOT NULL AND l.longitude IS NOT NULL
        `;
        const params = [];
        let idx = 1;

        if (lat && lng) {
            sql += ` AND (6371 * acos(cos(radians($${idx})) * cos(radians(l.latitude)) * 
                         cos(radians(l.longitude) - radians($${idx + 1})) + 
                         sin(radians($${idx})) * sin(radians(l.latitude)))) <= $${idx + 2}`;
            params.push(parseFloat(lat), parseFloat(lng), parseInt(radius));
            idx += 3;
        } else if (ne_lat && ne_lng && sw_lat && sw_lng) {
            sql += ` AND l.latitude BETWEEN $${idx} AND $${idx + 1}
                     AND l.longitude BETWEEN $${idx + 2} AND $${idx + 3}`;
            params.push(parseFloat(sw_lat), parseFloat(ne_lat), parseFloat(sw_lng), parseFloat(ne_lng));
            idx += 4;
        }

        if (category_id) {
            sql += ` AND l.category_id = $${idx}`;
            params.push(parseInt(category_id));
            idx++;
        }

        if (price_min) {
            sql += ` AND l.price >= $${idx}`;
            params.push(parseInt(price_min));
            idx++;
        }

        if (price_max) {
            sql += ` AND l.price <= $${idx}`;
            params.push(parseInt(price_max));
            idx++;
        }

        sql += ` ORDER BY l.created_at DESC LIMIT $${idx}`;
        params.push(parseInt(limit));

        const result = await Listing.query(sql, params);

        const markers = result.rows.map(listing => ({
            id: listing.id,
            lat: parseFloat(listing.latitude),
            lng: parseFloat(listing.longitude),
            title: listing.title,
            price: listing.price,
            priceFormatted: formatPrice(listing.price),
            city: listing.city,
            image: listing.photo,
            views: listing.views,
            likes: listing.likes,
            seller: {
                name: listing.seller_name,
                avatar: listing.seller_avatar,
                rating: listing.seller_rating
            },
            created_at: listing.created_at
        }));

        await set(cacheKey, markers, CACHE_TTL.markers);
        res.json({ success: true, markers, count: markers.length });
    } catch (error) {
        console.error('Ошибка получения маркеров:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// КЛАСТЕРИЗАЦИЯ МАРКЕРОВ
// ============================================

async function clusterMarkers(req, res) {
    const { zoom, markers } = req.body;

    if (!markers || !Array.isArray(markers) || markers.length === 0) {
        return res.json({ clusters: [] });
    }

    try {
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
                    priceMax: -Infinity,
                    priceSum: 0
                });
            }

            const cluster = clusters.get(key);
            cluster.count++;
            cluster.lat += marker.lat;
            cluster.lng += marker.lng;
            cluster.priceMin = Math.min(cluster.priceMin, marker.price);
            cluster.priceMax = Math.max(cluster.priceMax, marker.price);
            cluster.priceSum += marker.price;
            
            if (cluster.items.length < 5) {
                cluster.items.push(marker);
            }
        }

        const result = Array.from(clusters.values()).map(cluster => ({
            count: cluster.count,
            lat: cluster.lat / cluster.count,
            lng: cluster.lng / cluster.count,
            priceMin: cluster.priceMin === Infinity ? 0 : cluster.priceMin,
            priceMax: cluster.priceMax === -Infinity ? 0 : cluster.priceMax,
            avgPrice: Math.round(cluster.priceSum / cluster.count),
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
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ГЕОКОДИНГ (АДРЕС → КООРДИНАТЫ)
// ============================================

async function geocodeAddress(req, res) {
    const { address } = req.query;

    if (!address || address.length < 3) {
        return res.status(400).json({ error: 'Введите адрес (минимум 3 символа)' });
    }

    try {
        const cacheKey = `geocode:${address}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }

        let result = null;

        // Пробуем Яндекс.Карты если есть ключ
        if (config.maps.yandexApiKey) {
            try {
                const response = await axios.get('https://geocode-maps.yandex.ru/1.x', {
                    params: {
                        apikey: config.maps.yandexApiKey,
                        geocode: address,
                        format: 'json',
                        lang: 'ru_RU'
                    },
                    timeout: 5000
                });

                const geoObject = response.data?.response?.GeoObjectCollection?.featureMember?.[0]?.GeoObject;
                if (geoObject) {
                    const pos = geoObject.Point.pos.split(' ');
                    result = {
                        lat: parseFloat(pos[1]),
                        lng: parseFloat(pos[0]),
                        address: geoObject.name,
                        displayName: geoObject.description || geoObject.name
                    };
                }
            } catch (error) {
                console.error('Яндекс геокодинг ошибка:', error.message);
            }
        }

        // Fallback на Nominatim
        if (!result) {
            const response = await axios.get(`${NOMINATIM_URL}/search`, {
                params: {
                    q: address,
                    format: 'json',
                    limit: 1,
                    addressdetails: 1,
                    'accept-language': 'ru'
                },
                headers: { 'User-Agent': USER_AGENT },
                timeout: 5000
            });

            if (response.data && response.data.length > 0) {
                const item = response.data[0];
                result = {
                    lat: parseFloat(item.lat),
                    lng: parseFloat(item.lon),
                    address: item.display_name,
                    displayName: item.display_name
                };
            }
        }

        if (result) {
            await set(cacheKey, result, CACHE_TTL.geocode);
            res.json({ success: true, ...result });
        } else {
            res.status(404).json({ error: 'Адрес не найден' });
        }
    } catch (error) {
        console.error('Ошибка геокодирования:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ОБРАТНОЕ ГЕОКОДИРОВАНИЕ (КООРДИНАТЫ → АДРЕС)
// ============================================

async function reverseGeocode(req, res) {
    const { lat, lng } = req.query;

    if (!lat || !lng) {
        return res.status(400).json({ error: 'Координаты обязательны' });
    }

    try {
        const cacheKey = `reverse:${lat}:${lng}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }

        let result = null;

        if (config.maps.yandexApiKey) {
            try {
                const response = await axios.get('https://geocode-maps.yandex.ru/1.x', {
                    params: {
                        apikey: config.maps.yandexApiKey,
                        geocode: `${lng},${lat}`,
                        format: 'json',
                        lang: 'ru_RU'
                    },
                    timeout: 5000
                });

                const geoObject = response.data?.response?.GeoObjectCollection?.featureMember?.[0]?.GeoObject;
                if (geoObject) {
                    result = {
                        address: geoObject.name,
                        displayName: geoObject.description || geoObject.name
                    };
                }
            } catch (error) {
                console.error('Яндекс обратный геокодинг ошибка:', error.message);
            }
        }

        if (!result) {
            const response = await axios.get(`${NOMINATIM_URL}/reverse`, {
                params: {
                    lat: lat,
                    lon: lng,
                    format: 'json',
                    zoom: 18,
                    addressdetails: 1,
                    'accept-language': 'ru'
                },
                headers: { 'User-Agent': USER_AGENT },
                timeout: 5000
            });

            if (response.data) {
                result = {
                    address: response.data.display_name,
                    displayName: response.data.display_name,
                    city: response.data.address?.city || response.data.address?.town || response.data.address?.village,
                    street: response.data.address?.road,
                    house: response.data.address?.house_number
                };
            }
        }

        if (result) {
            await set(cacheKey, result, CACHE_TTL.reverse);
            res.json({ success: true, ...result });
        } else {
            res.status(404).json({ error: 'Адрес не найден' });
        }
    } catch (error) {
        console.error('Ошибка обратного геокодирования:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОСТРОЕНИЕ МАРШРУТА
// ============================================

async function getRoute(req, res) {
    const { from_lat, from_lng, to_lat, to_lng, provider = 'yandex' } = req.query;

    if (!from_lat || !from_lng || !to_lat || !to_lng) {
        return res.status(400).json({ error: 'Координаты отправления и назначения обязательны' });
    }

    try {
        const cacheKey = `route:${from_lat}:${from_lng}:${to_lat}:${to_lng}:${provider}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }

        let routeUrl = '';
        let distance = null;
        let duration = null;

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

        // Рассчитываем расстояние
        distance = calculateDistance(
            parseFloat(from_lat), parseFloat(from_lng),
            parseFloat(to_lat), parseFloat(to_lng)
        );
        
        // Примерная длительность (скорость 50 км/ч)
        duration = Math.round(distance / 50 * 60);

        const response = {
            url: routeUrl,
            provider,
            from: { lat: parseFloat(from_lat), lng: parseFloat(from_lng) },
            to: { lat: parseFloat(to_lat), lng: parseFloat(to_lng) },
            distance: Math.round(distance * 10) / 10,
            duration,
            durationText: duration > 60 ? `${Math.floor(duration / 60)} ч ${duration % 60} мин` : `${duration} мин`
        };

        await set(cacheKey, response, CACHE_TTL.route);
        res.json({ success: true, ...response });
    } catch (error) {
        console.error('Ошибка построения маршрута:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОИСК ГОРОДОВ
// ============================================

async function searchCities(req, res) {
    const { q, limit = 10 } = req.query;

    if (!q || q.length < 2) {
        return res.json({ success: true, cities: POPULAR_CITIES.slice(0, limit) });
    }

    try {
        const cacheKey = `cities:${q}:${limit}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, cities: cached, fromCache: true });
        }

        // Сначала ищем в локальном списке
        const localMatches = POPULAR_CITIES.filter(city =>
            city.name.toLowerCase().includes(q.toLowerCase())
        );

        let results = [...localMatches];

        if (results.length < limit) {
            try {
                const response = await axios.get(`${NOMINATIM_URL}/search`, {
                    params: {
                        q: q,
                        format: 'json',
                        limit: limit - results.length,
                        countrycodes: 'ru,kz,by,ua',
                        addressdetails: 1,
                        'accept-language': 'ru'
                    },
                    headers: { 'User-Agent': USER_AGENT },
                    timeout: 5000
                });

                const externalCities = response.data.map(item => ({
                    name: item.display_name.split(',')[0],
                    lat: parseFloat(item.lat),
                    lng: parseFloat(item.lon),
                    country: item.address?.country
                }));

                results = [...results, ...externalCities];
            } catch (error) {
                console.error('Nominatim поиск городов ошибка:', error.message);
            }
        }

        // Убираем дубликаты
        const uniqueCities = [];
        const names = new Set();
        for (const city of results) {
            if (!names.has(city.name)) {
                names.add(city.name);
                uniqueCities.push(city);
            }
        }

        const finalResults = uniqueCities.slice(0, limit);
        await set(cacheKey, finalResults, CACHE_TTL.cities);
        res.json({ success: true, cities: finalResults });
    } catch (error) {
        console.error('Ошибка поиска городов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= ПОЛУЧЕНИЕ ПОПУЛЯРНЫХ ГОРОДОВ
// ============================================

async function getPopularCities(req, res) {
    const { limit = 20 } = req.query;
    
    try {
        const cities = POPULAR_CITIES.slice(0, parseInt(limit));
        res.json({ success: true, cities });
    } catch (error) {
        console.error('Ошибка получения популярных городов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= ПОДСКАЗКИ АДРЕСОВ
// ============================================

async function getAddressSuggestions(req, res) {
    const { q, limit = 10 } = req.query;

    if (!q || q.length < 3) {
        return res.json({ success: true, suggestions: [] });
    }

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
            timeout: 5000
        });

        const suggestions = response.data.map(item => ({
            address: item.display_name,
            lat: parseFloat(item.lat),
            lon: parseFloat(item.lon),
            importance: item.importance
        }));

        res.json({ success: true, suggestions });
    } catch (error) {
        console.error('Ошибка подсказок адресов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    getMarkers,
    clusterMarkers,
    geocodeAddress,
    reverseGeocode,
    getRoute,
    searchCities,
    getPopularCities,
    getAddressSuggestions,
    calculateDistance,
    isWithinRadius,
    POPULAR_CITIES
};