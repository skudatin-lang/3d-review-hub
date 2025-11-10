const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Порт для Render
const PORT = process.env.PORT || 3000;

// Пути
const DB_FILE = 'database.json';
const UPLOAD_DIR = 'uploads/projects/';
const PORTFOLIO_DIR = 'uploads/portfolio/';

// Создание папок
[UPLOAD_DIR, PORTFOLIO_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Чтение БД
function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], projects: [], portfolio: [] }));
      return { users: [], projects: [], portfolio: [] };
    }
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!data.portfolio) data.portfolio = [];
    return data;
  } catch (err) {
    console.error('❌ Ошибка чтения БД:', err);
    return { users: [], projects: [], portfolio: [] };
  }
}

// Запись БД
function writeDB(data) {
  try {
    if (!data.portfolio) data.portfolio = [];
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('❌ Ошибка записи БД:', err);
  }
}

// Сессии
app.use(session({
  secret: process.env.SESSION_SECRET || '3d-review-hub-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Поддержка JSON (для register/login)
app.use(express.json());

// Поддержка form-urlencoded и multipart (для проектов)
app.use(express.urlencoded({ extended: true }));

// Статика
app.use(express.static('public'));
app.use('/models', express.static('uploads/projects'));
app.use('/portfolio-files', express.static('uploads/portfolio'));

// Авторизация
function requireAuth(req, res, next) {
  if (req.session.userId) next();
  else res.redirect('/login');
}

// === Роуты ===

// Главная
app.get('/', (req, res) => {
  if (req.session.userId) res.redirect('/dashboard');
  else res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Аутентификация
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// Регистрация (JSON)
app.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'Все поля обязательны' });
    const db = readDB();
    if (db.users.some(u => u.email === email)) return res.status(400).json({ error: 'Email уже используется' });
    const hashed = await bcrypt.hash(password, 10);
    const user = { id: uuidv4(), email, password: hashed, name, createdAt: new Date().toISOString(), plan: 'free' };
    db.users.push(user);
    writeDB(db);
    req.session.userId = user.id;
    res.json({ success: true, redirect: '/dashboard' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Вход (JSON)
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.email === email);
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Неверный email или пароль' });
    req.session.userId = user.id;
    res.json({ success: true, redirect: '/dashboard' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Выход
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true, redirect: '/' }));
});

// Дашборд
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// === Проекты ===

// Настройка загрузки проектов
const projectStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}_${file.originalname}`)
});
const projectUpload = multer({
  storage: projectStorage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.stl', '.glb', '.obj'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Разрешены только .stl, .glb, .obj'));
  },
  limits: { fileSize: 100 * 1024 * 1024 }
});

// API: проекты
app.get('/api/projects', requireAuth, (req, res) => {
  try {
    const db = readDB();
    res.json(db.projects.filter(p => p.userId === req.session.userId));
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки проектов' });
  }
});

// API: создание проекта
app.post('/api/projects', requireAuth, projectUpload.single('model'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл модели обязателен' });
    const { name, description, expiresIn = '24', password = '', mode = 'individual' } = req.body;
    if (!name) return res.status(400).json({ error: 'Название обязательно' });

    const db = readDB();
    const user = db.users.find(u => u.id === req.session.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const active = db.projects.filter(p => p.userId === user.id && p.status === 'active');
    if (user.plan === 'free' && active.length >= 3) {
      return res.status(400).json({ error: 'Лимит: 3 активных проекта для бесплатного тарифа' });
    }

    const projectId = uuidv4();
    const expiresAt = new Date(Date.now() + parseInt(expiresIn) * 3600000);
    const fullShareUrl = `${req.protocol}://${req.get('host')}/view/${projectId}`;

    const project = {
      id: projectId,
      userId: user.id,
      userName: user.name,
      name,
      description: description || '',
      modelFile: req.file.filename,
      modelOriginalName: req.file.originalname,
      shareUrl: `/view/${projectId}`,
      fullShareUrl,
      password: password || '',
      mode,
      status: 'active',
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString()
    };

    db.projects.push(project);
    writeDB(db);
    cleanupExpiredProjects();

    res.json({
      success: true,
      project: { id: project.id, name: project.name, shareUrl: project.fullShareUrl, expiresAt: project.expiresAt }
    });
  } catch (err) {
    console.error('Ошибка создания проекта:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// API: архивация
app.post('/api/projects/:projectId/archive', requireAuth, (req, res) => {
  try {
    const db = readDB();
    const project = db.projects.find(p => p.id === req.params.projectId && p.userId === req.session.userId);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    project.status = 'archived';
    writeDB(db);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка архивации' });
  }
});

// === Просмотр модели ===
app.get('/api/view/:projectId', (req, res) => {
  try {
    const db = readDB();
    const project = db.projects.find(p => p.id === req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    if (project.status !== 'active') return res.status(410).json({ error: 'Проект не активен' });
    if (new Date() > new Date(project.expiresAt)) {
      project.status = 'expired';
      writeDB(db);
      return res.status(410).json({ error: 'Срок действия истёк' });
    }
    if (project.password && project.password !== req.query.password) return res.status(403).json({ error: 'Неверный пароль' });
    res.json({
      modelUrl: `/models/${project.modelFile}`,
      originalName: project.modelOriginalName,
      projectName: project.name,
      userName: project.userName,
      mode: project.mode
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки модели' });
  }
});

app.get('/view/:projectId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// === ПОРТФОЛИО ===

// Настройка загрузки портфолио
const portfolioStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PORTFOLIO_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}_${file.originalname}`)
});
const portfolioUpload = multer({
  storage: portfolioStorage,
  fileFilter: (req, file, cb) => {
    const isImage = file.mimetype.startsWith('image/');
    const isVideo = file.mimetype.startsWith('video/');
    const isST