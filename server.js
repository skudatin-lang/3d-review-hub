const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs'); // ✅ Импортирован — решает ошибку "fs is not defined"
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// ✅ Используем PORT из переменной окружения (для Render)
const PORT = process.env.PORT || 3000;

// Путь к базе данных
const DB_FILE = 'database.json';

// Чтение базы данных
function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], projects: [] }));
      return { users: [], projects: [] };
    }
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Ошибка чтения базы данных:', error);
    return { users: [], projects: [] };
  }
}

// Запись базы данных
function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Ошибка записи в базу данных:', error);
  }
}

// Сессии
app.use(session({
  secret: process.env.SESSION_SECRET || '3d-review-hub-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Папка для загрузок
const UPLOAD_DIR = 'uploads/projects/';
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Загрузка файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}_${file.originalname}`;
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
    fileSize: 100 * 1024 * 1000 // 100 МБ
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/models', express.static('uploads'));

// Проверка авторизации
function requireAuth(req, res, next) {
  if (req.session.userId) {
    next();
  } else {
    res.redirect('/login');
  }
}

// ================ Роуты ================

// Главная
app.get('/', (req, res) => {
  if (req.session.userId) {
    res.redirect('/dashboard');
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// Вход / регистрация
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// API: регистрация
app.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Все поля обязательны' });
    }
    const db = readDB();
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
    writeDB(db);
    req.session.userId = user.id;
    res.json({ success: true, redirect: '/dashboard' });
  } catch (err) {
    console.error('Ошибка регистрации:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// API: вход
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const db = readDB();
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

// API: выход
app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true, redirect: '/' });
  });
});

// Дашборд
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// API: проекты
app.get('/api/projects', requireAuth, (req, res) => {
  try {
    const db = readDB();
    const projects = db.projects.filter(p => p.userId === req.session.userId);
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки проектов' });
  }
});

// API: создание проекта — ✅ ИСПРАВЛЕНО: один projectId
app.post('/api/projects', requireAuth, upload.single('model'), (req, res) => {
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
    // ✅ Один и тот же projectId используется для хранения И для ссылки
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
      password,
      mode,
      status: 'active',
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      screenshots: []
    };

    db.projects.push(project);
    writeDB(db);
    cleanupExpiredProjects();

    res.json({
      success: true,
      project: {
        id: project.id,
        name: project.name,
        shareUrl: project.fullShareUrl,
        expiresAt: project.expiresAt
      }
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

// API: просмотр модели
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
    if (project.password && project.password !== req.query.password) {
      return res.status(403).json({ error: 'Неверный пароль' });
    }
    res.json({
      modelUrl: `/models/projects/${project.modelFile}`,
      originalName: project.modelOriginalName,
      projectName: project.name,
      userName: project.userName,
      mode: project.mode
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки модели' });
  }
});

// Страница просмотра
app.get('/view/:projectId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// WebSocket
const activeRooms = new Map();
io.on('connection', (socket) => {
  socket.on('join-room', (projectId) => {
    socket.join(projectId);
    if (!activeRooms.has(projectId)) activeRooms.set(projectId, new Set());
    activeRooms.get(projectId).add(socket.id);
    socket.to(projectId).emit('user-joined', { userId: socket.id });
  });
  socket.on('camera-update', (data) => {
    socket.to(data.projectId).emit('camera-updated', {
      userId: socket.id,
      position: data.position,
      rotation: data.rotation
    });
  });
  socket.on('annotation-add', (data) => {
    socket.to(data.projectId).emit('annotation-added', {
      userId: socket.id,
      annotation: data.annotation
    });
  });
  socket.on('disconnect', () => {
    for (const [roomId, users] of activeRooms.entries()) {
      if (users.delete(socket.id)) {
        socket.to(roomId).emit('user-left', { userId: socket.id });
        if (users.size === 0) activeRooms.delete(roomId);
      }
    }
  });
});

// Утилиты
function cleanupExpiredProjects() {
  try {
    const db = readDB();
    const now = new Date();
    let changed = false;
    db.projects.forEach(p => {
      if (p.status === 'active' && new Date(p.expiresAt) < now) {
        p.status = 'expired';
        changed = true;
      }
    });
    if (changed) writeDB(db);
  } catch (err) {
    console.error('Ошибка очистки:', err);
  }
}
setInterval(cleanupExpiredProjects, 6 * 60 * 60 * 1000);

// Запуск
server.listen(PORT, () => {
  console.log(`✅ 3D Review Hub запущен на порту ${PORT}`);
  console.log(`📁 База данных: ${DB_FILE}`);
  console.log(`📁 Загрузки: ${UPLOAD_DIR}`);
});