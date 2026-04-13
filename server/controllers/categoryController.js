/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/controllers/categoryController.js
 * Описание: Контроллер категорий (дерево, подкатегории, поиск, администрирование)
 */

const { Category, Listing } = require('../models');
const { get, set, del } = require('../../config/redis');
const { config } = require('../../config/env');

// ============================================
// КОНСТАНТЫ
// ============================================

const CACHE_TTL = {
    categories: 3600,      // 1 час
    tree: 3600,            // 1 час
    popular: 3600,         // 1 час
    category: 3600,        // 1 час
    path: 3600             // 1 час
};

// Иконки для категорий по умолчанию
const DEFAULT_ICONS = {
    'Транспорт': '🚗',
    'Автомобили': '🚙',
    'Мотоциклы': '🏍️',
    'Грузовики': '🚛',
    'Водный транспорт': '⛵',
    'Запчасти': '🔧',
    'Недвижимость': '🏠',
    'Квартиры': '🏢',
    'Дома': '🏡',
    'Коммерческая': '🏪',
    'Земля': '🌾',
    'Работа': '💼',
    'Ищу работу': '👨‍💻',
    'Ищу сотрудника': '👥',
    'Услуги': '🔨',
    'Ремонт': '🛠️',
    'Строительство': '🏗️',
    'Красота': '💅',
    'Здоровье': '💪',
    'Обучение': '📚',
    'Перевозки': '🚚',
    'Уборка': '🧹',
    'Фото': '📸',
    'Праздники': '🎉',
    'Юрист': '⚖️',
    'Бухгалтер': '📊',
    'Личные вещи': '👕',
    'Одежда': '👗',
    'Обувь': '👟',
    'Детские товары': '🧸',
    'Для дома': '🛋️',
    'Мебель': '🪑',
    'Техника': '📺',
    'Электроника': '📱',
    'Телефоны': '📱',
    'Ноутбуки': '💻',
    'Планшеты': '📟',
    'Компьютеры': '🖥️',
    'Аудио': '🎧',
    'Фототехника': '📷',
    'Игры': '🎮',
    'Хобби': '🎮',
    'Спорт': '⚽',
    'Велосипеды': '🚲',
    'Туризм': '🏕️',
    'Охота': '🎣',
    'Книги': '📚',
    'Музыка': '🎸',
    'Коллекционирование': '🖼️',
    'Животные': '🐕',
    'Собаки': '🐕',
    'Кошки': '🐱',
    'Птицы': '🐦',
    'Аквариум': '🐠',
    'Грызуны': '🐹',
    'Товары для животных': '🦴',
    'Бизнес': '🏭',
    'Оборудование': '🏭',
    'Франшизы': '📄',
    'Готовый бизнес': '💼',
    'ПО': '💿'
};

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

/**
 * Рекурсивное построение дерева категорий
 * @param {Array} categories - плоский список категорий
 * @param {number|null} parentId - ID родителя
 * @returns {Array} - дерево категорий
 */
function buildCategoryTree(categories, parentId = null) {
    const tree = [];
    for (const category of categories) {
        if (category.parent_id === parentId) {
            const children = buildCategoryTree(categories, category.id);
            if (children.length > 0) {
                category.children = children;
                category.has_children = true;
            } else {
                category.has_children = false;
            }
            tree.push(category);
        }
    }
    return tree;
}

/**
 * Рекурсивное получение всех подкатегорий
 * @param {number} categoryId - ID категории
 * @param {Array} categories - все категории
 * @returns {Array} - массив ID подкатегорий
 */
function getAllSubcategoryIds(categoryId, categories) {
    const result = [categoryId];
    const children = categories.filter(c => c.parent_id === categoryId);
    for (const child of children) {
        result.push(...getAllSubcategoryIds(child.id, categories));
    }
    return result;
}

/**
 * Получение иконки для категории
 * @param {string} name - название категории
 * @returns {string} - иконка
 */
function getCategoryIcon(name) {
    return DEFAULT_ICONS[name] || '📁';
}

/**
 * Генерация slug из названия
 * @param {string} name - название
 * @returns {string} - slug
 */
function generateSlug(name) {
    return name
        .toLowerCase()
        .replace(/[^a-zа-яё0-9\s]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 100);
}

// ============================================
// ПОЛУЧЕНИЕ ВСЕХ КАТЕГОРИЙ (ПЛОСКИЙ СПИСОК)
// ============================================

async function getAllCategories(req, res) {
    try {
        const cached = await get('categories:list');
        if (cached) {
            return res.json({ success: true, categories: cached, fromCache: true });
        }
        
        const categories = await Category.findAll();
        await set('categories:list', categories, CACHE_TTL.categories);
        
        res.json({ success: true, categories });
    } catch (error) {
        console.error('Ошибка получения категорий:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОЛУЧЕНИЕ ДЕРЕВА КАТЕГОРИЙ
// ============================================

async function getCategoryTree(req, res) {
    try {
        const cached = await get('categories:tree');
        if (cached) {
            return res.json({ success: true, tree: cached, fromCache: true });
        }
        
        const categories = await Category.findAll();
        
        // Добавляем иконки и количество объявлений
        const categoriesWithData = await Promise.all(categories.map(async (cat) => {
            const countResult = await Category.query(
                `SELECT COUNT(*) FROM listings WHERE category_id = $1 AND status = 'active'`,
                [cat.id]
            );
            return {
                ...cat,
                icon: cat.icon || getCategoryIcon(cat.name),
                listings_count: parseInt(countResult.rows[0].count)
            };
        }));
        
        const tree = buildCategoryTree(categoriesWithData);
        await set('categories:tree', tree, CACHE_TTL.tree);
        
        res.json({ success: true, tree });
    } catch (error) {
        console.error('Ошибка получения дерева категорий:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОЛУЧЕНИЕ КАТЕГОРИИ ПО ID
// ============================================

async function getCategoryById(req, res) {
    const { id } = req.params;
    
    try {
        const cacheKey = `category:${id}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, category: cached, fromCache: true });
        }
        
        const category = await Category.findById(parseInt(id));
        if (!category) {
            return res.status(404).json({ error: 'Категория не найдена' });
        }
        
        // Добавляем иконку и количество объявлений
        const countResult = await Category.query(
            `SELECT COUNT(*) FROM listings WHERE category_id = $1 AND status = 'active'`,
            [category.id]
        );
        
        const categoryWithData = {
            ...category,
            icon: category.icon || getCategoryIcon(category.name),
            listings_count: parseInt(countResult.rows[0].count)
        };
        
        await set(cacheKey, categoryWithData, CACHE_TTL.category);
        
        res.json({ success: true, category: categoryWithData });
    } catch (error) {
        console.error('Ошибка получения категории:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОЛУЧЕНИЕ КАТЕГОРИИ ПО SLUG
// ============================================

async function getCategoryBySlug(req, res) {
    const { slug } = req.params;
    
    try {
        const cacheKey = `category:slug:${slug}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, category: cached, fromCache: true });
        }
        
        const category = await Category.findBySlug(slug);
        if (!category) {
            return res.status(404).json({ error: 'Категория не найдена' });
        }
        
        const countResult = await Category.query(
            `SELECT COUNT(*) FROM listings WHERE category_id = $1 AND status = 'active'`,
            [category.id]
        );
        
        const categoryWithData = {
            ...category,
            icon: category.icon || getCategoryIcon(category.name),
            listings_count: parseInt(countResult.rows[0].count)
        };
        
        await set(cacheKey, categoryWithData, CACHE_TTL.category);
        
        res.json({ success: true, category: categoryWithData });
    } catch (error) {
        console.error('Ошибка получения категории по slug:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОЛУЧЕНИЕ ПУТИ КАТЕГОРИИ (ХЛЕБНЫЕ КРОШКИ)
// ============================================

async function getCategoryPath(req, res) {
    const { id } = req.params;
    
    try {
        const cacheKey = `category:path:${id}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, path: cached, fromCache: true });
        }
        
        const { path } = await Category.findByIdWithPath(parseInt(id));
        await set(cacheKey, path, CACHE_TTL.path);
        
        res.json({ success: true, path });
    } catch (error) {
        console.error('Ошибка получения пути категории:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОЛУЧЕНИЕ ПОДКАТЕГОРИЙ
// ============================================

async function getSubcategories(req, res) {
    const { id } = req.params;
    
    try {
        const children = await Category.getChildren(parseInt(id));
        
        // Добавляем иконки и количество объявлений
        const childrenWithData = await Promise.all(children.map(async (cat) => {
            const countResult = await Category.query(
                `SELECT COUNT(*) FROM listings WHERE category_id = $1 AND status = 'active'`,
                [cat.id]
            );
            return {
                ...cat,
                icon: cat.icon || getCategoryIcon(cat.name),
                listings_count: parseInt(countResult.rows[0].count)
            };
        }));
        
        res.json({ success: true, subcategories: childrenWithData });
    } catch (error) {
        console.error('Ошибка получения подкатегорий:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОЛУЧЕНИЕ ОБЪЯВЛЕНИЙ В КАТЕГОРИИ
// ============================================

async function getCategoryListings(req, res) {
    const { id } = req.params;
    const { limit = 20, cursor, price_min, price_max, sort = 'created_desc', include_subcategories = 'true' } = req.query;
    
    try {
        const category = await Category.findById(parseInt(id));
        if (!category) {
            return res.status(404).json({ error: 'Категория не найдена' });
        }
        
        let categoryIds = [parseInt(id)];
        
        // Включаем подкатегории если нужно
        if (include_subcategories === 'true') {
            const allCategories = await Category.findAll();
            categoryIds = getAllSubcategoryIds(parseInt(id), allCategories);
        }
        
        const filters = {
            categoryId: categoryIds,
            priceMin: price_min ? parseInt(price_min) : null,
            priceMax: price_max ? parseInt(price_max) : null,
            sort
        };
        
        const { listings, nextCursor, hasMore } = await Listing.search(filters, parseInt(limit), cursor);
        
        // Добавляем информацию об избранном для авторизованных пользователей
        if (req.user && listings.length > 0) {
            for (const listing of listings) {
                const isFavorite = await Category.query(
                    `SELECT 1 FROM favorites WHERE user_id = $1 AND listing_id = $2`,
                    [req.user.id, listing.id]
                );
                listing.isFavorite = isFavorite.rows.length > 0;
            }
        }
        
        res.json({
            success: true,
            category,
            listings,
            nextCursor,
            hasMore,
            count: listings.length
        });
    } catch (error) {
        console.error('Ошибка получения объявлений категории:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОИСК КАТЕГОРИЙ
// ============================================

async function searchCategories(req, res) {
    const { q, limit = 10 } = req.query;
    
    if (!q || q.length < 2) {
        return res.json({ success: true, categories: [] });
    }
    
    try {
        const cacheKey = `categories:search:${q}:${limit}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, categories: cached, fromCache: true });
        }
        
        const categories = await Category.findAll();
        const filtered = categories
            .filter(cat => cat.name.toLowerCase().includes(q.toLowerCase()))
            .slice(0, parseInt(limit));
        
        await set(cacheKey, filtered, 3600);
        
        res.json({ success: true, categories: filtered, query: q });
    } catch (error) {
        console.error('Ошибка поиска категорий:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОЛУЧЕНИЕ ПОПУЛЯРНЫХ КАТЕГОРИЙ
// ============================================

async function getPopularCategories(req, res) {
    const { limit = 12 } = req.query;
    
    try {
        const cached = await get('categories:popular');
        if (cached) {
            return res.json({ success: true, categories: cached.slice(0, parseInt(limit)), fromCache: true });
        }
        
        const result = await Category.query(`
            SELECT c.id, c.name, c.slug, c.icon, COUNT(l.id) as listings_count
            FROM categories c
            LEFT JOIN listings l ON l.category_id = c.id AND l.status = 'active'
            WHERE c.parent_id IS NOT NULL
            GROUP BY c.id, c.name, c.slug, c.icon
            ORDER BY listings_count DESC
            LIMIT 20
        `);
        
        const categoriesWithIcons = result.rows.map(cat => ({
            ...cat,
            icon: cat.icon || getCategoryIcon(cat.name)
        }));
        
        await set('categories:popular', categoriesWithIcons, CACHE_TTL.popular);
        
        res.json({ success: true, categories: categoriesWithIcons.slice(0, parseInt(limit)) });
    } catch (error) {
        console.error('Ошибка получения популярных категорий:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОЛУЧЕНИЕ СТАТИСТИКИ КАТЕГОРИИ
// ============================================

async function getCategoryStats(req, res) {
    const { id } = req.params;
    
    try {
        const category = await Category.findById(parseInt(id));
        if (!category) {
            return res.status(404).json({ error: 'Категория не найдена' });
        }
        
        const allCategories = await Category.findAll();
        const categoryIds = getAllSubcategoryIds(parseInt(id), allCategories);
        
        // Общая статистика
        const totalResult = await Category.query(
            `SELECT 
                COUNT(*) as total_listings,
                SUM(views) as total_views,
                AVG(price) as avg_price,
                MIN(price) as min_price,
                MAX(price) as max_price
             FROM listings 
             WHERE category_id = ANY($1::int[]) AND status = 'active'`,
            [categoryIds]
        );
        
        // Статистика по городам
        const citiesResult = await Category.query(
            `SELECT city, COUNT(*) as count
             FROM listings
             WHERE category_id = ANY($1::int[]) AND status = 'active' AND city IS NOT NULL
             GROUP BY city
             ORDER BY count DESC
             LIMIT 10`,
            [categoryIds]
        );
        
        // Статистика по цене (гистограмма)
        const priceHistogram = await Category.query(
            `SELECT 
                width_bucket(price, 0, 1000000, 10) as bucket,
                COUNT(*) as count,
                MIN(price) as min_price,
                MAX(price) as max_price
             FROM listings
             WHERE category_id = ANY($1::int[]) AND status = 'active'
             GROUP BY bucket
             ORDER BY bucket`,
            [categoryIds]
        );
        
        res.json({
            success: true,
            category,
            stats: {
                total_listings: parseInt(totalResult.rows[0].total_listings || 0),
                total_views: parseInt(totalResult.rows[0].total_views || 0),
                avg_price: Math.round(totalResult.rows[0].avg_price || 0),
                min_price: totalResult.rows[0].min_price || 0,
                max_price: totalResult.rows[0].max_price || 0
            },
            top_cities: citiesResult.rows,
            price_histogram: priceHistogram.rows
        });
    } catch (error) {
        console.error('Ошибка получения статистики категории:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// АДМИН-ФУНКЦИИ (только для администраторов)
// ============================================

/**
 * Создание категории (только админ)
 */
async function createCategory(req, res) {
    const { name, parent_id, slug, icon, order_index, description } = req.body;
    
    try {
        const category = await Category.create({
            name,
            parentId: parent_id || null,
            slug: slug || generateSlug(name),
            icon: icon || getCategoryIcon(name),
            orderIndex: order_index || 0,
            description: description || null
        });
        
        // Очищаем кеш
        await del('categories:list');
        await del('categories:tree');
        await del('categories:popular');
        
        res.status(201).json({ success: true, category });
    } catch (error) {
        console.error('Ошибка создания категории:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

/**
 * Обновление категории (только админ)
 */
async function updateCategory(req, res) {
    const { id } = req.params;
    const { name, parent_id, slug, icon, order_index, description } = req.body;
    
    try {
        const updates = {};
        if (name) updates.name = name;
        if (parent_id !== undefined) updates.parent_id = parent_id;
        if (slug) updates.slug = slug;
        if (icon) updates.icon = icon;
        if (order_index !== undefined) updates.order_index = order_index;
        if (description !== undefined) updates.description = description;
        
        const category = await Category.update(parseInt(id), updates);
        
        if (!category) {
            return res.status(404).json({ error: 'Категория не найдена' });
        }
        
        // Очищаем кеш
        await del('categories:list');
        await del('categories:tree');
        await del('categories:popular');
        await del(`category:${id}`);
        await del(`category:slug:${category.slug}`);
        await del(`category:path:${id}`);
        
        res.json({ success: true, category });
    } catch (error) {
        console.error('Ошибка обновления категории:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

/**
 * Удаление категории (только админ)
 */
async function deleteCategory(req, res) {
    const { id } = req.params;
    
    try {
        // Проверяем, есть ли объявления в категории
        const listingsCount = await Category.query(
            `SELECT COUNT(*) FROM listings WHERE category_id = $1`,
            [parseInt(id)]
        );
        
        if (parseInt(listingsCount.rows[0].count) > 0) {
            return res.status(400).json({ 
                error: 'Невозможно удалить категорию с объявлениями. Сначала переместите или удалите объявления.' 
            });
        }
        
        // Проверяем, есть ли подкатегории
        const childrenCount = await Category.query(
            `SELECT COUNT(*) FROM categories WHERE parent_id = $1`,
            [parseInt(id)]
        );
        
        if (parseInt(childrenCount.rows[0].count) > 0) {
            return res.status(400).json({ 
                error: 'Невозможно удалить категорию с подкатегориями. Сначала удалите или переместите подкатегории.' 
            });
        }
        
        await Category.delete(parseInt(id));
        
        // Очищаем кеш
        await del('categories:list');
        await del('categories:tree');
        await del('categories:popular');
        await del(`category:${id}`);
        await del(`category:path:${id}`);
        
        res.json({ success: true, message: 'Категория удалена' });
    } catch (error) {
        console.error('Ошибка удаления категории:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

/**
 * Массовое обновление порядка категорий (только админ)
 */
async function reorderCategories(req, res) {
    const { categories } = req.body; // массив { id, order_index }
    
    if (!categories || !Array.isArray(categories)) {
        return res.status(400).json({ error: 'Неверный формат данных' });
    }
    
    try {
        for (const item of categories) {
            await Category.update(item.id, { order_index: item.order_index });
        }
        
        // Очищаем кеш
        await del('categories:list');
        await del('categories:tree');
        
        res.json({ success: true, message: 'Порядок категорий обновлён' });
    } catch (error) {
        console.error('Ошибка обновления порядка категорий:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    // Публичные методы
    getAllCategories,
    getCategoryTree,
    getCategoryById,
    getCategoryBySlug,
    getCategoryPath,
    getSubcategories,
    getCategoryListings,
    searchCategories,
    getPopularCategories,
    getCategoryStats,
    
    // Админ-методы
    createCategory,
    updateCategory,
    deleteCategory,
    reorderCategories,
    
    // Вспомогательные функции (для использования в других контроллерах)
    buildCategoryTree,
    getAllSubcategoryIds,
    getCategoryIcon,
    generateSlug,
    DEFAULT_ICONS
};