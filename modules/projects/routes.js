// modules/projects/routes.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../../db/client');

const router = express.Router();

// Загрузка
const upload = multer({
  dest: 'uploads/projects/',
  fileFilter: (req, file, cb) => {
    const allowed = ['.stl', '.glb', '.obj'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Разрешены: .stl, .glb, .obj'));
  },
  limits: { fileSize: 100 * 1024 * 1024 }
});

// Middleware авторизации
const { requireAuth } = require('../auth/routes');

// API: проекты
router.get('/api/projects', requireAuth, async (req, res) => {
  try {
    const projects = await db.query('SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC', [req.session.userId]);
    res.json(projects.rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки проектов' });
  }
});

// API: создание проекта
router.post('/api/projects', requireAuth, upload.single('model'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл модели обязателен' });
    const { name, description, expiresIn = '24', password = '', mode = 'individual' } = req.body;
    if (!name) return res.status(400).json({ error: 'Название обязательно' });

    const expiresAt = new Date(Date.now() + parseInt(expiresIn) * 3600000);
    const projectId = uuidv4();
    const fullShareUrl = `${req.protocol}://${req.get('host')}/view/${projectId}`;

    await db.query(`
      INSERT INTO projects 
      (id, user_id, name, description, model_file, model_original_name, share_url, full_share_url, password, mode, status, expires_at) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
      projectId, req.session.userId, name, description || '',
      req.file.filename, req.file.originalname,
      `/view/${projectId}`, fullShareUrl,
      password || '', mode || 'individual', 'active', expiresAt
    ]);

    res.json({
      success: true,
      project: { id: projectId, name, shareUrl: fullShareUrl, expiresAt }
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка создания проекта' });
  }
});

// Другие роуты (архивация, просмотр) — по аналогии

module.exports = router;