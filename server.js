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

// Порт из переменной окружения (для Render, Fly.io и др.)
const PORT = process.env.PORT || 3000;

// Путь к файлу базы данных
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

// Настройка сессий
app.use(session({
  secret: process.env.SESSION_SECRET || '3d-review-hub-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // true только при HTTPS
    maxAge: 24 * 60 * 60 * 1000 // 24 часа
  }
}));

// Создание папки для загрузок
const uploadDir = 'uploads/projects/';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Настройка загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}_${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.stl', '.glb', '.obj'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(ext)) {
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
app.use(express.static('public'));
app.use('/models', express.static('uploads'));

// Middleware проверки авторизации
function requireAuth(req, res, next) {
  if (req.session.userId) {
    next();
  } else {
    res.redirect('/login');
  }
}

// ======================
// Роуты
// ======================

// Главная страница
app.get('/', (req, res) => {
  if (req.session.userId) {
    res.redirect('/dashboard');
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// Регистрация
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Все поля обязательны для заполнения' });
    }
    const db = readDB();
    if (db.users.some(u => u.email === email)) {
      return res.status(400).json({ error: 'Пользователь с таким email уже существует' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = {
      id: uuidv4(),
      email,
      password: hashedPassword,
      name,
      createdAt: new Date().toISOString(),
      plan: 'free'
    };
    db.users.push(user);
    writeDB(db);
    req.session.userId = user.id;
    res.json({ success: true, redirect: '/dashboard' });
  } catch (error) {
    console.error('Ошибка регистрации:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Вход
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }
    const db = readDB();
    const user = db.users.find(u => u.email === email);
    if (!user) {
      return res.status(400).json({ error: 'Пользователь не найден' });
    }
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Неверный пароль' });
    }
    req.session.userId = user.id;
    res.json({ success: true, redirect: '/dashboard' });
  } catch (error) {
    console.error('Ошибка входа:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Выход
app.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Ошибка выхода:', err);
      return res.status(500).json({ error: 'Ошибка выхода' });
    }
    res.json({ success: true, redirect: '/' });
  });
});

// Личный кабинет
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// API: получение проектов
app.get('/api/projects', requireAuth, (req, res) => {
  try {
    const db = readDB();
    const projects = db.projects.filter(p => p.userId === req.session.userId);
    res.json(projects);
  } catch (error) {
    console.error('Ошибка получения проектов:', error);
    res.status(500).json({ error: 'Ошибка получения проектов' });
  }
});

// API: создание проекта — ИСПРАВЛЕНО!
app.post('/api/projects', requireAuth, upload.single('model'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл модели обязателен' });
    }
    const { name, description, expiresIn = '24', password = '', mode = 'individual' } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Название проекта обязательно' });
    }

    const db = readDB();
    const user = db.users.find(u => u.id === req.session.userId);
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // Лимит для бесплатного тарифа
    const activeProjects = db.projects.filter(p => p.userId === user.id && p.status === 'active');
    if (user.plan === 'free' && activeProjects.length >= 3) {
      return res.status(400).json({ error: 'Достигнут лимит: 3 активных проекта для бесплатного тарифа.' });
    }

    // ✅ Генерируем ОДИН И ТОТ ЖЕ ID для модели и ссылки
    const projectId = uuidv4();
    const expiresAt = new Date(Date.now() + parseInt(expiresIn) * 60 * 60 * 1000);
    const fullShareUrl = `${req.protocol}://${req.get('host')}/view/${projectId}`; // <-- ОДИН ID

    const project = {
      id: projectId,
      userId: user.id,
      userName: user.name,
      name,
      description: description || '',
      modelFile: req.file.filename,
      modelOriginalName: req.file.originalname,
      shareUrl: `/view/${projectId}`,
      fullShareUrl: fullShareUrl, // <-- ИСПОЛЬЗУЕТСЯ ТОТ ЖЕ ID
      password: password || '',
      mode: mode,
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
  } catch (error) {
    console.error('Ошибка создания проекта:', error);
    res.status(500).json({ error: 'Ошибка создания проекта' });
  }
});

// API: архивация проекта
app.post('/api/projects/:projectId/archive', requireAuth, (req, res) => {
  try {
    const db = readDB();
    const project = db.projects.find(p => p.id === req.params.projectId && p.userId === req.session.userId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }
    project.status = 'archived';
    writeDB(db);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка архивации проекта:', error);
    res.status(500).json({ error: 'Ошибка архивации проекта' });
  }
});

// API: получение данных модели для просмотра
app.get('/api/view/:projectId', (req, res) => {
  try {
    const db = readDB();
    const project = db.projects.find(p => p.id === req.params.projectId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }
    if (project.status !== 'active') {
      return res.status(410).json({ error: 'Проект не активен' });
    }
    if (new Date() > new Date(project.expiresAt)) {
      project.status = 'expired';
      writeDB(db);
      return res.status(410).json({ error: 'Срок действия ссылки истёк' });
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
  } catch (error) {
    console.error('Ошибка получения проекта:', error);
    res.status(500).json({ error: 'Ошибка загрузки модели' });
  }
});

// Страница просмотра
app.get('/view/:projectId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// ======================
// WebSocket (совместный просмотр)
// ======================
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

// ======================
// Вспомогательные функции
// ======================

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
  } catch (error) {
    console.error('Ошибка очистки проектов:', error);
  }
}

// Запуск периодической очистки
setInterval(cleanupExpiredProjects, 6 * 60 * 60 * 1000); // раз в 6 часов

// ======================
// Запуск сервера
// ======================

server.listen(PORT, () => {
  console.log(`✅ 3D Review Hub запущен на порту ${PORT}`);
  console.log(`📁 База данных: ${DB_FILE}`);
  console.log(`📁 Загрузки: ${uploadDir}`);
  console.log(`🌍 Доступ: http://localhost:${PORT}`);
});

// Обработка завершения
process.on('SIGINT', () => {
  console.log('\n🛑 Сервер остановлен.');
  process.exit(0);
});