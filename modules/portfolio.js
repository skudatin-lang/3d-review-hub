// modules/portfolio.js
const { v4: uuidv4 } = require('uuid');
const shared = require('./shared');

class PortfolioModule {
    async getPortfolioItems(userId) {
        try {
            const result = await shared.db.query(
                'SELECT * FROM portfolio_items WHERE user_id = $1 ORDER BY created_at DESC',
                [userId]
            );
            return result.rows;
        } catch (error) {
            console.error('Ошибка загрузки портфолио:', error);
            throw error;
        }
    }

    async addPortfolioItem(userId, itemData) {
        try {
            const { title, description, category, is_public } = itemData;
            const itemId = uuidv4();

            await shared.db.query(`
                INSERT INTO portfolio_items (id, user_id, title, description, category, is_public)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [itemId, userId, title, description || '', category || '', is_public || false]);

            return { success: true, itemId };
        } catch (error) {
            console.error('Ошибка добавления в портфолио:', error);
            return { success: false, error: error.message };
        }
    }

    async deletePortfolioItem(userId, itemId) {
        try {
            await shared.db.query(
                'DELETE FROM portfolio_items WHERE id = $1 AND user_id = $2',
                [itemId, userId]
            );
            return { success: true };
        } catch (error) {
            console.error('Ошибка удаления из портфолио:', error);
            return { success: false, error: 'Ошибка удаления' };
        }
    }
}

module.exports = new PortfolioModule();