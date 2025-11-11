// modules/projects.js
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const shared = require('./shared');

// Настройка multer для загрузки в память
const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        const ext = file.originalname.toLowerCase().split('.').pop();
        if (['.stl', '.glb', '.obj'].includes('.' + ext)) {
            cb(null, true);
        } else {
            cb(new Error('Только STL, GLB, OBJ файлы разрешены'), false);
        }
    },
    limits: { fileSize: 100 * 1024 * 1024 }
});

class ProjectsModule {
    getUploadMiddleware() {
        return upload.single('model');
    }

    async getUsersProjects(userId) {
        try {
            const result = await shared.db.query(
                'SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC',
                [userId]
            );
            return result.rows;
        } catch (error) {
            console.error('Ошибка загрузки проектов:', error);
            throw error;
        }
    }

    async createProject(userId, projectData, file) {
        try {
            const { name, description, expiresIn = '24', password = '', mode = 'individual' } = projectData;

            if (!name) {
                throw new Error('Название обязательно');
            }

            if (!file) {
                throw new Error('Файл модели обязателен');
            }

            // Проверка лимита проектов
            const activeCount = await shared.db.query(
                'SELECT COUNT(*) FROM projects WHERE user_id = $1 AND status = $2',
                [userId, 'active']
            );

            if (parseInt(activeCount.rows[0].count) >= 3) {
                throw new Error('Лимит: 3 активных проекта на Free тарифе');
            }

            const id = uuidv4();
            const filename = `${uuidv4()}_${file.originalname}`;
            const fileUrl = await shared.uploadToB2(file.buffer, filename);
            
            const expiresAt = new Date(Date.now() + parseInt(expiresIn) * 60 * 60 * 1000);

            await shared.db.query(`
                INSERT INTO projects(
                    id, user_id, name, description, model_url, original_name,
                    share_url, password, mode, status, created_at, expires_at
                ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11)
            `, [
                id, userId, name, description || '', fileUrl, 
                file.originalname, `/view/${id}`, password, mode, 
                'active', expiresAt.toISOString()
            ]);

            const fullShareUrl = `${process.env.NODE_ENV === 'production' ? 'https://' : 'http://'}${process.env.HOST || 'localhost:3000'}/view/${id}`;

            return {
                success: true,
                project: { 
                    id, 
                    name, 
                    shareUrl: fullShareUrl, 
                    expiresAt 
                }
            };

        } catch (error) {
            console.error('Ошибка создания проекта:', error);
            return { success: false, error: error.message };
        }
    }

    async archiveProject(userId, projectId) {
        try {
            await shared.db.query(
                'UPDATE projects SET status = $1 WHERE id = $2 AND user_id = $3',
                ['archived', projectId, userId]
            );
            return { success: true };
        } catch (error) {
            console.error('Ошибка архивации проекта:', error);
            return { success: false, error: 'Ошибка архивации' };
        }
    }

    async getProjectForView(projectId, password = '') {
        try {
            const result = await shared.db.query(
                'SELECT * FROM projects WHERE id = $1', 
                [projectId]
            );

            if (result.rows.length === 0) {
                throw new Error('Проект не найден');
            }

            const project = result.rows[0];

            // Проверка статуса
            if (project.status !== 'active') {
                throw new Error('Проект недоступен');
            }

            // Проверка срока действия
            if (new Date() > new Date(project.expires_at)) {
                await this.archiveProject(project.user_id, projectId);
                throw new Error('Срок действия истёк');
            }

            // Проверка пароля
            if (project.password && project.password !== password) {
                throw new Error('Неверный пароль');
            }

            // Получаем информацию о пользователе
            const userResult = await shared.db.query(
                'SELECT name FROM users WHERE id = $1',
                [project.user_id]
            );

            return {
                modelUrl: project.model_url,
                originalName: project.original_name,
                projectName: project.name,
                userName: userResult.rows[0]?.name || 'Пользователь',
                mode: project.mode
            };

        } catch (error) {
            console.error('Ошибка загрузки проекта для просмотра:', error);
            throw error;
        }
    }
}

module.exports = new ProjectsModule();