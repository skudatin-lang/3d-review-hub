// server.js - основной управляющий файл
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const helmet = require('helmet');
const compression = require('compression');

// Импорт модулей
const shared = require('./modules/shared');
const auth = require('./modules/auth');
const projects = require('./modules/projects');
const portfolio = require('./modules/portfolio');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Middleware безопасности
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: ["'self'", "ws:", "wss:"]
        }
    }
}));

app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public', { 
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : '0'
}));

// Сессии
app.use(session({
    store: new PgSession({ 
        pool: shared.db,
        tableName: 'user_sessions'
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        maxAge: 24 * 60 * 60 * 1000,
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true
    }
}));

// Middleware проверки авторизации
function requireAuth(req, res, next) {
    if (req.session.userId) {
        return next();
    }
    res.redirect('/login');
}

// ==================== РОУТЫ СТРАНИЦ ====================

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Страницы аутентификации
app.get('/login', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/dashboard');
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/dashboard');
    }
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// Дашборд (главный хаб)
app.get('/dashboard', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Портфолио (новый модуль)
app.get('/portfolio', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'portfolio.html'));
});

// Просмотрщик
app.get('/view/:projectId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// ==================== API РОУТЫ ====================

// Аутентификация
app.post('/api/register', async (req, res) => {
    try {
        const result = await auth.register(req.body);
        if (result.success) {
            req.session.userId = result.userId;
            res.json({ success: true, redirect: '/dashboard' });
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const result = await auth.login(req.body);
        if (result.success) {
            req.session.userId = result.user.id;
            res.json({ 
                success: true, 
                redirect: '/dashboard',
                user: result.user 
            });
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Ошибка выхода' });
        }
        res.json({ success: true, redirect: '/' });
    });
});

// Проекты
app.get('/api/projects', requireAuth, async (req, res) => {
    try {
        const projects = await projects.getUsersProjects(req.session.userId);
        res.json(projects);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка загрузки проектов' });
    }
});

app.post('/api/projects', requireAuth, projects.getUploadMiddleware(), async (req, res) => {
    try {
        const result = await projects.createProject(req.session.userId, req.body, req.file);
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: 'Ошибка создания проекта' });
    }
});

app.post('/api/projects/:projectId/archive', requireAuth, async (req, res) => {
    try {
        const result = await projects.archiveProject(req.session.userId, req.params.projectId);
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: 'Ошибка архивации' });
    }
});

// Просмотр проекта
app.get('/api/view/:projectId', async (req, res) => {
    try {
        const project = await projects.getProjectForView(req.params.projectId, req.query.password);
        res.json(project);
    } catch (error) {
        res.status(404).json({ error: error.message });
    }
});

// Портфолио (API нового модуля)
app.get('/api/portfolio', requireAuth, async (req, res) => {
    try {
        const items = await portfolio.getPortfolioItems(req.session.userId);
        res.json(items);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка загрузки портфолио' });
    }
});

app.post('/api/portfolio', requireAuth, async (req, res) => {
    try {
        const result = await portfolio.addPortfolioItem(req.session.userId, req.body);
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: 'Ошибка добавления в портфолио' });
    }
});

app.delete('/api/portfolio/:itemId', requireAuth, async (req, res) => {
    try {
        const result = await portfolio.deletePortfolioItem(req.session.userId, req.params.itemId);
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: 'Ошибка удаления из портфолио' });
    }
});

// ==================== WebSocket ====================

io.on('connection', (socket) => {
    socket.on('join-room', (projectId) => {
        socket.join(projectId);
        socket.to(projectId).emit('user-joined', { userId: socket.id });
    });

    socket.on('camera-update', (data) => {
        socket.to(data.projectId).emit('camera-updated', { 
            userId: socket.id, 
            ...data 
        });
    });

    socket.on('annotation-add', (data) => {
        socket.to(data.projectId).emit('annotation-added', { 
            userId: socket.id, 
            annotation: data.annotation 
        });
    });
});

// ==================== ОБРАБОТКА ОШИБОК ====================

// Обработка ошибок multer
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'Файл слишком большой (макс. 100MB)' });
        }
    }
    next(error);
});

// Централизованный обработчик ошибок
app.use((error, req, res, next) => {
    console.error('Ошибка сервера:', error);
    res.status(500).json({ 
        error: process.env.NODE_ENV === 'production' 
            ? 'Внутренняя ошибка сервера' 
            : error.message 
    });
});

// 404 обработчик
app.use((req, res) => {
    res.status(404).json({ error: 'Страница не найдена' });
});

// ==================== ЗАПУСК СЕРВЕРА ====================

async function startServer() {
    try {
        // Инициализация базы данных и подключений
        await shared.connectDB();
        await shared.initializeDatabase();
        
        server.listen(PORT, () => {
            console.log(`🚀 3D Review Hub запущен на порту ${PORT}`);
            console.log(`📊 Режим: ${process.env.NODE_ENV || 'development'}`);
            console.log(`🗄️  База данных: PostgreSQL`);
            console.log(`☁️  Файловое хранилище: Backblaze B2`);
            console.log(`🧩  Модули: auth, projects, portfolio`);
        });
    } catch (error) {
        console.error('❌ Не удалось запустить сервер:', error.message);
        process.exit(1);
    }
}

startServer();