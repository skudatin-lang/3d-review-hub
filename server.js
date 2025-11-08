// server.js — исправленная версия для Render
const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const PgSession = require('connect-pg-simple')(session);
require('dotenv').config();

const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);

const PORT = process.env.PORT || 3000;

// Проверяем, есть ли DATABASE_URL (это значит, мы в Render)
const isProduction = !!process.env.DATABASE_URL;

// Настройка PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false
});

// Проверка подключения к БД
pool.connect((err) => {
  if (err) {
    console.error('❌ Ошибка подключения к PostgreSQL:', err);
    process.exit(1);
  } else {
    console.log('✅ Успешное подключение к PostgreSQL');
  }
});

// Настройка Backblaze B2
let s3;
if (process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) {
  s3 = new S3Client({
    region: 'us-west-002',
    endpoint: process.env.R2_ENDPOINT || 'https://s3.us-west-002.backblazeb2.com',
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
}

// Инициализация таблиц
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        plan TEXT DEFAULT 'free',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_name TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        model_file TEXT NOT NULL,
        model_original_name TEXT NOT NULL,
        password TEXT,
        mode TEXT DEFAULT 'individual',
        status TEXT DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );
    `);
    console.log('✅ Таблицы базы данных инициализированы');
  } catch (error) {
    console.error('❌ Ошибка инициализации базы данных:', error);
    throw error;
  }
}

// Сессии с хранением в PostgreSQL (не в памяти!)
const sessionStore = new PgSession({
  pool: pool,
  tableName: 'session'
});

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || '3d-review-hub-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: isProduction, 
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: isProduction ? 'lax' : 'strict'
  }
}));

// Загрузка файлов в память
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Защита маршрутов
function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login');
}

// ... остальные маршруты остаются без изменений ...

// Запуск
async function startServer() {
  try {
    await initDB();
    
    // Создание таблицы для сессий
    await pool.query(`
      CREATE TABLE IF NOT EXISTS session (
        sid VARCHAR NOT NULL COLLATE "default",
        sess JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL
      );
      
      ALTER TABLE session ADD CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE;
    `);
    
    server.listen(PORT, () => {
      console.log(`✅ 3D Review Hub запущен на порту ${PORT}`);
      console.log(`🌐 Среда: ${isProduction ? 'Production (Render)' : 'Development'}`);
      console.log(`🗄️  База данных: ${isProduction ? 'PostgreSQL (Render)' : 'Локальная разработка'}`);
    });
  } catch (error) {
    console.error('❌ Критическая ошибка при запуске сервера:', error);
    process.exit(1);
  }
}

startServer();

process.on('SIGINT', () => {
  pool.end().then(() => {
    server.close(() => process.exit(0));
  });
});