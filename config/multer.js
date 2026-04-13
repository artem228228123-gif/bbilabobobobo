/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: config/multer.js
 * Описание: Настройка загрузки файлов (фото, видео, аватары, документы)
 */

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { config } = require('./env');

// ============================================
// КОНСТАНТЫ
// ============================================

const UPLOAD_DIR = process.env.UPLOAD_PATH || path.join(__dirname, '../uploads');
const TEMP_DIR = path.join(__dirname, '../temp');

// Лимиты по умолчанию
const DEFAULT_LIMITS = {
    photos: {
        fileSize: 10 * 1024 * 1024,  // 10MB
        files: 10
    },
    avatar: {
        fileSize: 5 * 1024 * 1024,   // 5MB
        files: 1
    },
    chat: {
        fileSize: 5 * 1024 * 1024,   // 5MB
        files: 1
    },
    video: {
        fileSize: 100 * 1024 * 1024, // 100MB
        files: 1
    },
    document: {
        fileSize: 10 * 1024 * 1024,  // 10MB
        files: 1
    },
    search: {
        fileSize: 10 * 1024 * 1024,  // 10MB
        files: 1
    }
};

// Создаём необходимые папки
const directories = [
    UPLOAD_DIR,
    TEMP_DIR,
    path.join(UPLOAD_DIR, 'listings'),
    path.join(UPLOAD_DIR, 'avatars'),
    path.join(UPLOAD_DIR, 'chats'),
    path.join(UPLOAD_DIR, 'documents'),
    path.join(UPLOAD_DIR, 'videos'),
    path.join(TEMP_DIR, 'listings'),
    path.join(TEMP_DIR, 'avatars'),
    path.join(TEMP_DIR, 'chats'),
    path.join(TEMP_DIR, 'videos'),
    path.join(TEMP_DIR, 'documents')
];

directories.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// ============================================
// ДОПУСТИМЫЕ MIME-ТИПЫ
// ============================================

const MIME_TYPES = {
    // Изображения
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/svg+xml': 'svg',
    
    // Видео
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'video/x-matroska': 'mkv',
    'video/mpeg': 'mpeg',
    'video/ogg': 'ogv',
    
    // Документы
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'application/rtf': 'rtf',
    'application/zip': 'zip',
    'application/x-rar-compressed': 'rar'
};

// ============================================
// ФИЛЬТРЫ ФАЙЛОВ
// ============================================

/**
 * Фильтр для изображений
 */
const imageFilter = (req, file, cb) => {
    const allowedTypes = [
        'image/jpeg', 'image/jpg', 'image/png', 
        'image/webp', 'image/gif', 'image/heic', 
        'image/heif', 'image/bmp', 'image/tiff'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`Неподдерживаемый формат изображения. Разрешены: JPEG, PNG, WebP, GIF, HEIC, BMP, TIFF`), false);
    }
};

/**
 * Фильтр для видео
 */
const videoFilter = (req, file, cb) => {
    const allowedTypes = [
        'video/mp4', 'video/webm', 'video/quicktime',
        'video/x-msvideo', 'video/x-matroska', 'video/mpeg', 'video/ogg'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`Неподдерживаемый формат видео. Разрешены: MP4, WebM, MOV, AVI, MKV, MPEG, OGV`), false);
    }
};

/**
 * Фильтр для аватаров
 */
const avatarFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    
    if (allowedTypes.includes(file.mimetype)) {
        // Дополнительная проверка соотношения сторон (будет позже)
        cb(null, true);
    } else {
        cb(new Error(`Неподдерживаемый формат аватара. Разрешены: JPEG, PNG, WebP`), false);
    }
};

/**
 * Фильтр для документов
 */
const documentFilter = (req, file, cb) => {
    const allowedTypes = [
        'application/pdf', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain', 'text/csv', 'application/rtf',
        'application/zip', 'application/x-rar-compressed'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`Неподдерживаемый формат документа. Разрешены: PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, TXT, CSV, RTF, ZIP, RAR`), false);
    }
};

/**
 * Фильтр для сообщений в чате
 */
const chatFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`Неподдерживаемый формат. Разрешены: JPEG, PNG, WebP, GIF`), false);
    }
};

/**
 * Фильтр для поиска по фото
 */
const searchPhotoFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`Неподдерживаемый формат. Разрешены: JPEG, PNG, WebP`), false);
    }
};

// ============================================
// НАСТРОЙКИ ХРАНИЛИЩА
// ============================================

/**
 * Генерация уникального имени файла
 */
function generateUniqueFilename(originalName, fieldname) {
    const timestamp = Date.now();
    const random = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(originalName);
    const sanitizedFieldname = fieldname.replace(/[^a-z0-9]/gi, '_');
    return `${sanitizedFieldname}_${timestamp}_${random}${ext}`;
}

/**
 * Временное хранилище (для последующей обработки)
 */
const tempStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        let subDir = 'temp';
        
        // Определяем подпапку по полю и типу
        if (file.fieldname === 'avatar' || file.fieldname === 'avatars') {
            subDir = 'temp/avatars';
        } else if (file.fieldname === 'photos' || file.fieldname === 'new_photos' || file.fieldname === 'listing_photos') {
            subDir = 'temp/listings';
        } else if (file.fieldname === 'photo' || file.fieldname === 'chat_photo') {
            subDir = 'temp/chats';
        } else if (file.fieldname === 'video' || file.fieldname === 'listing_video') {
            subDir = 'temp/videos';
        } else if (file.fieldname === 'document' || file.fieldname === 'resume_file') {
            subDir = 'temp/documents';
        } else if (file.fieldname === 'search_photo') {
            subDir = 'temp/search';
        }
        
        const fullPath = path.join(__dirname, '..', subDir);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
        }
        cb(null, fullPath);
    },
    filename: (req, file, cb) => {
        const uniqueName = generateUniqueFilename(file.originalname, file.fieldname);
        cb(null, uniqueName);
    }
});

/**
 * Постоянное хранилище (для уже обработанных файлов)
 */
const permanentStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        let subDir = 'uploads';
        
        if (file.fieldname === 'avatar' || file.fieldname === 'avatars') {
            subDir = 'uploads/avatars';
        } else if (file.fieldname === 'photos' || file.fieldname === 'new_photos' || file.fieldname === 'listing_photos') {
            subDir = 'uploads/listings';
        } else if (file.fieldname === 'photo' || file.fieldname === 'chat_photo') {
            subDir = 'uploads/chats';
        } else if (file.fieldname === 'video' || file.fieldname === 'listing_video') {
            subDir = 'uploads/videos';
        } else if (file.fieldname === 'document' || file.fieldname === 'resume_file') {
            subDir = 'uploads/documents';
        }
        
        const fullPath = path.join(__dirname, '..', subDir);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
        }
        cb(null, fullPath);
    },
    filename: (req, file, cb) => {
        const uniqueName = generateUniqueFilename(file.originalname, file.fieldname);
        cb(null, uniqueName);
    }
});

// ============================================
// ЭКСПОРТ НАСТРОЕК ЗАГРУЗКИ
// ============================================

/**
 * Загрузка фото для объявлений (до 10 файлов, до 10MB каждый)
 */
const uploadListingPhotos = multer({
    storage: tempStorage,
    limits: {
        fileSize: DEFAULT_LIMITS.photos.fileSize,
        files: DEFAULT_LIMITS.photos.files
    },
    fileFilter: imageFilter
});

/**
 * Загрузка одного фото для объявления (для редактирования)
 */
const uploadListingPhoto = multer({
    storage: tempStorage,
    limits: { fileSize: DEFAULT_LIMITS.photos.fileSize },
    fileFilter: imageFilter
});

/**
 * Загрузка аватара (1 файл, до 5MB)
 */
const uploadAvatar = multer({
    storage: tempStorage,
    limits: { fileSize: DEFAULT_LIMITS.avatar.fileSize },
    fileFilter: avatarFilter
});

/**
 * Загрузка фото в чат (1 файл, до 5MB)
 */
const uploadChatPhoto = multer({
    storage: tempStorage,
    limits: { fileSize: DEFAULT_LIMITS.chat.fileSize },
    fileFilter: chatFilter
});

/**
 * Загрузка видео для объявления (1 файл, до 100MB)
 */
const uploadVideo = multer({
    storage: tempStorage,
    limits: { fileSize: DEFAULT_LIMITS.video.fileSize },
    fileFilter: videoFilter
});

/**
 * Загрузка документа (1 файл, до 10MB)
 */
const uploadDocument = multer({
    storage: tempStorage,
    limits: { fileSize: DEFAULT_LIMITS.document.fileSize },
    fileFilter: documentFilter
});

/**
 * Загрузка фото для поиска по фото (1 файл, до 10MB)
 */
const uploadSearchPhoto = multer({
    storage: tempStorage,
    limits: { fileSize: DEFAULT_LIMITS.search.fileSize },
    fileFilter: searchPhotoFilter
});

/**
 * Загрузка нескольких документов
 */
const uploadMultipleDocuments = multer({
    storage: tempStorage,
    limits: {
        fileSize: DEFAULT_LIMITS.document.fileSize,
        files: 5
    },
    fileFilter: documentFilter
});

/**
 * Загрузка видео и фото вместе (для объявления)
 */
const uploadMediaMixed = multer({
    storage: tempStorage,
    limits: {
        fileSize: DEFAULT_LIMITS.video.fileSize,
        files: 11 // 10 фото + 1 видео
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            imageFilter(req, file, cb);
        } else if (file.mimetype.startsWith('video/')) {
            videoFilter(req, file, cb);
        } else {
            cb(new Error('Неподдерживаемый формат. Разрешены изображения и видео'), false);
        }
    }
});

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

/**
 * Удаление временного файла
 * @param {string} filePath - путь к файлу
 * @returns {boolean}
 */
function removeTempFile(filePath) {
    if (!filePath) return false;
    
    // Если путь относительный, преобразуем в абсолютный
    const absolutePath = filePath.startsWith('/') 
        ? filePath 
        : path.join(__dirname, '..', filePath);
    
    if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath);
        return true;
    }
    return false;
}

/**
 * Удаление нескольких временных файлов
 * @param {Array} filePaths - массив путей
 * @returns {number} - количество удалённых файлов
 */
function removeTempFiles(filePaths) {
    let deleted = 0;
    for (const filePath of filePaths) {
        if (removeTempFile(filePath)) deleted++;
    }
    return deleted;
}

/**
 * Очистка временных файлов старше N часов
 * @param {number} hours - возраст в часах
 * @returns {number} - количество удалённых файлов
 */
function cleanupTempFiles(hours = 24) {
    const now = Date.now();
    const maxAge = hours * 60 * 60 * 1000;
    let deletedCount = 0;
    
    const scanDir = (dir) => {
        if (!fs.existsSync(dir)) return;
        
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const filePath = path.join(dir, file);
            const stats = fs.statSync(filePath);
            
            if (stats.isDirectory()) {
                scanDir(filePath);
                // Удаляем пустую папку
                if (fs.readdirSync(filePath).length === 0) {
                    fs.rmdirSync(filePath);
                }
            } else if (now - stats.mtimeMs > maxAge) {
                fs.unlinkSync(filePath);
                deletedCount++;
            }
        }
    };
    
    scanDir(TEMP_DIR);
    console.log(`🧹 Очищено временных файлов: ${deletedCount}`);
    return deletedCount;
}

/**
 * Получение MIME-типа по расширению
 * @param {string} ext - расширение файла
 * @returns {string} - MIME-тип
 */
function getMimeType(ext) {
    const mimeMap = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.heic': 'image/heic',
        '.bmp': 'image/bmp',
        '.tiff': 'image/tiff',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.mkv': 'video/x-matroska',
        '.mpeg': 'video/mpeg',
        '.ogv': 'video/ogg',
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.ppt': 'application/vnd.ms-powerpoint',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.txt': 'text/plain',
        '.csv': 'text/csv',
        '.rtf': 'application/rtf',
        '.zip': 'application/zip',
        '.rar': 'application/x-rar-compressed'
    };
    return mimeMap[ext.toLowerCase()] || 'application/octet-stream';
}

/**
 * Проверка, является ли файл изображением
 * @param {Object} file - файл multer
 * @returns {boolean}
 */
function isImage(file) {
    return file.mimetype && file.mimetype.startsWith('image/');
}

/**
 * Проверка, является ли файл видео
 * @param {Object} file - файл multer
 * @returns {boolean}
 */
function isVideo(file) {
    return file.mimetype && file.mimetype.startsWith('video/');
}

/**
 * Проверка, является ли файл документом
 * @param {Object} file - файл multer
 * @returns {boolean}
 */
function isDocument(file) {
    const docTypes = [
        'application/pdf', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain', 'text/csv', 'application/rtf'
    ];
    return file.mimetype && docTypes.includes(file.mimetype);
}

/**
 * Получение размера файла в удобном формате
 * @param {number} bytes - размер в байтах
 * @returns {string}
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Валидация файла перед загрузкой
 * @param {Object} file - файл
 * @param {Object} options - опции валидации
 * @returns {Object} - результат валидации
 */
function validateFile(file, options = {}) {
    const { maxSize, allowedTypes, required = false } = options;
    const errors = [];
    
    if (required && !file) {
        errors.push('Файл обязателен');
        return { valid: false, errors };
    }
    
    if (!file) return { valid: true, errors: [] };
    
    if (maxSize && file.size > maxSize) {
        errors.push(`Файл слишком большой. Максимум ${formatFileSize(maxSize)}`);
    }
    
    if (allowedTypes && !allowedTypes.includes(file.mimetype)) {
        errors.push(`Неподдерживаемый формат. Разрешены: ${allowedTypes.join(', ')}`);
    }
    
    return { valid: errors.length === 0, errors };
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    // Middleware для загрузки
    uploadListingPhotos,
    uploadListingPhoto,
    uploadAvatar,
    uploadChatPhoto,
    uploadVideo,
    uploadDocument,
    uploadSearchPhoto,
    uploadMultipleDocuments,
    uploadMediaMixed,
    
    // Фильтры
    imageFilter,
    videoFilter,
    avatarFilter,
    documentFilter,
    chatFilter,
    searchPhotoFilter,
    
    // Хранилища
    tempStorage,
    permanentStorage,
    
    // Утилиты
    removeTempFile,
    removeTempFiles,
    cleanupTempFiles,
    getMimeType,
    isImage,
    isVideo,
    isDocument,
    formatFileSize,
    validateFile,
    generateUniqueFilename,
    
    // Константы
    UPLOAD_DIR,
    TEMP_DIR,
    MIME_TYPES,
    DEFAULT_LIMITS
};