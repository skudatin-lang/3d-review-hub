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
const UPLOADS_DIR = 'uploads/projects';

// Создаём папки
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}_${file.originalname}`)
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.stl', '.glb', '.obj'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Только .stl, .glb, .obj'));
  },
  limits: { fileSize: 100 * 1024 * 1024 }
});

// База данных
function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], projects: [] }));
      return { users: [], projects: [] };
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.error('DB error:', e);
    return { users: [], projects: [] };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Middleware
app.use(session({
  secret: process.env.SESSION_SECRET || '3d-review-hub-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/models', express.static('uploads'));

function requireAuth(req, res, next) {
  if (req.session.userId) next();
  else res.redirect('/login');
}

// === Роуты ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/view/:projectId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'viewer.html')));

// Аутентификация
app.post('/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Все поля обязательны' });
  const db = readDB();
  if (db.users.some(u => u.email === email)) return res.status(400).json({ error: 'Email уже используется' });
  const user = {
    id: uuidv4(),
    email,
    password: await bcrypt.hash(password, 10),
    name,
    createdAt: new Date().toISOString(),
    plan: 'free'
  };
  db.users.push(user);
  writeDB(db);
  req.session.userId = user.id;
  res.json({ success: true, redirect: '/dashboard' });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.email === email);
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(400).json({ error: 'Неверный email или пароль' });
  }
  req.session.userId = user.id;
  res.json({ success: true, redirect: '/dashboard' });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true, redirect: '/' }));
});

// Проекты
app.get('/api/projects', requireAuth, (req, res) => {
  const db = readDB();
  res.json(db.projects.filter(p => p.userId === req.session.userId));
});

app.post('/api/projects', requireAuth, upload.single('model'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл модели обязателен' });
    const { name, description, expiresIn = '24', password = '', mode = 'individual' } = req.body;
    if (!name) return res.status(400).json({ error: 'Название обязательно' });

    const db = readDB();
    const user = db.users.find(u => u.id === req.session.userId);
    const active = db.projects.filter(p => p.userId === user.id && p.status === 'active');
    if (user.plan === 'free' && active.length >= 3) {
      return res.status(400).json({ error: 'Лимит: 3 активных проекта' });
    }

    const projectId = uuidv4();
    const expiresAt = new Date(Date.now() + parseInt(expiresIn) * 3600000);
    const fullUrl = `${req.protocol}://${req.get('host')}/view/${projectId}`;

    const project = {
      id: projectId,
      userId: user.id,
      userName: user.name,
      name,
      description: description || '',
      modelFile: req.file.filename,
      modelOriginalName: req.file.originalname,
      shareUrl: `/view/${projectId}`,
      fullShareUrl: fullUrl,
      password,
      mode,
      status: 'active',
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString()
    };

    db.projects.push(project);
    writeDB(db);
    cleanupExpiredProjects();
    res.json({ success: true, project: { ...project, shareUrl: fullUrl } });
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/projects/:projectId/archive', requireAuth, (req, res) => {
  const db = readDB();
  const p = db.projects.find(p => p.id === req.params.projectId && p.userId === req.session.userId);
  if (p) p.status = 'archived';
  writeDB(db);
  res.json({ success: true });
});

app.get('/api/view/:projectId', (req, res) => {
  const db = readDB();
  const p = db.projects.find(p => p.id === req.params.projectId);
  if (!p) return res.status(404).json({ error: 'Проект не найден' });
  if (p.status !== 'active') return res.status(410).json({ error: 'Проект не активен' });
  if (new Date() > new Date(p.expiresAt)) {
    p.status = 'expired';
    writeDB(db);
    return res.status(410).json({ error: 'Срок истёк' });
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

// WebSocket
const activeRooms = new Map();
io.on('connection', (socket) => {
  socket.on('join-room', (projectId) => {
    socket.join(projectId);
    if (!activeRooms.has(projectId)) activeRooms.set(projectId, new Set());
    activeRooms.get(projectId).add(socket.id);
    socket.to(projectId).emit('user-joined', { userId: socket.id });
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

// Вспомогательные
function cleanupExpiredProjects() {
  const db = readDB();
  let changed = false;
  db.projects.forEach(p => {
    if (p.status === 'active' && new Date(p.expiresAt) < new Date()) {
      p.status = 'expired';
      changed = true;
    }
  });
  if (changed) writeDB(db);
}
setInterval(cleanupExpiredProjects, 6 * 3600 * 1000);

// Запуск
server.listen(PORT, () => {
  console.log(`✅ 3D Review Hub запущен на порту ${PORT}`);
});