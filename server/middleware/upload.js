/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/middleware/upload.js
 * Описание: Middleware для загрузки файлов (обёртка над multer)
 */

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ============================================
// КОНСТАНТЫ
// ============================================

const UPLOAD_DIR = process.env.UPLOAD_PATH || path.join(__dirname, '../../uploads');
const TEMP_DIR = path.join(__dirname, '../../temp');

// Создаём директории
const directories = [
    UPLOAD_DIR,
    TEMP_DIR,
    path.join(UPLOAD_DIR, 'listings'),
    path.join(UPLOAD_DIR, 'avatars'),
    path.join(UPLOAD_DIR, 'chats'),
    path.join(UPLOAD_DIR, 'documents'),
    path.join(TEMP_DIR, 'listings'),
    path.join(TEMP_DIR, 'avatars'),
    path.join(TEMP_DIR, 'chats')
];

directories.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// ============================================
= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

function generateUniqueFilename(originalName) {
    const timestamp = Date.now();
    const random = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(originalName);
    return `${timestamp}_${random}${ext}`;
}

// ============================================
= ФИЛЬТРЫ
// ============================================

const imageFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Неподдерживаемый формат изображения. Разрешены: JPEG, PNG, WebP, GIF'), false);
    }
};

const avatarFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Неподдерживаемый формат аватара. Разрешены: JPEG, PNG, WebP'), false);
    }
};

const chatFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Неподдерживаемый формат. Разрешены: JPEG, PNG, WebP, GIF'), false);
    }
};

const videoFilter = (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/webm', 'video/quicktime'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Неподдерживаемый формат видео. Разрешены: MP4, WebM, MOV'), false);
    }
};

// ============================================
= ХРАНИЛИЩА
// ============================================

const tempStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        let subDir = 'temp';
        
        if (file.fieldname === 'avatar' || file.fieldname === 'avatars') {
            subDir = 'temp/avatars';
        } else if (file.fieldname === 'photos' || file.fieldname === 'new_photos') {
            subDir = 'temp/listings';
        } else if (file.fieldname === 'photo') {
            subDir = 'temp/chats';
        } else if (file.fieldname === 'video') {
            subDir = 'temp/videos';
        }
        
        const fullPath = path.join(__dirname, '../..', subDir);
        if (!fs.existsSync(fullPath