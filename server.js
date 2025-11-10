// server.js
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

const PORT = process.env.PORT || 3000;
const DB_FILE = 'database.json';

// === Создаем папки при старте ===
const ensureDirs = () => {
  const dirs = ['uploads/projects', 'public'];
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
};
ensureDirs();

// === БД ===
function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const initial = { users: [], projects: [], portfolio: [] };
      fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
      return initial;
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (error) {
    console.error('Ошибка БД:', error);
    return { users: [], projects: [], portfolio: [] };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// === Сессии ===
app.use(session({
  secret: process.env.SESSION_SECRET || '3d-review-hub-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// === Загрузка файлов ===
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/projects');
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}_${file.originalname}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.stl', '.glb', '.obj'].includes(ext)) cb(null, true);
    else cb(new Error('Только STL, GLB, OBJ'));
  },
  limits: { fileSize: 100 * 1024 * 1024 }
});

// === Middleware ===
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/models', express.static('uploads'));

function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login');
}

// === Маршруты ===
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

// 🔥 НОВАЯ СТРАНИЦА
app.get('/portfolio', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portfolio.html'));
});

// === Аутентификация (оставляем как есть) ===
app.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Все поля обязательны' });
    }
    const db = readDB();
    if (db.users.find(u => u.email === email)) {
      return res.status(400).json({ error: 'Email уже занят' });
    }
    const hashed = await bcrypt.hash(password, 10);
    const user = { id: uuidv4(), email, password: hashed, name, createdAt: new Date().toISOString(), plan: 'free' };
    db.users.push(user);
    writeDB(db);
    req.session.userId = user.id;
    res.json({ success: true, redirect: '/dashboard' });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.email === email);
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(400).json({ error: 'Неверный email или пароль' });
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

// === API: Проекты ===
app.get('/api/projects', requireAuth, (req, res) => {
  const db = readDB();
  res.json(db.projects.filter(p => p.userId === req.session.userId));
});

app.post('/api/projects', requireAuth, upload.single('model'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл обязателен' });
    const { name, description, expiresIn = '24', password = '', mode = 'individual' } = req.body;
    if (!name) return res.status(400).json({ error: 'Название обязательно' });

    const db = readDB();
    const user = db.users.find(u => u.id === req.session.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const active = db.projects.filter(p => p.userId === user.id && p.status === 'active');
    if (user.plan === 'free' && active.length >= 3) {
      return res.status(400).json({ error: 'Лимит: 3 проекта на Free' });
    }

    const id = uuidv4();
    const expiresAt = new Date(Date.now() + parseInt(expiresIn) * 60 * 60 * 1000);
    const project = {
      id, userId: user.id, userName: user.name, name, description: description || '',
      modelFile: req.file.filename, modelOriginalName: req.file.originalname,
      shareUrl: `/view/${id}`,
      fullShareUrl: `${req.protocol}://${req.get('host')}/view/${id}`,
      password, mode, status: 'active',
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      screenshots: []
    };

    db.projects.push(project);
    writeDB(db);
    res.json({ success: true, project: { id, name, shareUrl: project.fullShareUrl, expiresAt: project.expiresAt } });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка создания проекта' });
  }
});

app.post('/api/projects/:projectId/archive', requireAuth, (req, res) => {
  const db = readDB();
  const p = db.projects.find(p => p.id === req.params.projectId && p.userId === req.session.userId);
  if (!p) return res.status(404).json({ error: 'Проект не найден' });
  p.status = 'archived';
  writeDB(db);
  res.json({ success: true });
});

// === API: Портфолио ===
app.get('/api/portfolio', requireAuth, (req, res) => {
  const db = readDB();
  res.json(db.portfolio.filter(i => i.userId === req.session.userId));
});

app.post('/api/portfolio', requireAuth, upload.single('file'), (req, res) => {
  try {
    const { name, description, folder = '' } = req.body;
    if (!name) return res.status(400).json({ error: 'Название обязательно' });

    const db = readDB();
    const user = db.users.find(u => u.id === req.session.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const item = {
      id: uuidv4(),
      userId: user.id,
      name,
      description: description || '',
      folder: folder || '',
      file: req.file ? req.file.filename : null,
      originalName: req.file ? req.file.originalname : null,
      fileType: req.file ? path.extname(req.file.originalname).toLowerCase() : null,
      createdAt: new Date().toISOString()
    };

    db.portfolio.push(item);
    writeDB(db);
    res.json({ success: true, item });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка добавления в портфолио' });
  }
});

// === Просмотр модели ===
app.get('/view/:projectId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

app.get('/api/view/:projectId', (req, res) => {
  const db = readDB();
  const p = db.projects.find(p => p.id === req.params.projectId);
  if (!p) return res.status(404).json({ error: 'Проект не найден' });
  if (p.status !== 'active') return res.status(410).json({ error: 'Проект не активен' });
  if (new Date() > new Date(p.expiresAt)) {
    p.status = 'expired';
    writeDB(db);
    return res.status(410).json({ error: 'Срок действия истёк' });
  }
  if (p.password && p.password !== req.query.password) {
    return res.status(403).json({ error: 'Неверный пароль' });
  }
  res.json({
    modelUrl: `/models/projects/${p.modelFile}`,
    originalName: p.modelOriginalName,
    projectName: p.name,
    userName: p.userName,
    mode: p.mode
  });
});

// === WebSocket ===
const rooms = new Map();
io.on('connection', (socket) => {
  socket.on('join-room', (id) => {
    socket.join(id);
    if (!rooms.has(id)) rooms.set(id, new Set());
    rooms.get(id).add(socket.id);
    socket.to(id).emit('user-joined', { userId: socket.id });
  });

  socket.on('camera-update', (data) => {
    socket.to(data.projectId).emit('camera-updated', { userId: socket.id, ...data });
  });

  socket.on('annotation-add', (data) => {
    socket.to(data.projectId).emit('annotation-added', { userId: socket.id, annotation: data.annotation });
  });

  socket.on('disconnect', () => {
    for (const [id, users] of rooms.entries()) {
      if (users.delete(socket.id) && users.size === 0) rooms.delete(id);
    }
  });
});

// === Очистка ===
function cleanup() {
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
}
setInterval(cleanup, 6 * 60 * 60 * 1000);

// === Запуск ===
server.listen(PORT, () => {
  console.log(`🚀 3D Review Hub запущен на порту ${PORT}`);
});