import {DatabaseSync} from 'node:sqlite';
import type {WrapperConfig} from './types.js';

export class Store {
	private readonly db: DatabaseSync;
	private readonly readOnly: boolean;

	constructor(config: WrapperConfig) {
		const inlineUsers = typeof config.storage === 'object' ? config.storage : undefined;
		const storagePath = typeof config.storage === 'string' ? config.storage : undefined;
		const isFile = storagePath && storagePath !== 'memory';

		this.db = new DatabaseSync(isFile ? storagePath : ':memory:');
		this.readOnly = inlineUsers !== undefined;

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS users (
				user_id TEXT PRIMARY KEY,
				params TEXT NOT NULL DEFAULT '{}'
			)
		`);

		if (inlineUsers) {
			const insert = this.db.prepare('INSERT OR REPLACE INTO users (user_id, params) VALUES (?, ?)');
			for (const [userId, params] of Object.entries(inlineUsers)) {
				insert.run(userId, JSON.stringify(params));
			}
		}
	}

	getUser(userId: string): Record<string, string> | undefined {
		const row = this.db.prepare('SELECT params FROM users WHERE user_id = ?').get(userId) as {params: string} | undefined;
		if (!row) {
			return undefined;
		}

		return JSON.parse(row.params) as Record<string, string>;
	}

	upsertUser(userId: string, params: Record<string, string>): void {
		if (this.readOnly) {
			throw new Error('Cannot modify users in inline storage mode');
		}

		this.db.prepare('INSERT INTO users (user_id, params) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET params = excluded.params').run(userId, JSON.stringify(params));
	}

	close(): void {
		this.db.close();
	}
}
