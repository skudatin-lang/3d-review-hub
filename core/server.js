// core/server.js
const express = require('express');
const session = require('express-session');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Подключение модулей
const { router: authRoutes, requireAuth } = require('../modules/auth/routes');
const projectsRoutes = require('../modules/projects/routes');

// Сессии
app.use(session({
  secret: process.env.SESSION_SECRET || '3d-review-hub-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Статика
app.use(express.json());
app.use(express.static('public'));
app.use('/models', express.static('uploads/projects'));

// Роуты
app.use('/', authRoutes);
app.use('/', projectsRoutes);

// WebSocket — остаётся в ядре
io.on('connection', (socket) => {
  // ... ваша логика
});

// Запуск
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Запущен на порту ${PORT}`);
});