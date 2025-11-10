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

// Используем PORT из переменной окружения (для Render)
const PORT = process.env.PORT || 3000;

// Пути
const DB_FILE = 'database.json';
const UPLOAD_DIR = 'uploads/projects/';
const PORTFOLIO_DIR = 'uploads/portfolio/';

// Создаём папки
[UPLOAD_DIR, PORTFOLIO_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Чтение базы данных
function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], projects: [], portfolio: [] }));
      return { users: [], projects: [], portfolio: [] };
    }
    const data = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(data);
    if (!parsed.portfolio) parsed.portfolio = [];
    return parsed;
  } catch (error) {
    console.error('Ошибка чтения базы данных:', error);
    return { users: [], projects: [], portfolio: [] };
  }
}

// Запись базы данных
function writeDB(data) {
  try {
    if (!data.portfolio) data.portfolio = [];
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
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Настройка загрузки файлов
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
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.stl', '.glb', '.obj'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(fileExtension)) {
      cb(null, true);
    } else {
      cb(new Error('Только STL, GLB, OBJ файлы'));
    }
  },
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB
  }
});

// Загрузка для портфолио
const portfolioStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, PORTFOLIO_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}_${file.originalname}`;
    cb(null, uniqueName);
  }
});

const portfolioUpload = multer({
  storage: portfolioStorage,
  fileFilter: (req, file, cb) => {
    const isImage = file.mimetype.startsWith('image/');
    const isVideo = file.mimetype.startsWith('video/');
    const isSTL = file.mimetype === 'application/octet-stream' && 
                  file.originalname.toLowerCase().endsWith('.stl');
    if (isImage || isVideo || isSTL) {
      cb(null, true);
    } else {
      cb(new Error('Разрешены: изображения, видео и STL-файлы'));
    }
  },
  limits: {
    fileSize: 200 * 1024 * 1024 // 200MB
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/models', express.static('uploads/projects'));
app.use('/portfolio-files', express.static('uploads/portfolio'));

// Middleware проверки авторизации
function requireAuth(req, res, next) {
  if (req.session.userId) {
    next();
  } else {
    res.redirect('/login');
  }
}

// ================ Роуты =================

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
  req.session.destroy((err) => {
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

// API для получения проектов пользователя
app.get('/api/projects', requireAuth, (req, res) => {
  try {
    const db = readDB();
    const userProjects = db.projects.filter(p => p.userId === req.session.userId);
    res.json(userProjects);
  } catch (error) {
    console.error('Ошибка получения проектов:', error);
    res.status(500).json({ error: 'Ошибка получения проектов' });
  }
});

// Создание проекта
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
    const userProjects = db.projects.filter(p => p.userId === req.session.userId && p.status === 'active');
    if (user.plan === 'free' && userProjects.length >= 3) {
      return res.status(400).json({ error: 'Достигнут лимит проектов для бесплатного тарифа. Максимум 3 активных проекта.' });
    }
    const projectId = uuidv4();
    const expiresAt = new Date(Date.now() + parseInt(expiresIn) * 60 * 60 * 1000);
    const project = {
      id: projectId,
      userId: req.session.userId,
      userName: user.name,
      name,
      description: description || '',
      modelFile: req.file.filename,
      modelOriginalName: req.file.originalname,
      shareUrl: `/view/${projectId}`,
      fullShareUrl: `${req.protocol}://${req.get('host')}/view/${projectId}`,
      password: password || '',
      mode: mode || 'individual',
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

// Архивирование проекта
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

// Получение информации о проекте для просмотра
app.get('/api/view/:projectId', (req, res) => {
  try {
    const db = readDB();
    const project = db.projects.find(p => p.id === req.params.projectId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }
    if (project.status !== 'active') {
      return res.status(410).json({ error: 'Проект архивирован' });
    }
    if (new Date() > new Date(project.expiresAt)) {
      project.status = 'expired';
      writeDB(db);
      return res.status(410).json({ error: 'Время действия ссылки истекло' });
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
    res.status(500).json({ error: 'Ошибка получения проекта' });
  }
});

// Портфолио — получение списка
app.get('/api/portfolio', requireAuth, (req, res) => {
  try {
    const db = readDB();
    const portfolio = db.portfolio.filter(item => item.userId === req.session.userId);
    res.json(portfolio);
  } catch (error) {
    console.error('Ошибка получения портфолио:', error);
    res.status(500).json({ error: 'Ошибка получения портфолио' });
  }
});

// Портфолио — добавление новой работы
app.post('/api/portfolio', requireAuth, portfolioUpload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл обязателен' });
    }
    const { title, description } = req.body;
    const db = readDB();
    const item = {
      id: uuidv4(),
      userId: req.session.userId,
      title: title || 'Без названия',
      description: description || '',
      fileName: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      createdAt: new Date().toISOString()
    };
    db.portfolio.push(item);
    writeDB(db);
    res.json({ success: true, item });
  } catch (error) {
    console.error('Ошибка добавления в портфолио:', error);
    res.status(500).json({ error: 'Ошибка добавления в портфолио' });
  }
});

// Страница просмотра для клиентов
app.get('/view/:projectId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// WebSocket для совместного просмотра
const activeRooms = new Map();
io.on('connection', (socket) => {
  console.log('Новое подключение:', socket.id);
  socket.on('join-room', (projectId) => {
    socket.join(projectId);
    if (!activeRooms.has(projectId)) {
      activeRooms.set(projectId, new Set());
    }
    activeRooms.get(projectId).add(socket.id);
    socket.to(projectId).emit('user-joined', { userId: socket.id });
    console.log(`Пользователь ${socket.id} присоединился к комнате ${projectId}`);
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
    console.log('Отключение:', socket.id);
    for (const [roomId, users] of activeRooms.entries()) {
      if (users.has(socket.id)) {
        users.delete(socket.id);
        socket.to(roomId).emit('user-left', { userId: socket.id });
        if (users.size === 0) {
          activeRooms.delete(roomId);
        }
      }
    }
  });
});

// Функция очистки просроченных проектов
function cleanupExpiredProjects() {
  try {
    const db = readDB();
    const now = new Date();
    let changed = false;
    db.projects.forEach(project => {
      if (project.status === 'active' && new Date(project.expiresAt) < now) {
        project.status = 'expired';
        changed = true;
      }
    });
    if (changed) {
      writeDB(db);
    }
  } catch (error) {
    console.error('Ошибка очистки проектов:', error);
  }
}

// Запуск очистки каждые 6 часов
setInterval(cleanupExpiredProjects, 6 * 60 * 60 * 1000);

// Обработка ошибок
app.use((err, req, res, next) => {
  console.error('Необработанная ошибка:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// Запуск сервера
server.listen(PORT, () => {
  console.log(`🚀 3D Review Hub запущен!`);
  console.log(`📍 Адрес: http://localhost:${PORT}`);
  console.log(`📁 База данных: ${DB_FILE}`);
  console.log(`📁 Загрузки: uploads/projects/ и uploads/portfolio/`);
});

// Обработка graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Остановка сервера...');
  process.exit(0);
});