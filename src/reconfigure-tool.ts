import type {EnvParam} from './types.js';
import type {Store} from './store.js';
import type {ProcessPool} from './process-pool.js';

export const RECONFIGURE_TOOL_NAME = 'mcp_auth_wrapper__reconfigure';

export const getReconfigureTool = (reconfigureUrl: string, envParams: EnvParam[]) => ({
	name: RECONFIGURE_TOOL_NAME,
	title: 'Reconfigure server',
	description: 'Update your configuration for this MCP server. Call with parameter values to update directly, or call with no arguments to get a browser URL for configuration.',
	inputSchema: {
		type: 'object' as const,
		properties: Object.fromEntries(envParams.map((p) => [
			p.name,
			{type: 'string' as const, description: p.description ?? p.label},
		])),
	},
	annotations: {
		title: 'Reconfigure server',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
});

export const handleReconfigureCall = (
	args: Record<string, unknown>,
	{store, pool, userId, profileId, envPerUser, reconfigureUrl}: {
		store: Store;
		pool: ProcessPool;
		userId: string;
		/** The profile this connection is bound to; params live on it, not on the user. */
		profileId: string;
		envPerUser: EnvParam[];
		reconfigureUrl: string;
	},
) => {
	const knownNames = new Set(envPerUser.map((p) => p.name));
	const unknownKeys = Object.keys(args).filter((k) => !knownNames.has(k));
	if (unknownKeys.length > 0) {
		const result = {
			error: `Unknown parameter(s): ${unknownKeys.join(', ')}`,
			validParameters: envPerUser.map((p) => p.name),
		};
		return {
			isError: true,
			content: [{type: 'text' as const, text: JSON.stringify(result, null, 2)}],
			structuredContent: result,
		};
	}

	const hasValues = envPerUser.some((p) => typeof args[p.name] === 'string' && args[p.name] !== '');

	if (hasValues) {
		const params: Record<string, string> = {};
		for (const p of envPerUser) {
			const val = args[p.name];
			if (typeof val === 'string' && val !== '') {
				params[p.name] = val;
			}
		}

		try {
			// Writes the bound profile, not the legacy user row — that row is no
			// longer read when spawning, so writing it silently changed nothing.
			const existing = store.getProfile(userId, profileId);
			store.upsertProfile(userId, profileId, existing?.label || 'Default', params);
			pool.invalidateUser(userId, profileId);
			const result = {
				status: 'updated',
				message: 'Configuration updated. Your MCP server will use the new settings on the next request.',
			};
			return {
				content: [{type: 'text' as const, text: JSON.stringify(result, null, 2)}],
				structuredContent: result,
			};
		} catch {
			// Storage is read-only (inline config) — fall through to URL mode
		}
	}

	const result = {
		status: 'reconfigure',
		url: reconfigureUrl,
		message: 'To update your configuration, open this URL in your browser. After saving changes, your MCP server process will restart with the new settings.',
	};
	return {
		content: [{type: 'text' as const, text: JSON.stringify(result, null, 2)}],
		structuredContent: result,
	};
};
