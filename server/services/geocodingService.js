/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/services/geocodingService.js
 * Описание: Геокодинг (адрес → координаты, координаты → адрес), поиск городов, расчёт расстояний
 */

const axios = require('axios');
const { get, set, del } = require('../../config/redis');
const { config } = require('../../config/env');

// ============================================
// КОНФИГУРАЦИЯ
// ============================================

// OpenStreetMap Nominatim (бесплатный геокодер)
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'AIDA/3.0 (https://aida.ru)';

// Яндекс.Карты (опционально, если нужны платные функции)
const YANDEX_MAPS_URL = 'https://geocode-maps.yandex.ru/1.x';

// Кеширование
const CACHE_TTL = {
    geocode: 86400,     // 24 часа (адрес → координаты)
    reverse: 86400,     // 24 часа (координаты → адрес)
    city: 3600,         // 1 час (поиск городов)
    distance: 3600      // 1 час (расчёт расстояния)
};

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
// ГЕОКОДИНГ (АДРЕС → КООРДИНАТЫ)
// ============================================

/**
 * Преобразование адреса в координаты
 * @param {string} address - адрес
 * @param {string} provider - провайдер (nominatim, yandex)
 * @returns {Promise<Object>} - координаты { lat, lng, address, displayName }
 */
async function geocode(address, provider = 'nominatim') {
    if (!address || address.trim().length < 3) {
        return null;
    }
    
    const cacheKey = `geocode:${address}:${provider}`;
    const cached = await get(cacheKey);
    if (cached) {
        return cached;
    }
    
    try {
        let result = null;
        
        if (provider === 'yandex' && config.maps.yandexApiKey) {
            result = await geocodeYandex(address);
        } else {
            result = await geocodeNominatim(address);
        }
        
        if (result) {
            await set(cacheKey, result, CACHE_TTL.geocode);
        }
        
        return result;
    } catch (error) {
        console.error('Ошибка геокодирования:', error);
        return null;
    }
}

/**
 * Геокодинг через OpenStreetMap Nominatim
 * @param {string} address - адрес
 * @returns {Promise<Object>} - координаты
 */
async function geocodeNominatim(address) {
    const response = await axios.get(`${NOMINATIM_URL}/search`, {
        params: {
            q: address,
            format: 'json',
            limit: 1,
            addressdetails: 1,
            'accept-language': 'ru'
        },
        headers: {
            'User-Agent': USER_AGENT
        },
        timeout: 5000
    });
    
    if (response.data && response.data.length > 0) {
        const item = response.data[0];
        return {
            lat: parseFloat(item.lat),
            lng: parseFloat(item.lon),
            address: item.display_name,
            displayName: item.display_name,
            city: item.address?.city || item.address?.town || item.address?.village,
            street: item.address?.road,
            house: item.address?.house_number,
            country: item.address?.country,
            postalCode: item.address?.postcode
        };
    }
    
    return null;
}

/**
 * Геокодинг через Яндекс.Карты
 * @param {string} address - адрес
 * @returns {Promise<Object>} - координаты
 */
async function geocodeYandex(address) {
    if (!config.maps.yandexApiKey) {
        return null;
    }
    
    const response = await axios.get(YANDEX_MAPS_URL, {
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
        return {
            lat: parseFloat(pos[1]),
            lng: parseFloat(pos[0]),
            address: geoObject.name,
            displayName: geoObject.description || geoObject.name,
            city: geoObject.metaDataProperty?.GeocoderMetaData?.AddressDetails?.Country?.AdministrativeArea?.Locality?.LocalityName
        };
    }
    
    return null;
}

// ============================================
// ОБРАТНОЕ ГЕОКОДИРОВАНИЕ (КООРДИНАТЫ → АДРЕС)
// ============================================

/**
 * Преобразование координат в адрес
 * @param {number} lat - широта
 * @param {number} lng - долгота
 * @param {string} provider - провайдер (nominatim, yandex)
 * @returns {Promise<Object>} - адрес
 */
async function reverseGeocode(lat, lng, provider = 'nominatim') {
    if (!lat || !lng) {
        return null;
    }
    
    const cacheKey = `reverse:${lat}:${lng}:${provider}`;
    const cached = await get(cacheKey);
    if (cached) {
        return cached;
    }
    
    try {
        let result = null;
        
        if (provider === 'yandex' && config.maps.yandexApiKey) {
            result = await reverseGeocodeYandex(lat, lng);
        } else {
            result = await reverseGeocodeNominatim(lat, lng);
        }
        
        if (result) {
            await set(cacheKey, result, CACHE_TTL.reverse);
        }
        
        return result;
    } catch (error) {
        console.error('Ошибка обратного геокодирования:', error);
        return null;
    }
}

/**
 * Обратное геокодирование через Nominatim
 * @param {number} lat - широта
 * @param {number} lng - долгота
 * @returns {Promise<Object>} - адрес
 */
async function reverseGeocodeNominatim(lat, lng) {
    const response = await axios.get(`${NOMINATIM_URL}/reverse`, {
        params: {
            lat: lat,
            lon: lng,
            format: 'json',
            zoom: 18,
            addressdetails: 1,
            'accept-language': 'ru'
        },
        headers: {
            'User-Agent': USER_AGENT
        },
        timeout: 5000
    });
    
    if (response.data) {
        return {
            address: response.data.display_name,
            city: response.data.address?.city || response.data.address?.town || response.data.address?.village,
            street: response.data.address?.road,
            house: response.data.address?.house_number,
            country: response.data.address?.country,
            postalCode: response.data.address?.postcode,
            lat: parseFloat(response.data.lat),
            lng: parseFloat(response.data.lon)
        };
    }
    
    return null;
}

/**
 * Обратное геокодирование через Яндекс.Карты
 * @param {number} lat - широта
 * @param {number} lng - долгота
 * @returns {Promise<Object>} - адрес
 */
async function reverseGeocodeYandex(lat, lng) {
    if (!config.maps.yandexApiKey) {
        return null;
    }
    
    const response = await axios.get(YANDEX_MAPS_URL, {
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
        return {
            address: geoObject.name,
            displayName: geoObject.description || geoObject.name,
            city: geoObject.metaDataProperty?.GeocoderMetaData?.AddressDetails?.Country?.AdministrativeArea?.Locality?.LocalityName,
            street: geoObject.metaDataProperty?.GeocoderMetaData?.AddressDetails?.Country?.AdministrativeArea?.Locality?.Thoroughfare?.ThoroughfareName,
            house: geoObject.metaDataProperty?.GeocoderMetaData?.AddressDetails?.Country?.AdministrativeArea?.Locality?.Thoroughfare?.Premise?.PremiseNumber
        };
    }
    
    return null;
}

// ============================================
// ПОИСК ГОРОДОВ
// ============================================

/**
 * Поиск городов по названию
 * @param {string} query - поисковый запрос
 * @param {number} limit - количество результатов
 * @returns {Promise<Array>} - список городов
 */
async function searchCities(query, limit = 10) {
    if (!query || query.length < 2) {
        return POPULAR_CITIES.slice(0, limit);
    }
    
    const cacheKey = `cities:search:${query}:${limit}`;
    const cached = await get(cacheKey);
    if (cached) {
        return cached;
    }
    
    try {
        // Сначала ищем в локальном списке
        const localMatches = POPULAR_CITIES.filter(city =>
            city.name.toLowerCase().includes(query.toLowerCase())
        ).slice(0, limit);
        
        // Если нашли достаточно, возвращаем
        if (localMatches.length >= limit) {
            await set(cacheKey, localMatches, CACHE_TTL.city);
            return localMatches;
        }
        
        // Иначе ищем через Nominatim
        const response = await axios.get(`${NOMINATIM_URL}/search`, {
            params: {
                q: query,
                format: 'json',
                limit: limit,
                countrycodes: 'ru,kz,by,ua',
                addressdetails: 1,
                'accept-language': 'ru'
            },
            headers: {
                'User-Agent': USER_AGENT
            },
            timeout: 5000
        });
        
        const externalCities = response.data.map(item => ({
            name: item.display_name.split(',')[0],
            lat: parseFloat(item.lat),
            lng: parseFloat(item.lon),
            country: item.address?.country
        }));
        
        // Объединяем и убираем дубликаты
        const allCities = [...localMatches, ...externalCities];
        const uniqueCities = [];
        const names = new Set();
        
        for (const city of allCities) {
            if (!names.has(city.name)) {
                names.add(city.name);
                uniqueCities.push(city);
            }
        }
        
        const results = uniqueCities.slice(0, limit);
        await set(cacheKey, results, CACHE_TTL.city);
        
        return results;
    } catch (error) {
        console.error('Ошибка поиска городов:', error);
        return POPULAR_CITIES.slice(0, limit);
    }
}

/**
 * Получение популярных городов
 * @param {number} limit - количество результатов
 * @returns {Promise<Array>} - список популярных городов
 */
async function getPopularCities(limit = 20) {
    return POPULAR_CITIES.slice(0, limit);
}

/**
 * Получение города по координатам
 * @param {number} lat - широта
 * @param {number} lng - долгота
 * @returns {Promise<string>} - название города
 */
async function getCityByCoords(lat, lng) {
    const address = await reverseGeocode(lat, lng);
    return address?.city || null;
}

// ============================================
// РАСЧЁТ РАССТОЯНИЙ
// ============================================

/**
 * Расчёт расстояния между двумя точками (формула гаверсинуса)
 * @param {number} lat1 - широта точки 1
 * @param {number} lng1 - долгота точки 1
 * @param {number} lat2 - широта точки 2
 * @param {number} lng2 - долгота точки 2
 * @returns {number} - расстояние в километрах
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // Радиус Земли в км
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

/**
 * Проверка, находится ли точка в радиусе
 * @param {number} lat - широта точки
 * @param {number} lng - долгота точки
 * @param {number} centerLat - широта центра
 * @param {number} centerLng - долгота центра
 * @param {number} radiusKm - радиус в км
 * @returns {boolean} - результат проверки
 */
function isWithinRadius(lat, lng, centerLat, centerLng, radiusKm) {
    const distance = calculateDistance(lat, lng, centerLat, centerLng);
    return distance <= radiusKm;
}

/**
 * Получение координат центра города
 * @param {string} cityName - название города
 * @returns {Promise<Object>} - координаты { lat, lng }
 */
async function getCityCoordinates(cityName) {
    // Ищем в популярных городах
    const city = POPULAR_CITIES.find(c => c.name.toLowerCase() === cityName.toLowerCase());
    if (city) {
        return { lat: city.lat, lng: city.lng };
    }
    
    // Ищем через геокодинг
    const result = await geocode(cityName);
    if (result) {
        return { lat: result.lat, lng: result.lng };
    }
    
    return null;
}

// ============================================
// ВАЛИДАЦИЯ КООРДИНАТ
// ============================================

/**
 * Проверка валидности координат
 * @param {number} lat - широта
 * @param {number} lng - долгота
 * @returns {boolean} - результат проверки
 */
function isValidCoordinates(lat, lng) {
    return lat !== null && lng !== null &&
           !isNaN(lat) && !isNaN(lng) &&
           lat >= -90 && lat <= 90 &&
           lng >= -180 && lng <= 180;
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    // Геокодинг
    geocode,
    geocodeNominatim,
    geocodeYandex,
    
    // Обратное геокодирование
    reverseGeocode,
    reverseGeocodeNominatim,
    reverseGeocodeYandex,
    
    // Города
    searchCities,
    getPopularCities,
    getCityByCoords,
    getCityCoordinates,
    
    // Расстояния
    calculateDistance,
    isWithinRadius,
    
    // Валидация
    isValidCoordinates,
    
    // Данные
    POPULAR_CITIES,
    CACHE_TTL
};