// modules/shared.js
const { Client } = require('pg');
const B2 = require('backblaze-b2');

class SharedModule {
    constructor() {
        this.db = new Client({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
        });
        
        this.b2 = new B2({
            applicationKeyId: process.env.BACKBLAZE_KEY_ID,
            applicationKey: process.env.BACKBLAZE_APPLICATION_KEY
        });
        
        this.b2Authorized = false;
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
        if (!this.b2Authorized) {
            await this.b2.authorize();
            this.b2Authorized = true;
            console.log('✅ Backblaze B2 авторизован');
        }
    }

    async uploadToB2(fileBuffer, filename) {
        await this.authorizeB2();
        const response = await this.b2.getUploadUrl({ 
            bucketId: process.env.BACKBLAZE_BUCKET_ID 
        });
        
        const result = await this.b2.uploadFile({
            uploadUrl: response.data.uploadUrl,
            uploadAuthToken: response.data.authorizationToken,
            fileName: filename,
            fileBuffer: fileBuffer,
            contentType: 'application/octet-stream'
        });
        
        return `https://f004.backblazeb2.com/file/${process.env.BACKBLAZE_BUCKET_NAME}/${encodeURIComponent(filename)}`;
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

            // Таблица портфолио (для нового модуля)
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