// modules/auth.js
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const shared = require('./shared');

class AuthModule {
    async register(userData) {
        try {
            const { email, password, name } = userData;
            const hashedPassword = await bcrypt.hash(password, 10);
            const id = uuidv4();

            await shared.db.query(
                'INSERT INTO users(id, email, password, name, plan, created_at) VALUES($1, $2, $3, $4, $5, NOW())',
                [id, email, hashedPassword, name, 'free']
            );

            return { success: true, userId: id };
        } catch (error) {
            if (error.code === '23505') {
                return { success: false, error: 'Email уже занят' };
            }
            console.error('Ошибка регистрации:', error);
            return { success: false, error: 'Ошибка регистрации' };
        }
    }

    async login(credentials) {
        try {
            const { email, password } = credentials;
            const result = await shared.db.query(
                'SELECT * FROM users WHERE email = $1', 
                [email]
            );

            if (result.rows.length === 0) {
                return { success: false, error: 'Пользователь не найден' };
            }

            const user = result.rows[0];
            const passwordMatch = await bcrypt.compare(password, user.password);

            if (!passwordMatch) {
                return { success: false, error: 'Неверный пароль' };
            }

            return { 
                success: true, 
                user: { 
                    id: user.id, 
                    email: user.email, 
                    name: user.name,
                    plan: user.plan 
                } 
            };
        } catch (error) {
            console.error('Ошибка входа:', error);
            return { success: false, error: 'Ошибка входа' };
        }
    }

    async getUserById(userId) {
        try {
            const result = await shared.db.query(
                'SELECT id, email, name, plan, created_at FROM users WHERE id = $1',
                [userId]
            );
            return result.rows[0] || null;
        } catch (error) {
            console.error('Ошибка получения пользователя:', error);
            return null;
        }
    }
}

module.exports = new AuthModule();