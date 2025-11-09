// Создайте папку
const PORTFOLIO_DIR = 'uploads/portfolio/';
if (!fs.existsSync(PORTFOLIO_DIR)) fs.mkdirSync(PORTFOLIO_DIR, { recursive: true });

// Загрузка портфолио
const portfolioStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PORTFOLIO_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}_${file.originalname}`)
});
const portfolioUpload = multer({
  storage: portfolioStorage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg','.jpeg','.png','.mp4','.webm','.stl'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Недопустимый формат'));
  },
  limits: { fileSize: 200 * 1024 * 1024 }
});

// API: получить портфолио
app.get('/api/portfolio', requireAuth, (req, res) => {
  const db = readDB();
  const items = db.portfolio?.filter(i => i.userId === req.session.userId) || [];
  res.json(items);
});

// API: добавить в портфолио
app.post('/api/portfolio', requireAuth, portfolioUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл обязателен' });
  const db = readDB();
  if (!db.portfolio) db.portfolio = [];
  const item = {
    id: uuidv4(),
    userId: req.session.userId,
    title: req.body.title || 'Без названия',
    description: req.body.description || '',
    fileName: req.file.filename,
    originalName: req.file.originalname,
    createdAt: new Date().toISOString()
  };
  db.portfolio.push(item);
  writeDB(db);
  res.json({ success: true, item });
});

// Отдача файлов портфолио
app.use('/portfolio-files', express.static('uploads/portfolio'));