// server.js
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

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});
app.use(limiter);

app.use(helmet({
    contentSecurityPolicy: false
}));

app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

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
        maxAge: 30 * 24 * 60 * 60 * 1000,
        secure: false,
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// ==================== MIDDLEWARE ====================

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

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
        console.log('📝 Запрос на регистрацию:', req.body);
        
        const result = await auth.register(req.body);
        
        if (result.success) {
            req.session.userId = result.userId;
            req.session.save((err) => {
                if (err) {
                    console.error('❌ Ошибка сохранения сессии:', err);
                    return res.status(500).json({ error: 'Ошибка создания сессии' });
                }
                
                console.log('✅ Сессия создана для пользователя:', result.userId);
                res.json({ 
                    success: true, 
                    redirect: '/dashboard',
                    user: result.user 
                });
            });
        } else {
            console.log('❌ Ошибка регистрации:', result.error);
            res.status(400).json({ error: result.error });
        }
        
    } catch (error) {
        console.error('❌ Серверная ошибка при регистрации:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        console.log('🔐 Запрос на вход:', req.body.email);
        
        const result = await auth.login(req.body);
        
        if (result.success) {
            req.session.userId = result.user.id;
            req.session.save((err) => {
                if (err) {
                    console.error('❌ Ошибка сохранения сессии:', err);
                    return res.status(500).json({ error: 'Ошибка создания сессии' });
                }
                
                console.log('✅ Успешный вход, сессия создана:', result.user.id);
                res.json({ 
                    success: true, 
                    redirect: '/dashboard',
                    user: result.user 
                });
            });
        } else {
            console.log('❌ Ошибка входа:', result.error);
            res.status(400).json({ error: result.error });
        }
        
    } catch (error) {
        console.error('❌ Серверная ошибка при входе:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

app.post('/api/logout', (req, res) => {
    console.log('🚪 Запрос на выход пользователя:', req.session.userId);
    
    req.session.destroy((err) => {
        if (err) {
            console.error('❌ Ошибка выхода:', err);
            return res.status(500).json({ error: 'Ошибка выхода' });
        }
        
        console.log('✅ Сессия уничтожена');
        res.json({ success: true, redirect: '/' });
    });
});

app.get('/api/user', requireAuth, async (req, res) => {
    try {
        console.log('👤 Запрос данных пользователя:', req.session.userId);
        
        const user = await auth.getUserById(req.session.userId);
        if (user) {
            res.json({ success: true, user });
        } else {
            console.log('❌ Пользователь не найден в БД');
            res.status(404).json({ error: 'Пользователь не найден' });
        }
    } catch (error) {
        console.error('❌ Ошибка получения пользователя:', error);
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

// ==================== ОБРАБОТКА ОШИБОК ====================

app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'API endpoint не найден' });
});

app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.use((error, req, res, next) => {
    console.error('Ошибка сервера:', error);
    
    res.status(500).json({ 
        error: 'Внутренняя ошибка сервера'
    });
});

// ==================== ЗАПУСК СЕРВЕРА ====================

async function startServer() {
    try {
        console.log('🔄 Запуск профессиональной платформы 3D Review Hub...');
        
        await shared.connectDB();
        await shared.checkDatabaseConnection();
        await shared.checkTablesExist();
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

process.on('SIGTERM', async () => {
    console.log('🔄 Получен SIGTERM, завершаем работу...');
    server.close(() => {
        console.log('✅ Сервер остановлен');
        process.exit(0);
    });
});

startServer();