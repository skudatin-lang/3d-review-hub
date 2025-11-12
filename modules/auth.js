// modules/auth.js
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const shared = require('./shared');

class AuthModule {
    async register(userData) {
        try {
            const { email, password, name } = userData;
            
            console.log('🔐 Регистрация пользователя:', { email, name });
            
            if (!email || !password || !name) {
                return { success: false, error: 'Все поля обязательны' };
            }

            if (password.length < 6) {
                return { success: false, error: 'Пароль должен быть не менее 6 символов' };
            }

            const userCheck = await shared.db.query(
                'SELECT id FROM users WHERE email = $1', 
                [email]
            );
            
            if (userCheck.rows.length > 0) {
                return { success: false, error: 'Email уже занят' };
            }

            const hashedPassword = await bcrypt.hash(password, 10);
            const userId = uuidv4();

            await shared.db.query(
                'INSERT INTO users (id, email, password, name, plan, created_at) VALUES ($1, $2, $3, $4, $5, NOW())',
                [userId, email, hashedPassword, name, 'free']
            );

            console.log('✅ Пользователь зарегистрирован:', userId);
            
            return { 
                success: true, 
                userId: userId,
                user: {
                    id: userId,
                    email: email,
                    name: name,
                    plan: 'free'
                }
            };

        } catch (error) {
            console.error('❌ Ошибка регистрации:', error);
            
            if (error.code === '23505') {
                return { success: false, error: 'Email уже занят' };
            }
            
            return { 
                success: false, 
                error: 'Ошибка при регистрации: ' + error.message 
            };
        }
    }

    async login(credentials) {
        try {
            const { email, password } = credentials;
            
            console.log('🔐 Попытка входа:', email);
            
            if (!email || !password) {
                return { success: false, error: 'Email и пароль обязательны' };
            }

            const result = await shared.db.query(
                'SELECT * FROM users WHERE email = $1', 
                [email]
            );

            if (result.rows.length === 0) {
                return { success: false, error: 'Пользователь не найден' };
            }

            const user = result.rows[0];
            
            const validPassword = await bcrypt.compare(password, user.password);
            
            if (!validPassword) {
                return { success: false, error: 'Неверный пароль' };
            }

            console.log('✅ Успешный вход:', user.id);
            
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
            console.error('❌ Ошибка входа:', error);
            return { 
                success: false, 
                error: 'Ошибка при входе: ' + error.message 
            };
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
            console.error('❌ Ошибка получения пользователя:', error);
            return null;
        }
    }
}

module.exports = new AuthModule();