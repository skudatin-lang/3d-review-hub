// server.js — версия для Render + PostgreSQL + Backblaze B2
const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const http = require('http');
const socketIo = require('socket.io');
const { Client } = require('pg');
const PgSession = require('connect-pg-simple')(session);
const B2 = require('backblaze-b2');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// === Подключение к PostgreSQL ===
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

client.connect().catch(err => {
  console.error('❌ Не удалось подключиться к PostgreSQL:', err.message);
  process.exit(1);
});

// === Backblaze B2 ===
const b2 = new B2({
  applicationKeyId: process.env.BACKBLAZE_KEY_ID,
  applicationKey: process.env.BACKBLAZE_APPLICATION_KEY
});

let b2Authorized = false;
async function authorizeB2() {
  if (!b2Authorized) {
    await b2.authorize();
    b2Authorized = true;
  }
}

async function uploadToB2(fileBuffer, filename) {
  await authorizeB2();
  const response = await b2.getUploadUrl({ bucketId: process.env.BACKBLAZE_BUCKET_ID });
  const uploadUrl = response.data.uploadUrl;
  const uploadAuth = response.data.authorizationToken;

  const result = await b2.uploadFile({
    uploadUrl,
    uploadAuthToken: uploadAuth,
    fileName: filename,
    fileBuffer,
    contentType: 'application/octet-stream'
  });
  return `https://f004.backblazeb2.com/file/${process.env.BACKBLAZE_BUCKET_NAME}/${encodeURIComponent(filename)}`;
}

// === Сессии в PostgreSQL ===
app.use(session({
  store: new PgSession({ pool: client, tableName: 'user_sessions' }),
  secret: process.env.SESSION_SECRET || '3d-review-hub-fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, secure: false }
}));

// === Multer: загрузка в память для отправки в B2 ===
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.stl', '.glb', '.obj'].includes(ext)) cb(null, true);
    else cb(new Error('Только STL, GLB, OBJ'));
  },
  limits: { fileSize: 100 * 1024 * 1024 }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login');
}

// === Роуты: публичные страницы ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/view/:projectId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// === Аутентификация ===
app.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const id = uuidv4();
    await client.query(
      'INSERT INTO users(id, email, password, name, plan, created_at) VALUES($1, $2, $3, $4, $5, NOW())',
      [id, email, hashed, name, 'free']
    );
    req.session.userId = id;
    res.json({ success: true, redirect: '/dashboard' });
  } catch (e) {
    if (e.code === '23505') {
      res.status(400).json({ error: 'Email уже занят' });
    } else {
      console.error(e);
      res.status(500).json({ error: 'Ошибка регистрации' });
    }
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await client.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Пользователь не найден' });
    }
    const user = result.rows[0];
    if (!await bcrypt.compare(password, user.password)) {
      return res.status(400).json({ error: 'Неверный пароль' });
    }
    req.session.userId = user.id;
    res.json({ success: true, redirect: '/dashboard' });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true, redirect: '/' });
  });
});

// === API: проекты ===
app.get('/api/projects', requireAuth, async (req, res) => {
  try {
    const result = await client.query(
      'SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC',
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('Ошибка загрузки проектов:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/projects', requireAuth, upload.single('model'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл обязателен' });
    const { name, description, expiresIn = '24', password = '', mode = 'individual' } = req.body;
    if (!name) return res.status(400).json({ error: 'Название обязательно' });

    const activeCount = await client.query(
      'SELECT COUNT(*) FROM projects WHERE user_id = $1 AND status = $2',
      [req.session.userId, 'active']
    );
    if (activeCount.rows[0].count >= 3) {
      return res.status(400).json({ error: 'Лимит: 3 активных проекта на Free' });
    }

    const id = uuidv4();
    const filename = `${uuidv4()}_${req.file.originalname}`;
    const fileUrl = await uploadToB2(req.file.buffer, filename);
    const expiresAt = new Date(Date.now() + parseInt(expiresIn) * 60 * 60 * 1000);

    await client.query(`
      INSERT INTO projects(
        id, user_id, name, description, model_url, original_name,
        share_url, password, mode, status, created_at, expires_at
      ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11)
    `, [
      id,
      req.session.userId,
      name,
      description || '',
      fileUrl,
      req.file.originalname,
      `/view/${id}`,
      password,
      mode,
      'active',
      expiresAt.toISOString()
    ]);

    const fullShareUrl = `${req.protocol}://${req.get('host')}/view/${id}`;
    res.json({ success: true, project: { id, name, shareUrl: fullShareUrl, expiresAt } });
  } catch (e) {
    console.error('Ошибка создания проекта:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/projects/:projectId/archive', requireAuth, async (req, res) => {
  try {
    await client.query(
      'UPDATE projects SET status = $1 WHERE id = $2 AND user_id = $3',
      ['archived', req.params.projectId, req.session.userId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка архивации' });
  }
});

// === API: просмотр проекта ===
app.get('/api/view/:projectId', async (req, res) => {
  try {
    const result = await client.query('SELECT * FROM projects WHERE id = $1', [req.params.projectId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Проект не найден' });
    }
    const p = result.rows[0];
    if (p.status !== 'active') {
      return res.status(410).json({ error: 'Проект недоступен' });
    }
    if (new Date() > new Date(p.expires_at)) {
      await client.query('UPDATE projects SET status = $1 WHERE id = $2', ['expired', p.id]);
      return res.status(410).json({ error: 'Срок действия истёк' });
    }
    if (p.password && p.password !== req.query.password) {
      return res.status(403).json({ error: 'Неверный пароль' });
    }
    res.json({
      modelUrl: p.model_url,
      originalName: p.original_name,
      projectName: p.name,
      userName: p.user_name || 'Пользователь',
      mode: p.mode
    });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка загрузки проекта' });
  }
});

// === WebSocket ===
io.on('connection', (socket) => {
  socket.on('join-room', (id) => {
    socket.join(id);
    socket.to(id).emit('user-joined', { userId: socket.id });
  });
  socket.on('camera-update', (data) => {
    socket.to(data.projectId).emit('camera-updated', { userId: socket.id, ...data });
  });
  socket.on('annotation-add', (data) => {
    socket.to(data.projectId).emit('annotation-added', { userId: socket.id, annotation: data.annotation });
  });
  socket.on('disconnect', () => {
    // Nothing to clean manually — rooms are virtual
  });
});

// === Автоматическое создание таблиц при запуске ===
async function initializeDatabase() {
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        plan TEXT DEFAULT 'free',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
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
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        sid VARCHAR NOT NULL COLLATE "default",
        sess JSON NOT NULL,
        expire TIMESTAMPTZ NOT NULL
      );
    `);
    await client.query(`
      ALTER TABLE user_sessions 
      ADD CONSTRAINT user_sessions_pkey 
      PRIMARY KEY (sid) 
      NOT DEFERRABLE INITIALLY IMMEDIATE;
    `);
    console.log('✅ Таблицы в PostgreSQL успешно созданы или уже существуют');
  } catch (error) {
    console.error('❌ Ошибка инициализации БД:', error.message);
    process.exit(1);
  }
}

// === Запуск сервера ===
async function startServer() {
  await initializeDatabase();
  server.listen(PORT, () => {
    console.log(`🚀 3D Review Hub запущен на порту ${PORT}`);
    console.log(`🗄️ PostgreSQL подключён`);
    console.log(`☁️ Файлы хранятся в Backblaze B2`);
  });
}

startServer();