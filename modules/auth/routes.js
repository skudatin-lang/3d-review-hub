// modules/auth/routes.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../../db/client');
const path = require('path');

const router = express.Router();

// Middleware авторизации
const requireAuth = (req, res, next) => {
  if (req.session.userId) next();
  else res.redirect('/login');
};

// Главная
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Регистрация
router.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'register.html'));
});
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const user = await db.query(
      'INSERT INTO users (id, email, password, name, plan) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [uuidv4(), email, hashed, name, 'free']
    );
    req.session.userId = user.rows[0].id;
    res.json({ success: true, redirect: '/dashboard' });
  } catch (err) {
    if (err.code === '23505') {
      res.status(400).json({ error: 'Email уже используется' });
    } else {
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
});

// Вход
router.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (user.rows.length === 0) return res.status(400).json({ error: 'Пользователь не найден' });
    const valid = await bcrypt.compare(password, user.rows[0].password);
    if (!valid) return res.status(400).json({ error: 'Неверный пароль' });
    req.session.userId = user.rows[0].id;
    res.json({ success: true, redirect: '/dashboard' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Выход
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true, redirect: '/' }));
});

// Дашборд
router.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'dashboard.html'));
});

module.exports = { router, requireAuth };