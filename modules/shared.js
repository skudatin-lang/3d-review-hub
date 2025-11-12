// modules/shared.js - ПРОФЕССИОНАЛЬНАЯ ВЕРСИЯ
const { Client } = require('pg');
const B2 = require('backblaze-b2');
const fs = require('fs');
const path = require('path');

class SharedModule {
    constructor() {
        this.db = new Client({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        
        // Backblaze B2 - ОБЯЗАТЕЛЬНО
        this.b2 = new B2({
            applicationKeyId: process.env.BACKBLAZE_KEY_ID,
            applicationKey: process.env.BACKBLAZE_APPLICATION_KEY
        });
        
        this.b2Authorized = false;
        console.log('✅ Backblaze B2 инициализирован');
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
            try {
                const response = await this.b2.authorize();
                console.log('✅ Backblaze B2 авторизован');
                this.b2Authorized = true;
            } catch (error) {
                console.error('❌ Ошибка авторизации Backblaze B2:');
                console.error('Проверьте BACKBLAZE_KEY_ID и BACKBLAZE_APPLICATION_KEY в .env');
                console.error('Ошибка:', error.message);
                throw error;
            }
        }
    }

    async uploadToB2(fileBuffer, filename) {
        try {
            await this.authorizeB2();
            
            // Получаем URL для загрузки
            const uploadUrlResponse = await this.b2.getUploadUrl({
                bucketId: process.env.BACKBLAZE_BUCKET_ID
            });
            
            console.log('📤 Загрузка файла в Backblaze B2:', filename);
            
            // Загружаем файл
            const uploadResponse = await this.b2.uploadFile({
                uploadUrl: uploadUrlResponse.data.uploadUrl,
                uploadAuthToken: uploadUrlResponse.data.authorizationToken,
                fileName: filename,
                data: fileBuffer,
                contentType: 'application/octet-stream'
            });
            
            // Возвращаем публичный URL
            const publicUrl = `https://f004.backblazeb2.com/file/${process.env.BACKBLAZE_BUCKET_NAME}/${filename}`;
            console.log('✅ Файл загружен в Backblaze B2:', publicUrl);
            
            return publicUrl;
            
        } catch (error) {
            console.error('❌ Ошибка загрузки в Backblaze B2:');
            console.error('Проверьте BACKBLAZE_BUCKET_ID и BACKBLAZE_BUCKET_NAME');
            console.error('Ошибка:', error.response?.data || error.message);
            throw error;
        }
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
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
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
                    original_name TEXT NOT NULL,
                    share_url TEXT NOT NULL,
                    password TEXT,
                    mode TEXT DEFAULT 'individual',
                    status TEXT DEFAULT 'active',
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    expires_at TIMESTAMPTZ NOT NULL,
                    views_count INTEGER DEFAULT 0
                );
            `);

            // Таблица сессий
            await this.db.query(`
                CREATE TABLE IF NOT EXISTS user_sessions (
                    sid VARCHAR PRIMARY KEY,
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

            // Индексы для производительности
            await this.db.query(`
                CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
                CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
                CREATE INDEX IF NOT EXISTS idx_projects_expires_at ON projects(expires_at);
            `);

            console.log('✅ Все таблицы и индексы созданы/проверены');
        } catch (error) {
            console.error('❌ Ошибка инициализации БД:', error.message);
            throw error;
        }
    }
}

module.exports = new SharedModule();