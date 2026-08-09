import {DatabaseSync} from 'node:sqlite';
import type {WrapperConfig} from './types.js';

/**
 * A user's params live on a *profile*, not directly on the user, so one
 * identity can hold several accounts on the same upstream — a personal and a
 * work Google account, or a second WhatsApp. Each connecting OAuth client is
 * bound to one profile, and the process pool keys on the resolved profile.
 *
 * Everyone has at least a profile named `default`; a user who never creates
 * another sees exactly the old single-account behaviour.
 */
export const DEFAULT_PROFILE_ID = 'default';

export type Profile = {
	id: string;
	label: string;
	params: Record<string, string>;
};

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

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS profiles (
				user_id TEXT NOT NULL,
				profile_id TEXT NOT NULL,
				label TEXT NOT NULL,
				params TEXT NOT NULL DEFAULT '{}',
				PRIMARY KEY (user_id, profile_id)
			)
		`);

		// Which profile a given OAuth client talks to.
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS bindings (
				user_id TEXT NOT NULL,
				client_id TEXT NOT NULL,
				profile_id TEXT NOT NULL,
				PRIMARY KEY (user_id, client_id)
			)
		`);

		if (inlineUsers) {
			const insert = this.db.prepare('INSERT OR REPLACE INTO users (user_id, params) VALUES (?, ?)');
			for (const [userId, params] of Object.entries(inlineUsers)) {
				insert.run(userId, JSON.stringify(params));
			}
		}

		this.migrateUsersToProfiles();
	}

	listProfiles(userId: string): Profile[] {
		const rows = this.db.prepare('SELECT profile_id, label, params FROM profiles WHERE user_id = ? ORDER BY profile_id = ? DESC, label').all(userId, DEFAULT_PROFILE_ID) as {profile_id: string; label: string; params: string}[];

		return rows.map((row) => ({
			id: row.profile_id,
			label: row.label,
			params: JSON.parse(row.params) as Record<string, string>,
		}));
	}

	getProfile(userId: string, profileId: string): Profile | undefined {
		const row = this.db.prepare('SELECT profile_id, label, params FROM profiles WHERE user_id = ? AND profile_id = ?').get(userId, profileId) as {profile_id: string; label: string; params: string} | undefined;

		if (!row) {
			return undefined;
		}

		return {id: row.profile_id, label: row.label, params: JSON.parse(row.params) as Record<string, string>};
	}

	upsertProfile(userId: string, profileId: string, label: string, params: Record<string, string>): void {
		this.assertWritable();
		// A profile with no name renders as a blank row, so never store one.
		label = label.trim() || (profileId === DEFAULT_PROFILE_ID ? 'Default' : profileId);
		this.db.prepare(`
			INSERT INTO profiles (user_id, profile_id, label, params) VALUES (?, ?, ?, ?)
			ON CONFLICT(user_id, profile_id) DO UPDATE SET label = excluded.label, params = excluded.params
		`).run(userId, profileId, label, JSON.stringify(params));

		// Keep the legacy row in step, so a rollback to a build without profiles
		// still finds the default profile's params where it expects them.
		if (profileId === DEFAULT_PROFILE_ID) {
			this.upsertUser(userId, params);
		}
	}

	/**
	 * Removes a profile, moving anything bound to it back to the default rather
	 * than leaving bindings pointing at something that no longer exists. The
	 * default cannot be removed: it is the fallback every unbound client uses.
	 */
	deleteProfile(userId: string, profileId: string): void {
		this.assertWritable();

		if (profileId === DEFAULT_PROFILE_ID) {
			throw new Error('Cannot delete the default profile');
		}

		this.db.prepare('UPDATE bindings SET profile_id = ? WHERE user_id = ? AND profile_id = ?')
			.run(DEFAULT_PROFILE_ID, userId, profileId);
		this.db.prepare('DELETE FROM profiles WHERE user_id = ? AND profile_id = ?').run(userId, profileId);
	}

	getBinding(userId: string, clientId: string): string | undefined {
		const row = this.db.prepare('SELECT profile_id FROM bindings WHERE user_id = ? AND client_id = ?').get(userId, clientId) as {profile_id: string} | undefined;

		return row?.profile_id;
	}

	/** Profiles already bound to some other client of this user. */
	listBoundProfileIds(userId: string, exceptClientId?: string): string[] {
		const rows = this.db.prepare('SELECT DISTINCT profile_id FROM bindings WHERE user_id = ? AND client_id IS NOT ?').all(userId, exceptClientId ?? null) as {profile_id: string}[];

		return rows.map((row) => row.profile_id);
	}

	setBinding(userId: string, clientId: string, profileId: string): void {
		this.assertWritable();
		this.db.prepare(`
			INSERT INTO bindings (user_id, client_id, profile_id) VALUES (?, ?, ?)
			ON CONFLICT(user_id, client_id) DO UPDATE SET profile_id = excluded.profile_id
		`).run(userId, clientId, profileId);
	}

	/**
	 * The profile a client talks to. Falls back to the default so a client that
	 * connected before profiles existed — or one that skipped the picker — keeps
	 * working.
	 */
	resolveProfileId(userId: string, clientId: string | undefined): string {
		if (!clientId) {
			return DEFAULT_PROFILE_ID;
		}

		return this.getBinding(userId, clientId) ?? DEFAULT_PROFILE_ID;
	}

	getUser(userId: string): Record<string, string> | undefined {
		const row = this.db.prepare('SELECT params FROM users WHERE user_id = ?').get(userId) as {params: string} | undefined;
		if (!row) {
			return undefined;
		}

		return JSON.parse(row.params) as Record<string, string>;
	}

	upsertUser(userId: string, params: Record<string, string>): void {
		this.assertWritable();
		this.db.prepare('INSERT INTO users (user_id, params) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET params = excluded.params').run(userId, JSON.stringify(params));
	}

	close(): void {
		this.db.close();
	}

	private assertWritable(): void {
		if (this.readOnly) {
			throw new Error('Cannot modify users in inline storage mode');
		}
	}

	/**
	 * Params that predate profiles are stored against the user. Move them onto
	 * a `default` profile so existing installs keep working untouched.
	 */
	private migrateUsersToProfiles(): void {
		const rows = this.db.prepare(`
			SELECT user_id, params FROM users
			WHERE user_id NOT IN (SELECT user_id FROM profiles WHERE profile_id = ?)
		`).all(DEFAULT_PROFILE_ID) as {user_id: string; params: string}[];

		const insert = this.db.prepare(`
			INSERT OR IGNORE INTO profiles (user_id, profile_id, label, params) VALUES (?, ?, ?, ?)
		`);
		for (const row of rows) {
			insert.run(row.user_id, DEFAULT_PROFILE_ID, 'Default', row.params);
		}
	}
}
