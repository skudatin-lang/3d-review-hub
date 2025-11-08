// server.js — исправленная версия с портфолио и РАБОТАЮЩЕЙ загрузкой
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

// === Папки ===
const UPLOADS_PROJECTS = 'uploads/projects';
const UPLOADS_PORTFOLIO = 'uploads/portfolio';
const DB_FILE = 'database.json';

[UPLOADS_PROJECTS, UPLOADS_PORTFOLIO].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// === Multer Storage ===
const projectStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_PROJECTS),
  filename: (req, file, cb) => cb(null, `${uuidv4()}_${file.originalname}`)
});

const portfolioStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_PORTFOLIO),
  filename: (req, file, cb) => cb(null, `${uuidv4()}_${file.originalname}`)
});

const uploadProject = multer({
  storage: projectStorage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.stl', '.glb', '.obj'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Только .stl, .glb, .obj'));
  },
  limits: { fileSize: 100 * 1024 * 1024 }
});

const uploadPortfolio = multer({ storage: portfolioStorage, limits: { fileSize: 100 * 1024 * 1024 } });

// === База данных (как у вас) ===
function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], projects: [], portfolioItems: [] }));
      return { users: [], projects: [], portfolioItems: [] };
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.error('DB error:', e);
    return { users: [], projects: [], portfolioItems: [] };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// === Middleware ===
app.use(session({
  secret: process.env.SESSION_SECRET || '3d-review-hub-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));
app.use('/models', express.static('uploads'));
app.use('/portfolio-media', express.static('uploads'));

function requireAuth(req, res, next) {
  if (req.session.userId) next();
  else res.redirect('/login');
}

// === Аутентификация (как у вас) ===
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/view/:projectId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'viewer.html')));
app.get('/portfolio/:userId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'portfolio.html')));
app.get('/portfolio/:userId/project/:itemId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'portfolio-project.html')));

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

// === Проекты — ИСПОЛЬЗУЕМ ПРЯМОЙ MIDDLEWARE (как у вас) ===
app.get('/api/projects', requireAuth, (req, res) => {
  const db = readDB();
  res.json(db.projects.filter(p => p.userId === req.session.userId));
});

// 🔥 ВАЖНО: uploadProject.single('model') КАК MIDDLEWARE
app.post('/api/projects', requireAuth, uploadProject.single('model'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Модель обязательна' });
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
      expiresAt: expiresAt.toISOString(),
      screenshots: []
    };

    db.projects.push(project);
    writeDB(db);
    cleanupExpiredProjects();
    res.json({ success: true, project: { ...project, shareUrl: fullUrl } });
  } catch (error) {
    console.error('Ошибка создания проекта:', error);
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

// === Портфолио — ТОЖЕ ЧЕРЕЗ MIDDLEWARE ===
app.get('/api/portfolio-items', requireAuth, (req, res) => {
  const db = readDB();
  const items = db.portfolioItems?.filter(i => i.userId === req.session.userId) || [];
  const sections = [...new Set(items.map(i => i.section || 'Основное'))].sort();
  res.json({ items, sections });
});

// 🔥 ВАЖНО: uploadPortfolio.fields(...) КАК MIDDLEWARE
app.post('/api/portfolio-items', requireAuth, uploadPortfolio.fields([
  { name: 'preview', maxCount: 1 },
  { name: 'model', maxCount: 1 },
  { name: 'video', maxCount: 1 }
]), (req, res) => {
  try {
    const { title, description, section } = req.body;
    if (!title) return res.status(400).json({ error: 'Название обязательно' });

    const newItem = {
      id: uuidv4(),
      userId: req.session.userId,
      title,
      description: description || '',
      section: section || 'Основное',
      previewFile: req.files?.preview?.[0]?.filename || null,
      modelFile: req.files?.model?.[0]?.filename || null,
      videoFile: req.files?.video?.[0]?.filename || null,
      createdAt: new Date().toISOString()
    };

    const db = readDB();
    if (!db.portfolioItems) db.portfolioItems = [];
    db.portfolioItems.push(newItem);
    writeDB(db);
    res.json({ success: true, item: newItem });
  } catch (error) {
    console.error('Ошибка портфолио:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/portfolio-items/:id', requireAuth, (req, res) => {
  const db = readDB();
  db.portfolioItems = db.portfolioItems?.filter(i => !(i.id === req.params.id && i.userId === req.session.userId)) || [];
  writeDB(db);
  res.json({ success: true });
});

app.get('/api/public-portfolio/:userId', (req, res) => {
  const db = readDB();
  const user = db.users.find(u => u.id === req.params.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const items = (db.portfolioItems || []).filter(i => i.userId === req.params.userId);
  const sections = [...new Set(items.map(i => i.section || 'Основное'))].sort();
  res.json({ user: { id: user.id, name: user.name }, items, sections });
});

// === Вспомогательные ===
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

// === Запуск ===
server.listen(PORT, () => {
  console.log(`✅ 3D Review Hub запущен на порту ${PORT}`);
});