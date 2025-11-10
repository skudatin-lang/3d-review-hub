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

// Чтение базы данных
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

// Запись базы данных
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
  cookie: {
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Загрузка проектов
const projectStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}_${file.originalname}`)
});
const projectUpload = multer({
  storage: projectStorage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.stl', '.glb', '.obj'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Разрешены: .stl, .glb, .obj'));
  },
  limits: { fileSize: 100 * 1024 * 1024 }
});

// Загрузка портфолио
const portfolioStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PORTFOLIO_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}_${file.originalname}`)
});
const portfolioUpload = multer({
  storage: portfolioStorage,
  fileFilter: (req, file, cb) => {
    const isImage = file.mimetype.startsWith('image/');
    const isVideo = file.mimetype.startsWith('video/');
    const isSTL = file.mimetype === 'application/octet-stream' && 
                  file.originalname.toLowerCase().endsWith('.stl');
    if (isImage || isVideo || isSTL) cb(null, true);
    else cb(new Error('Разрешены: изображения, видео и STL-файлы'));
  },
  limits: { fileSize: 200 * 1024 * 1024 }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/models', express.static('uploads/projects'));
app.use('/portfolio-files', express.static('uploads/portfolio'));

// Авторизация
function requireAuth(req, res, next) {
  if (req.session.userId) next();
  else res.redirect('/login');
}

// ====== Роуты ======

// Главная страница
app.get('/', (req, res) => {
  if (req.session.userId) res.redirect('/dashboard');
  else res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Аутентификация
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

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

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true, redirect: '/' }));
});

// Дашборд
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Проекты
app.get('/api/projects', requireAuth, (req, res) => {
  try {
    const db = readDB();
    const projects = db.projects.filter(p => p.userId === req.session.userId);
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки проектов' });
  }
});

app.post('/api/projects', requireAuth, projectUpload.single('model'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл модели обязателен' });
    const { name, description, expiresIn = '24', password = '', mode = 'individual' } = req.body;
    if (!name) return res.status(400).json({ error: 'Название обязательно' });

    const db = readDB();
    const user = db.users.find(u => u.id === req.session.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const active = db.projects.filter(p => p.userId === user.id && p.status === 'active');
    if (user.plan === 'free' && active.length >= 3) return res.status(400).json({ error: 'Лимит: 3 активных проекта для бесплатного тарифа' });

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
      expiresAt: expiresAt.toISOString(),
      screenshots: []
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

// Просмотр модели
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

// Страница просмотра
app.get('/view/:projectId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// === ПОРТФОЛИО ===

// Получить все карточки портфолио
app.get('/api/portfolio', requireAuth, (req, res) => {
  try {
    const db = readDB();
    const cards = db.portfolio.filter(c => c.userId === req.session.userId);
    res.json(cards);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки портфолио' });
  }
});

// Создать карточку
app.post('/api/portfolio/card', requireAuth, (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title) return res.status(400).json({ error: 'Название обязательно' });
    const db = readDB();
    const card = {
      id: uuidv4(),
      userId: req.session.userId,
      title,
      description: description || '',
      createdAt: new Date().toISOString(),
      items: [],
      folders: []
    };
    db.portfolio.push(card);
    writeDB(db);
    res.json({ success: true, card });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка создания карточки' });
  }
});

// Загрузить файл в карточку
app.post('/api/portfolio/card/:cardId/upload', requireAuth, portfolioUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл обязателен' });
    const db = readDB();
    const card = db.portfolio.find(c => c.id === req.params.cardId && c.userId === req.session.userId);
    if (!card) return res.status(404).json({ error: 'Карточка не найдена' });

    const item = {
      id: uuidv4(),
      fileName: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      type: req.file.mimetype.startsWith('image/') ? 'image' :
             req.file.mimetype.startsWith('video/') ? 'video' : 'other'
    };
    card.items.push(item);
    writeDB(db);
    res.json({ success: true, item });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки файла' });
  }
});

// Создать папку в карточке
app.post('/api/portfolio/card/:cardId/folder', requireAuth, (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Название папки обязательно' });
    const db = readDB();
    const card = db.portfolio.find(c => c.id === req.params.cardId && c.userId === req.session.userId);
    if (!card) return res.status(404).json({ error: 'Карточка не найдена' });

    const folder = {
      id: uuidv4(),
      name,
      items: []
    };
    card.folders.push(folder);
    writeDB(db);
    res.json({ success: true, folder });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка создания папки' });
  }
});

// Загрузить файл в папку
app.post('/api/portfolio/card/:cardId/folder/:folderId/upload', requireAuth, portfolioUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл обязателен' });
    const db = readDB();
    const card = db.portfolio.find(c => c.id === req.params.cardId && c.userId === req.session.userId);
    if (!card) return res.status(404).json({ error: 'Карточка не найдена' });
    const folder = card.folders.find(f => f.id === req.params.folderId);
    if (!folder) return res.status(404).json({ error: 'Папка не найдена' });

    const item = {
      id: uuidv4(),
      fileName: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      type: req.file.mimetype.startsWith('image/') ? 'image' :
             req.file.mimetype.startsWith('video/') ? 'video' : 'other'
    };
    folder.items.push(item);
    writeDB(db);
    res.json({ success: true, item });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки в папку' });
  }
});

// Удалить карточку
app.delete('/api/portfolio/card/:cardId', requireAuth, (req, res) => {
  try {
    const db = readDB();
    const index = db.portfolio.findIndex(c => c.id === req.params.cardId && c.userId === req.session.userId);
    if (index === -1) return res.status(404).json({ error: 'Карточка не найдена' });
    db.portfolio.splice(index, 1);
    writeDB(db);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления карточки' });
  }
});

// Получить карточку
app.get('/api/portfolio/card/:cardId', (req, res) => {
  try {
    const db = readDB();
    const card = db.portfolio.find(c => c.id === req.params.cardId);
    if (!card) return res.status(404).json({ error: 'Карточка не найдена' });
    res.json(card);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки карточки' });
  }
});

// Страница просмотра карточки
app.get('/portfolio/view', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portfolio-view.html'));
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
    socket.to(data.projectId).emit('camera-updated', { userId: socket.id, position: data.position, rotation: data.rotation });
  });
  socket.on('annotation-add', (data) => {
    socket.to(data.projectId).emit('annotation-added', { userId: socket.id, annotation: data.annotation });
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
});