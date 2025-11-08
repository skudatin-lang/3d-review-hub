// server.js — для Render + PostgreSQL + Backblaze B2
const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);

const PORT = process.env.PORT || 3000;

// Подключение к PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.RENDER ? { rejectUnauthorized: false } : false
});

// Подключение к Backblaze B2
const s3 = new S3Client({
  region: 'us-west-002',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

// Инициализация таблиц
async function initDB() {
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
}

// Сессии
app.use(session({
  secret: process.env.SESSION_SECRET || '3d-review-hub-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
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

// Главная
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Страницы входа/регистрации
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// Регистрация
app.post('/register', async (req, res) => {
  const { email, password, name } = req.body;
  const hashed = await bcrypt.hash(password, 10);
  const id = uuidv4();
  try {
    await pool.query(
      'INSERT INTO users(id, email, password, name) VALUES($1, $2, $3, $4)',
      [id, email, hashed, name]
    );
    req.session.userId = id;
    res.json({ success: true, redirect: '/dashboard' });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Email уже используется' });
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

// Вход
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  if (!rows.length) return res.status(400).json({ error: 'Пользователь не найден' });
  const user = rows[0];
  if (!await bcrypt.compare(password, user.password)) {
    return res.status(400).json({ error: 'Неверный пароль' });
  }
  req.session.userId = user.id;
  res.json({ success: true, redirect: '/dashboard' });
});

// Выход
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true, redirect: '/' }));
});

// Dashboard
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// API: проекты
app.get('/api/projects', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC', [req.session.userId]);
  const now = new Date();
  const projects = rows.map(p => ({
    ...p,
    fullShareUrl: `${req.protocol}://${req.get('host')}/view/${p.id}`,
    status: new Date(p.expires_at) < now ? 'expired' : p.status
  }));
  res.json(projects);
});

// Создание проекта
app.post('/api/projects', requireAuth, upload.single('model'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл обязателен' });
  const { name, description, expiresIn = '24', password = '', mode = 'individual' } = req.body;
  if (!name) return res.status(400).json({ error: 'Название обязательно' });

  const user = (await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId])).rows[0];
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const { rows: userProjects } = await pool.query('SELECT * FROM projects WHERE user_id = $1 AND status = $2', [req.session.userId, 'active']);
  if (user.plan === 'free' && userProjects.length >= 3) {
    return res.status(400).json({ error: 'Лимит 3 проекта на бесплатном тарифе' });
  }

  const projectId = uuidv4();
  const key = `${uuidv4()}_${req.file.originalname}`;
  const expiresAt = new Date(Date.now() + parseInt(expiresIn) * 60 * 60 * 1000);

  // Загрузка в Backblaze B2
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: `projects/${key}`,
    Body: req.file.buffer,
    ContentType: req.file.mimetype
  }));

  await pool.query(`
    INSERT INTO projects(id, user_id, user_name, name, description, model_file, model_original_name, password, mode, expires_at)
    VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [projectId, user.id, user.name, name, description, key, req.file.originalname, password, mode, expiresAt]);

  const fullShareUrl = `${req.protocol}://${req.get('host')}/view/${projectId}`;
  res.json({ success: true, project: { id: projectId, shareUrl: fullShareUrl, expiresAt: expiresAt.toISOString() } });
});

// Просмотр проекта
app.get('/api/view/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (!rows.length) return res.status(404).json({ error: 'Проект не найден' });

  const project = rows[0];
  const now = new Date();
  if (new Date(project.expires_at) < now) {
    await pool.query('UPDATE projects SET status = $1 WHERE id = $2', ['expired', projectId]);
    return res.status(410).json({ error: 'Срок действия истёк' });
  }
  if (project.status !== 'active') return res.status(410).json({ error: 'Проект не активен' });
  if (project.password && project.password !== req.query.password) {
    return res.status(403).json({ error: 'Неверный пароль' });
  }

  const command = new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: `projects/${project.model_file}` });
  const url = await getSignedUrl(s3, command, { expiresIn: 3600 });

  res.json({
    modelUrl: url,
    originalName: project.model_original_name,
    projectName: project.name,
    userName: project.user_name,
    mode: project.mode
  });
});

// Viewer
app.get('/view/:projectId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// Socket.IO
io.on('connection', (socket) => {
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    socket.to(roomId).emit('user-joined', { userId: socket.id });
  });
  socket.on('camera-update', (data) => {
    socket.to(data.projectId).emit('camera-updated', { userId: socket.id, ...data });
  });
  socket.on('annotation-add', (data) => {
    socket.to(data.projectId).emit('annotation-added', { userId: socket.id, annotation: data.annotation });
  });
});

// Запуск
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`✅ 3D Review Hub запущен на порту ${PORT}`);
  });
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});