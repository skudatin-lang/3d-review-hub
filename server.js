// server.js — обновлённая и готовая к продакшену версия

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Порт — из переменной окружения (для Render, Vercel и т.д.)
const PORT = process.env.PORT || 3000;

// Пути к данным
const DB_FILE = path.join(__dirname, 'database.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads', 'projects');

// Убедимся, что папки существуют
async function ensureDirectories() {
  await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

// Чтение базы данных
async function readDB() {
  try {
    const data = await fs.readFile(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const emptyDB = { users: [], projects: [] };
      await fs.writeFile(DB_FILE, JSON.stringify(emptyDB, null, 2));
      return emptyDB;
    }
    console.error('Ошибка чтения базы данных:', error);
    return { users: [], projects: [] };
  }
}

// Запись базы данных
async function writeDB(data) {
  try {
    await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Ошибка записи базы данных:', error);
  }
}

// Настройка сессий
app.use(session({
  secret: process.env.SESSION_SECRET || '3d-review-hub-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // true только при HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 часа
  }
}));

// Настройка загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}_${Date.now()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.stl', '.glb', '.obj'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Разрешены только .stl, .glb, .obj'));
    }
  },
  limits: {
    fileSize: 100 * 1024 * 1024 // 100 МБ
  }
});

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // <-- здесь все HTML/CSS/JS

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session.userId) {
    next();
  } else {
    res.redirect('/login');
  }
}

// === Роуты ===

app.get('/', (req, res) => {
  if (req.session.userId) {
    res.redirect('/dashboard');
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/view/:projectId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'viewer.html')));

// API — регистрация
app.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Все поля обязательны' });
    }

    const db = await readDB();
    if (db.users.some(u => u.email === email)) {
      return res.status(400).json({ error: 'Email уже используется' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = {
      id: uuidv4(),
      email,
      password: hashed,
      name,
      createdAt: new Date().toISOString(),
      plan: 'free'
    };

    db.users.push(user);
    await writeDB(db);
    req.session.userId = user.id;
    res.json({ success: true, redirect: '/dashboard' });
  } catch (err) {
    console.error('Ошибка регистрации:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// API — вход
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const db = await readDB();
    const user = db.users.find(u => u.email === email);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ error: 'Неверный email или пароль' });
    }
    req.session.userId = user.id;
    res.json({ success: true, redirect: '/dashboard' });
  } catch (err) {
    console.error('Ошибка входа:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// API — выход
app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true, redirect: '/' });
  });
});

// API — проекты
app.get('/api/projects', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    const projects = db.projects.filter(p => p.userId === req.session.userId);
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки проектов' });
  }
});

app.post('/api/projects', requireAuth, upload.single('model'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл модели обязателен' });
    const { name, description, expiresIn = '24', password = '', mode = 'individual' } = req.body;
    if (!name) return res.status(400).json({ error: 'Название обязательно' });

    const db = await readDB();
    const user = db.users.find(u => u.id === req.session.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    // Лимит для free
    const active = db.projects.filter(p => p.userId === user.id && p.status === 'active');
    if (user.plan === 'free' && active.length >= 3) {
      return res.status(400).json({ error: 'Лимит: 3 активных проекта для бесплатного тарифа' });
    }

    const expiresAt = new Date(Date.now() + parseInt(expiresIn) * 3600000);
    const project = {
      id: uuidv4(),
      userId: user.id,
      userName: user.name,
      name,
      description: description || '',
      modelFile: req.file.filename,
      modelOriginalName: req.file.originalname,
      shareUrl: `/view/${uuidv4()}`, // не используется в API, но оставим
      fullShareUrl: `${req.protocol}://${req.get('host')}/view/${uuidv4()}`, // лучше формировать на клиенте
      password,
      mode,
      status: 'active',
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString()
    };

    db.projects.push(project);
    await writeDB(db);
    await cleanupExpiredProjects();

    res.json({
      success: true,
      project: {
        id: project.id,
        name: project.name,
        shareUrl: `${req.protocol}://${req.get('host')}/view/${project.id}`,
        expiresAt: project.expiresAt
      }
    });
  } catch (err) {
    console.error('Ошибка создания проекта:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/projects/:projectId/archive', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    const project = db.projects.find(p => p.id === req.params.projectId && p.userId === req.session.userId);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    project.status = 'archived';
    await writeDB(db);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка архивации' });
  }
});

app.get('/api/view/:projectId', async (req, res) => {
  try {
    const db = await readDB();
    const project = db.projects.find(p => p.id === req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    if (project.status !== 'active') return res.status(410).json({ error: 'Проект не активен' });
    if (new Date() > new Date(project.expiresAt)) {
      project.status = 'expired';
      await writeDB(db);
      return res.status(410).json({ error: 'Срок действия истёк' });
    }
    if (project.password && project.password !== req.query.password) {
      return res.status(403).json({ error: 'Неверный пароль' });
    }
    res.json({
      modelUrl: `/uploads/projects/${project.modelFile}`,
      originalName: project.modelOriginalName,
      projectName: project.name,
      userName: project.userName,
      mode: project.mode
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки модели' });
  }
});

// WebSocket — для совместного просмотра
const activeRooms = new Map();
io.on('connection', (socket) => {
  socket.on('join-room', (projectId) => {
    socket.join(projectId);
    if (!activeRooms.has(projectId)) activeRooms.set(projectId, new Set());
    activeRooms.get(projectId).add(socket.id);
    socket.to(projectId).emit('user-joined', { userId: socket.id });
  });

  socket.on('camera-update', (data) => {
    socket.to(data.projectId).emit('camera-updated', { userId: socket.id, ...data });
  });

  socket.on('annotation-add', (data) => {
    socket.to(data.projectId).emit('annotation-added', { userId: socket.id, annotation: data.annotation });
  });

  socket.on('disconnect', () => {
    for (const [roomId, users] of activeRooms) {
      if (users.delete(socket.id)) {
        socket.to(roomId).emit('user-left', { userId: socket.id });
        if (users.size === 0) activeRooms.delete(roomId);
      }
    }
  });
});

// Очистка просроченных проектов
async function cleanupExpiredProjects() {
  try {
    const db = await readDB();
    const now = new Date();
    let changed = false;
    db.projects.forEach(p => {
      if (p.status === 'active' && new Date(p.expiresAt) < now) {
        p.status = 'expired';
        changed = true;
      }
    });
    if (changed) await writeDB(db);
  } catch (err) {
    console.error('Ошибка очистки:', err);
  }
}

// Запуск
async function start() {
  await ensureDirectories();
  setInterval(cleanupExpiredProjects, 6 * 60 * 60 * 1000); // раз в 6 часов
  server.listen(PORT, () => {
    console.log(`✅ 3D Review Hub запущен на порту ${PORT}`);
    console.log(`📁 Папка uploads: ${UPLOADS_DIR}`);
  });
}

start();