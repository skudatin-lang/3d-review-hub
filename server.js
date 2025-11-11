// server.js - ПОЛНАЯ ИСПРАВЛЕННАЯ ВЕРСИЯ
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const helmet = require('helmet');
const compression = require('compression');
const multer = require('multer');
const fs = require('fs');

// Импорт модулей
const shared = require('./modules/shared');
const auth = require('./modules/auth');
const projects = require('./modules/projects');
const portfolio = require('./modules/portfolio');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Создаем папку uploads если не существует
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Middleware безопасности
app.use(helmet({
    contentSecurityPolicy: false
}));

app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static(uploadsDir));

// ФИКС: Правильная настройка сессий
app.use(session({
    store: new PgSession({ 
        conString: process.env.DATABASE_URL,
        tableName: 'user_sessions',
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || 'fallback-secret-key-12345-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        maxAge: 24 * 60 * 60 * 1000,
        secure: false,
        httpOnly: true
    }
}));

// Middleware для логирования запросов
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

// Middleware проверки авторизации
function requireAuth(req, res, next) {
    console.log('Проверка авторизации, userId:', req.session.userId);
    if (req.session.userId) {
        return next();
    }
    
    if (req.xhr || req.headers.accept.indexOf('json') > -1) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    } else {
        return res.redirect('/login');
    }
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
        console.log('Регистрация:', req.body);
        const result = await auth.register(req.body);
        if (result.success) {
            req.session.userId = result.userId;
            console.log('Успешная регистрация, userId:', result.userId);
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
        console.log('Вход:', req.body);
        const result = await auth.login(req.body);
        if (result.success) {
            req.session.userId = result.user.id;
            console.log('Успешный вход, userId:', result.user.id);
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
    console.log('Выход пользователя:', req.session.userId);
    req.session.destroy((err) => {
        if (err) {
            console.error('Ошибка выхода:', err);
            return res.status(500).json({ error: 'Ошибка выхода' });
        }
        res.json({ success: true, redirect: '/' });
    });
});

// Получение информации о пользователе
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
        console.log('Создание проекта, файл:', req.file);
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

// Просмотр проекта
app.get('/api/view/:projectId', async (req, res) => {
    try {
        const project = await projects.getProjectForView(req.params.projectId, req.query.password);
        res.json(project);
    } catch (error) {
        console.error('Ошибка загрузки проекта:', error);
        res.status(404).json({ error: error.message });
    }
});

// Портфолио (API нового модуля)
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

// Health check для Render
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
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

// ==================== ОБРАБОТКА ОШИБОК ====================

// Обработка ошибок multer
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'Файл слишком большой (макс. 100MB)' });
        }
        if (error.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({ error: 'Неожиданное поле для загрузки файла' });
        }
    }
    
    if (error.message.includes('Только STL, GLB, OBJ')) {
        return res.status(400).json({ error: 'Разрешены только файлы STL, GLB, OBJ' });
    }
    
    next(error);
});

// Централизованный обработчик ошибок
app.use((error, req, res, next) => {
    console.error('Ошибка сервера:', error);
    
    // Если это ошибка базы данных
    if (error.code && error.code.startsWith('23')) {
        return res.status(500).json({ 
            error: 'Ошибка базы данных' 
        });
    }
    
    res.status(500).json({ 
        error: process.env.NODE_ENV === 'production' 
            ? 'Внутренняя ошибка сервера' 
            : error.message 
    });
});

// 404 обработчик для API
app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'API endpoint не найден' });
});

// 404 обработчик для страниц
app.use((req, res) => {
    if (req.accepts('html')) {
        res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
    } else if (req.accepts('json')) {
        res.status(404).json({ error: 'Страница не найдена' });
    } else {
        res.status(404).type('txt').send('Страница не найдена');
    }
});

// ==================== ЗАПУСК СЕРВЕРА ====================

async function startServer() {
    try {
        console.log('🔄 Запуск 3D Review Hub...');
        
        // Инициализация базы данных и подключений
        await shared.connectDB();
        console.log('✅ База данных подключена');
        
        await shared.initializeDatabase();
        console.log('✅ Таблицы инициализированы');
        
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 3D Review Hub запущен на порту ${PORT}`);
            console.log(`📊 Режим: ${process.env.NODE_ENV || 'development'}`);
            console.log(`🌐 URL: http://localhost:${PORT}`);
            console.log(`🗄️  База данных: PostgreSQL`);
            console.log(`☁️  Файловое хранилище: ${process.env.BACKBLAZE_KEY_ID ? 'Backblaze B2' : 'Локальное'}`);
            console.log(`🧩  Модули: auth, projects, portfolio`);
            console.log(`🔧 Health check: http://localhost:${PORT}/health`);
        });
        
    } catch (error) {
        console.error('❌ Не удалось запустить сервер:', error.message);
        console.error('Stack trace:', error.stack);
        process.exit(1);
    }
}

// Обработка graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🔄 Получен SIGTERM, завершаем работу...');
    try {
        await shared.db.end();
        console.log('✅ База данных отключена');
        server.close(() => {
            console.log('✅ Сервер остановлен');
            process.exit(0);
        });
    } catch (error) {
        console.error('❌ Ошибка при завершении:', error);
        process.exit(1);
    }
});

process.on('uncaughtException', (error) => {
    console.error('❌ Неперехваченное исключение:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Необработанное обещание:', reason);
    process.exit(1);
});

startServer();