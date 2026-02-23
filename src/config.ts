import fs from 'node:fs';
import type {WrapperConfig} from './types.js';

export const parseConfig = (json: string): WrapperConfig => {
	const raw = JSON.parse(json);

	if (!Array.isArray(raw.command) || raw.command.length === 0 || !raw.command.every((c: unknown) => typeof c === 'string')) {
		throw new Error('Config must have a "command" array of strings');
	}

	if (!raw.auth || typeof raw.auth !== 'object') {
		throw new Error('Config must have an "auth" object');
	}

	if (!raw.auth.issuer || typeof raw.auth.issuer !== 'string') {
		throw new Error('Config auth must have an "issuer" string');
	}

	// Validate storage: string, object, or omitted (defaults to "memory")
	if (raw.storage !== undefined) {
		if (typeof raw.storage === 'object') {
			if (Array.isArray(raw.storage) || Object.keys(raw.storage).length === 0) {
				throw new Error('Config "storage" object must be a non-empty map of user IDs to env vars');
			}
		} else if (typeof raw.storage !== 'string') {
			throw new Error('Config "storage" must be a string, object, or omitted');
		}
	}

	if (raw.envPerUser !== undefined) {
		if (!Array.isArray(raw.envPerUser)) {
			throw new Error('Config "envPerUser" must be an array');
		}

		for (const p of raw.envPerUser) {
			if (!p.name || typeof p.name !== 'string') {
				throw new Error('Each envPerUser entry must have a "name" string');
			}

			if (!p.label || typeof p.label !== 'string') {
				throw new Error('Each envPerUser entry must have a "label" string');
			}
		}
	}

	return {
		command: raw.command,
		auth: {
			issuer: raw.auth.issuer,
			clientId: raw.auth.clientId ?? 'mcp-auth-wrapper',
			clientSecret: raw.auth.clientSecret,
			scopes: raw.auth.scopes ?? ['openid'],
			userClaim: raw.auth.userClaim ?? 'sub',
		},
		storage: raw.storage ?? 'memory',
		envBase: raw.envBase,
		envPerUser: raw.envPerUser,
		port: raw.port ?? 3000,
		host: raw.host ?? '0.0.0.0',
		issuerUrl: raw.issuerUrl,
		secret: raw.secret,
	};
};

export const loadConfig = (configOrPath: string): WrapperConfig => {
	if (configOrPath.trimStart().startsWith('{')) {
		return parseConfig(configOrPath);
	}

	return parseConfig(fs.readFileSync(configOrPath, 'utf-8'));
};
