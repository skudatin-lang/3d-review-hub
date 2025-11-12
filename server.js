// server.js - ПРОФЕССИОНАЛЬНАЯ ВЕРСИЯ
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

// Импорт модулей
const shared = require('./modules/shared');
const auth = require('./modules/auth');
const projects = require('./modules/projects');
const portfolio = require('./modules/portfolio');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// ==================== НАСТРОЙКИ БЕЗОПАСНОСТИ ====================

// Лимит запросов
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 100 // максимум 100 запросов с одного IP
});
app.use(limiter);

// Заголовки безопасности
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: ["'self'", "ws:", "wss:"],
            fontSrc: ["'self'", "https://cdn.jsdelivr.net"]
        }
    },
    crossOriginEmbedderPolicy: false
}));

app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public', { 
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : '0'
}));

// Сессии
app.use(session({
    store: new PgSession({
        conString: process.env.DATABASE_URL,
        tableName: 'user_sessions',
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 дней
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// ==================== MIDDLEWARE ====================

// Логирование
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} ${req.method} ${req.url} - ${req.ip}`);
    next();
});

// Проверка авторизации
function requireAuth(req, res, next) {
    if (req.session.userId) {
        return next();
    }
    
    if (req.xhr || req.headers.accept.indexOf('json') > -1) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    } else {
        return res.redirect('/login');
    }
}

// Проверка API ключа (для будущего API)
function requireApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    // Здесь можно добавить проверку API ключа
    next();
}

// ==================== РОУТЫ СТРАНИЦ ====================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/dashboard');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
    if (req.session.userId) return res.redirect('/dashboard');
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/dashboard', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/portfolio', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'portfolio.html'));
});

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
        console.error('Ошибка регистрации:', error);
        res.status(500).json({ error: 'Ошибка сервера при регистрации' });
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
        console.error('Ошибка входа:', error);
        res.status(500).json({ error: 'Ошибка сервера при входе' });
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

app.get('/api/user', requireAuth, async (req, res) => {
    try {
        const user = await auth.getUserById(req.session.userId);
        if (user) {
            res.json({ success: true, user });
        } else {
            res.status(404).json({ error: 'Пользователь не найден' });
        }
    } catch (error) {
        console.error('Ошибка получения пользователя:', error);
        res.status(500).json({ error: 'Ошибка получения данных пользователя' });
    }
});

// Проекты
app.get('/api/projects', requireAuth, async (req, res) => {
    try {
        const projects = await projects.getUsersProjects(req.session.userId);
        res.json(projects);
    } catch (error) {
        console.error('Ошибка загрузки проектов:', error);
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
        console.error('Ошибка создания проекта:', error);
        res.status(500).json({ error: 'Ошибка создания проекта: ' + error.message });
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
        console.error('Ошибка архивации:', error);
        res.status(500).json({ error: 'Ошибка архивации' });
    }
});

app.get('/api/projects/stats', requireAuth, async (req, res) => {
    try {
        const stats = await projects.getUserStats(req.session.userId);
        res.json({ success: true, stats });
    } catch (error) {
        console.error('Ошибка получения статистики:', error);
        res.status(500).json({ error: 'Ошибка получения статистики' });
    }
});

// Просмотр проекта
app.get('/api/view/:projectId', async (req, res) => {
    try {
        const project = await projects.getProjectForView(req.params.projectId, req.query.password);
        
        // Увеличиваем счетчик просмотров
        await shared.db.query(
            'UPDATE projects SET views_count = views_count + 1 WHERE id = $1',
            [req.params.projectId]
        );
        
        res.json(project);
    } catch (error) {
        console.error('Ошибка загрузки проекта:', error);
        res.status(404).json({ error: error.message });
    }
});

// Портфолио
app.get('/api/portfolio', requireAuth, async (req, res) => {
    try {
        const items = await portfolio.getPortfolioItems(req.session.userId);
        res.json(items);
    } catch (error) {
        console.error('Ошибка загрузки портфолио:', error);
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
        console.error('Ошибка добавления в портфолио:', error);
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
        console.error('Ошибка удаления из портфолио:', error);
        res.status(500).json({ error: 'Ошибка удаления из портфолио' });
    }
});

// ==================== WebSocket ====================

io.on('connection', (socket) => {
    console.log('Новое WebSocket подключение:', socket.id);
    
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

    socket.on('disconnect', () => {
        console.log('WebSocket отключен:', socket.id);
    });
});

// ==================== СЛУЖЕБНЫЕ РОУТЫ ====================

app.get('/health', async (req, res) => {
    try {
        // Проверяем подключение к БД
        await shared.db.query('SELECT 1');
        
        res.status(200).json({ 
            status: 'OK', 
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development',
            database: 'connected',
            storage: 'backblaze_b2'
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'ERROR', 
            error: error.message 
        });
    }
});

app.get('/api/status', requireAuth, async (req, res) => {
    try {
        const userStats = await projects.getUserStats(req.session.userId);
        const portfolioCount = await portfolio.getPortfolioItems(req.session.userId);
        
        res.json({
            success: true,
            user: await auth.getUserById(req.session.userId),
            stats: userStats,
            portfolioCount: portfolioCount.length
        });
    } catch (error) {
        console.error('Ошибка получения статуса:', error);
        res.status(500).json({ error: 'Ошибка получения статуса' });
    }
});

// ==================== ОБРАБОТКА ОШИБОК ====================

// 404 для API
app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'API endpoint не найден' });
});

// 404 для страниц
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Централизованный обработчик ошибок
app.use((error, req, res, next) => {
    console.error('Ошибка сервера:', error);
    
    const errorResponse = {
        error: process.env.NODE_ENV === 'production' 
            ? 'Внутренняя ошибка сервера' 
            : error.message,
        ...(process.env.NODE_ENV !== 'production' && { stack: error.stack })
    };
    
    res.status(500).json(errorResponse);
});

// ==================== ЗАПУСК СЕРВЕРА ====================

async function startServer() {
    try {
        console.log('🔄 Запуск профессиональной платформы 3D Review Hub...');
        
        // Инициализация базы данных и подключений
        await shared.connectDB();
        await shared.initializeDatabase();
        
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 3D Review Hub (PRO) запущен на порту ${PORT}`);
            console.log(`📊 Режим: ${process.env.NODE_ENV || 'development'}`);
            console.log(`🌐 URL: http://localhost:${PORT}`);
            console.log(`🗄️  База данных: PostgreSQL`);
            console.log(`☁️  Файловое хранилище: Backblaze B2`);
            console.log(`🔧 Health check: http://localhost:${PORT}/health`);
            console.log(`💼 Профессиональная платформа готова к работе!`);
        });
        
    } catch (error) {
        console.error('❌ Не удалось запустить сервер:', error.message);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🔄 Получен SIGTERM, завершаем работу...');
    server.close(() => {
        console.log('✅ Сервер остановлен');
        process.exit(0);
    });
});

startServer();