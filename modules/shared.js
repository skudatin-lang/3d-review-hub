// modules/shared.js - ИСПРАВЛЕННАЯ ВЕРСИЯ
const { Client } = require('pg');
const B2 = require('backblaze-b2');
const fs = require('fs');
const path = require('path');

class SharedModule {
    constructor() {
        this.db = new Client({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
        });
        
        // Инициализация B2 только если есть ключи
        if (process.env.BACKBLAZE_KEY_ID && process.env.BACKBLAZE_APPLICATION_KEY) {
            this.b2 = new B2({
                applicationKeyId: process.env.BACKBLAZE_KEY_ID,
                applicationKey: process.env.BACKBLAZE_APPLICATION_KEY
            });
            console.log('✅ Backblaze B2 инициализирован');
        } else {
            console.log('⚠️  Backblaze B2 не настроен, используем локальное хранилище');
            this.b2 = null;
        }
        
        this.b2Authorized = false;
        
        // Создаем папку для локального хранения
        this.uploadsDir = path.join(__dirname, '..', 'uploads');
        if (!fs.existsSync(this.uploadsDir)) {
            fs.mkdirSync(this.uploadsDir, { recursive: true });
            console.log('✅ Папка uploads создана');
        }
    }

    async connectDB() {
        try {
            await this.db.connect();
            console.log('✅ PostgreSQL подключен');
        } catch (error) {
            console.error('❌ Ошибка подключения к PostgreSQL:', error.message);
            throw error;
        }
    }

    async authorizeB2() {
        if (!this.b2) {
            throw new Error('Backblaze B2 не настроен');
        }
        
        if (!this.b2Authorized) {
            await this.b2.authorize();
            this.b2Authorized = true;
            console.log('✅ Backblaze B2 авторизован');
        }
    }

    async uploadToB2(fileBuffer, filename) {
        // Если B2 не настроен, сохраняем локально
        if (!this.b2) {
            return this.saveFileLocally(fileBuffer, filename);
        }

        try {
            await this.authorizeB2();
            const response = await this.b2.getUploadUrl({ 
                bucketId: process.env.BACKBLAZE_BUCKET_ID 
            });
            
            const result = await this.b2.uploadFile({
                uploadUrl: response.data.uploadUrl,
                uploadAuthToken: response.data.authorizationToken,
                fileName: filename,
                data: fileBuffer,
                contentType: 'application/octet-stream'
            });
            
            console.log('✅ Файл загружен в Backblaze B2:', filename);
            return `https://f004.backblazeb2.com/file/${process.env.BACKBLAZE_BUCKET_NAME}/${filename}`;
        } catch (error) {
            console.error('❌ Ошибка загрузки в B2, сохраняем локально:', error.message);
            return this.saveFileLocally(fileBuffer, filename);
        }
    }

    async saveFileLocally(fileBuffer, filename) {
        const filePath = path.join(this.uploadsDir, filename);
        fs.writeFileSync(filePath, fileBuffer);
        
        console.log('✅ Файл сохранен локально:', filename);
        return `/uploads/${filename}`;
    }

    async initializeDatabase() {
        try {
            // Таблица пользователей
            await this.db.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    email TEXT UNIQUE NOT NULL,
                    password TEXT NOT NULL,
                    name TEXT NOT NULL,
                    plan TEXT DEFAULT 'free',
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );
            `);

            // Таблица проектов
            await this.db.query(`
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    description TEXT,
                    model_url TEXT NOT NULL,
                    original_name TEXT,
                    share_url TEXT,
                    password TEXT,
                    mode TEXT DEFAULT 'individual',
                    status TEXT DEFAULT 'active',
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    expires_at TIMESTAMPTZ NOT NULL
                );
            `);

            // Таблица сессий
            await this.db.query(`
                CREATE TABLE IF NOT EXISTS user_sessions (
                    sid VARCHAR NOT NULL PRIMARY KEY,
                    sess JSON NOT NULL,
                    expire TIMESTAMPTZ NOT NULL
                );
            `);

            // Таблица портфолио
            await this.db.query(`
                CREATE TABLE IF NOT EXISTS portfolio_items (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    description TEXT,
                    image_url TEXT,
                    model_url TEXT,
                    category TEXT,
                    tags TEXT[],
                    is_public BOOLEAN DEFAULT false,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                );
            `);

            console.log('✅ Все таблицы созданы/проверены');
        } catch (error) {
            console.error('❌ Ошибка инициализации БД:', error.message);
            throw error;
        }
    }
}

module.exports = new SharedModule();