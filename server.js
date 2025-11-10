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

// Используем PORT из Render или 3000 локально
const PORT = process.env.PORT || 3000;
const DB_FILE = 'database.json';

// === Убедимся, что директории существуют ===
const ensureDirs = () => {
  const dirs = ['uploads/projects', 'public'];
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
};
ensureDirs();

// === Работа с БД ===
function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], projects: [], portfolio: [] }));
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (error) {
    console.error('Ошибка чтения БД:', error);
    return { users: [], projects: [], portfolio: [] };
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Ошибка записи БД:', error);
  }
}

// === Сессии ===
app.use(session({
  secret: process.env.SESSION_SECRET || '3d-review-hub-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// === Статика и парсинг ===
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/models', express.static('uploads'));

// === Middleware авторизации ===
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

// 🔥 НОВАЯ СТРАНИЦА: ПОРТФОЛИО
app.get('/portfolio', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portfolio.html'));
});

// === Аутентификация (как у вас) ===
// ... (оставьте ваш существующий код register/login/logout без изменений)

// === API: проекты (как у вас) ===
// ... (оставьте /api/projects и связанные маршруты)

// === 🔥 НОВОЕ API: портфолио ===
app.get('/api/portfolio', requireAuth, (req, res) => {
  const db = readDB();
  const userPortfolio = db.portfolio.filter(item => item.userId === req.session.userId);
  res.json(userPortfolio);
});

app.post('/api/portfolio', requireAuth, upload.single('file'), (req, res) => {
  try {
    const { name, description, folder = '' } = req.body;
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
  } catch (error) {
    console.error('Ошибка добавления в портфолио:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// === Просмотр модели (без изменений) ===
app.get('/view/:projectId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

app.get('/api/view/:projectId', (req, res) => {
  // ... ваш существующий код
});

// === WebSocket (без изменений) ===
// ... ваш существующий код

// === Обработка 404 ===
app.use((req, res) => {
  res.status(404).send('Страница не найдена');
});

// === Запуск ===
server.listen(PORT, () => {
  console.log(`🚀 3D Review Hub запущен на порту ${PORT}`);
});