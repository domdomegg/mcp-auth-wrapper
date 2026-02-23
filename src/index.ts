#!/usr/bin/env node
import fs from 'node:fs';
import {loadConfig} from './config.js';
import {Store} from './store.js';
import {OidcClient} from './auth.js';
import {WrapperOAuthProvider} from './oauth-provider.js';
import {ProcessPool} from './process-pool.js';
import {createApp} from './server.js';

const DEFAULT_CONFIG_PATH = 'mcp-auth-wrapper.config.json';

const main = async () => {
	let configStr = process.env.MCP_AUTH_WRAPPER_CONFIG;

	if (!configStr && fs.existsSync(DEFAULT_CONFIG_PATH)) {
		configStr = DEFAULT_CONFIG_PATH;
	}

	if (!configStr) {
		console.error('No config found. Set MCP_AUTH_WRAPPER_CONFIG or create mcp-auth-wrapper.config.json');
		process.exit(1);
	}

	const config = loadConfig(configStr);
	const store = new Store(config);
	const oidcClient = new OidcClient(config.auth);
	const pool = new ProcessPool(
		config.command[0]!,
		config.command.slice(1),
		config.envBase ?? {},
		store,
	);
	const provider = new WrapperOAuthProvider(oidcClient, config);
	const app = createApp(config, pool, provider, oidcClient, store);

	const port = config.port ?? 3000;
	const host = config.host ?? '0.0.0.0';
	const server = app.listen(port, host, () => {
		console.log(`mcp-auth-wrapper listening on ${host}:${port}`);
		console.log(`Wrapping: ${config.command.join(' ')}`);
		console.log(`Auth: ${config.auth.issuer}`);
		console.log(`Storage: ${typeof config.storage === 'string' ? config.storage : 'inline'}`);
	});

	const shutdown = async () => {
		console.log('\nShutting down...');
		server.close();
		await pool.shutdown();
		store.close();
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
};

main().catch((err: unknown) => {
	console.error(err);
	process.exit(1);
});
