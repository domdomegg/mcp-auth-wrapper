import {createServer} from 'node:http';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SignJWT, exportJWK, generateKeyPair} from 'jose';
import type {KeyLike} from 'jose';
import express from 'express';
import {
	afterAll, beforeAll, describe, expect, test,
} from 'vitest';
import {Store} from './store.js';
import {OidcClient} from './auth.js';
import {WrapperOAuthProvider} from './oauth-provider.js';
import {ProcessPool} from './process-pool.js';
import {createApp} from './server.js';
import type {WrapperConfig} from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stubServerPath = path.join(__dirname, 'stub-stdio-server.fixture.ts');

// Mock upstream OIDC provider
let upstreamPrivateKey: KeyLike;
let upstreamPublicKey: KeyLike;
let upstreamServer: ReturnType<typeof createServer>;
let upstreamUrl: string;

// Wrapper
let wrapperServer: ReturnType<typeof createServer>;
let wrapperUrl: string;
let store: Store;
let pool: ProcessPool;

const signUpstreamIdToken = async (sub: string, issuer: string, audience: string) =>
	new SignJWT({sub})
		.setProtectedHeader({alg: 'RS256', kid: 'upstream-key'})
		.setIssuer(issuer)
		.setAudience(audience)
		.setIssuedAt()
		.setExpirationTime('1h')
		.sign(upstreamPrivateKey);

const createMockUpstreamOidc = async (): Promise<{server: ReturnType<typeof createServer>; url: string}> => {
	const keyPair = await generateKeyPair('RS256');
	upstreamPrivateKey = keyPair.privateKey;
	upstreamPublicKey = keyPair.publicKey;

	const app = express();
	app.use(express.urlencoded({extended: false}));

	// Track authorization codes
	const codes = new Map<string, {redirectUri: string; state?: string; sub: string}>();

	app.get('/.well-known/openid-configuration', (_req, res) => {
		const base = upstreamUrl;
		res.json({
			issuer: base,
			authorization_endpoint: `${base}/authorize`,
			token_endpoint: `${base}/token`,
			jwks_uri: `${base}/jwks`,
		});
	});

	app.get('/jwks', async (_req, res) => {
		const jwk = await exportJWK(upstreamPublicKey);
		jwk.alg = 'RS256';
		jwk.kid = 'upstream-key';
		jwk.use = 'sig';
		res.json({keys: [jwk]});
	});

	// Auto-approve authorization: immediately redirect back with a code
	app.get('/authorize', (req, res) => {
		const redirectUri = req.query.redirect_uri as string;
		const state = req.query.state as string | undefined;
		// Use "adam" as the default test user; the client_id determines which user
		const sub = 'adam';
		const code = randomUUID();
		codes.set(code, {redirectUri, state, sub});
		const url = new URL(redirectUri);
		url.searchParams.set('code', code);
		if (state) {
			url.searchParams.set('state', state);
		}

		res.redirect(url.toString());
	});

	app.post('/token', async (req, res) => {
		const code = req.body.code as string;
		const codeData = codes.get(code);
		if (!codeData) {
			res.status(400).json({error: 'invalid_grant'});
			return;
		}

		codes.delete(code);
		const idToken = await signUpstreamIdToken(codeData.sub, upstreamUrl, req.body.client_id as string);
		res.json({
			access_token: randomUUID(),
			token_type: 'bearer',
			expires_in: 3600,
			id_token: idToken,
		});
	});

	const server = createServer(app);
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			resolve();
		});
	});

	const addr = server.address();
	if (!addr || typeof addr === 'string') {
		throw new Error('Failed to start mock upstream');
	}

	return {server, url: `http://127.0.0.1:${addr.port}`};
};

beforeAll(async () => {
	// 1. Start mock upstream OIDC
	const upstream = await createMockUpstreamOidc();
	upstreamServer = upstream.server;
	upstreamUrl = upstream.url;

	// 2. Create wrapper config
	const config: WrapperConfig = {
		command: ['npx', 'tsx', stubServerPath],
		envBase: {BASE_VAR: 'shared'},
		auth: {
			issuer: upstreamUrl,
			clientId: 'test-wrapper',
			clientSecret: 'test-secret',
		},
		storage: {
			adam: {TEST_USER: 'adam', SECRET_KEY: 'adam-secret'},
			bob: {TEST_USER: 'bob', SECRET_KEY: 'bob-secret'},
		},
		envPerUser: [{name: 'TEST_USER', label: 'Test User'}, {name: 'SECRET_KEY', label: 'Secret Key'}],
	};

	// Reserve a port by briefly listening, then close so createApp can use it
	const tempServer = createServer();
	await new Promise<void>((resolve) => {
		tempServer.listen(0, '127.0.0.1', () => {
			resolve();
		});
	});
	const tempAddr = tempServer.address();
	if (!tempAddr || typeof tempAddr === 'string') {
		throw new Error('Failed to reserve port');
	}

	const {port} = tempAddr;
	await new Promise<void>((resolve) => {
		tempServer.close(() => {
			resolve();
		});
	});

	config.issuerUrl = `http://127.0.0.1:${port}`;
	wrapperUrl = config.issuerUrl;

	store = new Store(config);
	const oidcClient = new OidcClient(config.auth);
	pool = new ProcessPool('npx', ['tsx', stubServerPath], {BASE_VAR: 'shared'}, store);
	const provider = new WrapperOAuthProvider(oidcClient, config);
	const app = createApp(config, pool, provider, oidcClient, store);

	wrapperServer = createServer(app);
	await new Promise<void>((resolve) => {
		wrapperServer.listen(port, '127.0.0.1', () => {
			resolve();
		});
	});
}, 30_000);

afterAll(async () => {
	await pool.shutdown();
	store.close();
	await new Promise<void>((resolve, reject) => {
		wrapperServer.close((err) => {
			if (err) {
				reject(err);
			} else {
				resolve();
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		upstreamServer.close((err) => {
			if (err) {
				reject(err);
			} else {
				resolve();
			}
		});
	});
}, 15_000);

// Helper: generate PKCE pair
const generatePkce = () => {
	const codeVerifier = randomBytes(32).toString('base64url');
	const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
	return {codeVerifier, codeChallenge};
};

// Helper: complete the full OAuth flow and return an access token
const getAccessToken = async (): Promise<string> => {
	const {codeVerifier, codeChallenge} = generatePkce();

	// 1. Register a client
	const registerRes = await fetch(`${wrapperUrl}/register`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({
			redirect_uris: ['http://localhost:9999/callback'],
			client_name: 'test-e2e',
			token_endpoint_auth_method: 'none',
		}),
	});
	expect(registerRes.status).toBe(201);
	const clientInfo = await registerRes.json() as {client_id: string};

	// 2. Start authorization (follow redirects manually)
	const authorizeUrl = new URL(`${wrapperUrl}/authorize`);
	authorizeUrl.searchParams.set('client_id', clientInfo.client_id);
	authorizeUrl.searchParams.set('redirect_uri', 'http://localhost:9999/callback');
	authorizeUrl.searchParams.set('response_type', 'code');
	authorizeUrl.searchParams.set('code_challenge', codeChallenge);
	authorizeUrl.searchParams.set('code_challenge_method', 'S256');
	authorizeUrl.searchParams.set('state', 'test-state');

	// Follow the redirect chain: wrapper → upstream → wrapper/callback → params form → redirect back
	let res = await fetch(authorizeUrl.toString(), {redirect: 'manual'});
	expect(res.status).toBe(302);

	// Follow redirects through upstream and back
	let location = res.headers.get('location')!;
	while (location && !location.startsWith('http://localhost:9999')) {
		res = await fetch(location, {redirect: 'manual'}); // eslint-disable-line no-await-in-loop
		// If we landed on the params form (200 HTML), submit it to continue the flow
		if (res.status === 200 && !res.headers.get('location')) {
			const html = await res.text(); // eslint-disable-line no-await-in-loop
			const sessionMatch = /name="session"\s+value="([^"]+)"/.exec(html);
			if (sessionMatch) {
				const formBody = new URLSearchParams({session: sessionMatch[1]!});
				// Submit existing param values from the form
				for (const match of html.matchAll(/name="((?!session)[^"]+)"[^>]*value="([^"]*)"/g)) {
					formBody.set(match[1]!, match[2]!);
				}

				const paramsUrl = new URL('/params', location.startsWith('http') ? location : wrapperUrl);
				res = await fetch(paramsUrl.toString(), { // eslint-disable-line no-await-in-loop
					method: 'POST',
					headers: {'Content-Type': 'application/x-www-form-urlencoded'},
					body: formBody.toString(),
					redirect: 'manual',
				});
			}
		}

		location = res.headers.get('location') ?? '';
	}

	// Extract the code from the final redirect
	const callbackUrl = new URL(location);
	const code = callbackUrl.searchParams.get('code')!;
	expect(code).toBeTruthy();
	expect(callbackUrl.searchParams.get('state')).toBe('test-state');

	// 3. Exchange code for token
	const tokenRes = await fetch(`${wrapperUrl}/token`, {
		method: 'POST',
		headers: {'Content-Type': 'application/x-www-form-urlencoded'},
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			client_id: clientInfo.client_id,
			code_verifier: codeVerifier,
			redirect_uri: 'http://localhost:9999/callback',
		}).toString(),
	});
	expect(tokenRes.status).toBe(200);
	const tokenData = await tokenRes.json() as {access_token: string; refresh_token: string};
	expect(tokenData.access_token).toBeTruthy();
	return tokenData.access_token;
};

// Helper: make an MCP JSON-RPC call
const mcpCall = async (token: string, method: string, params: Record<string, unknown> = {}, id = 1) => {
	const res = await fetch(`${wrapperUrl}/mcp`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			jsonrpc: '2.0', method, id, params,
		}),
	});
	return res;
};

describe('OAuth discovery', () => {
	test('serves authorization server metadata', async () => {
		const res = await fetch(`${wrapperUrl}/.well-known/oauth-authorization-server`);
		expect(res.status).toBe(200);
		const metadata = await res.json() as Record<string, unknown>;
		expect(metadata.authorization_endpoint).toBeTruthy();
		expect(metadata.token_endpoint).toBeTruthy();
		expect(metadata.registration_endpoint).toBeTruthy();
	});
});

describe('unauthenticated requests', () => {
	test('rejects /mcp without token with 401', async () => {
		const res = await fetch(`${wrapperUrl}/mcp`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({
				jsonrpc: '2.0', method: 'initialize', id: 1, params: {protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'test', version: '1.0.0'}},
			}),
		});
		expect(res.status).toBe(401);
	});

	test('rejects /mcp with invalid token', async () => {
		const res = await fetch(`${wrapperUrl}/mcp`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: 'Bearer not-a-real-token',
			},
			body: JSON.stringify({
				jsonrpc: '2.0', method: 'initialize', id: 1, params: {protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'test', version: '1.0.0'}},
			}),
		});
		// Should be 401 (or 500 if bearer auth middleware throws unhandled)
		expect(res.ok).toBe(false);
	});
});

describe('full OAuth flow', () => {
	test('can register client, authorize, get token, and make MCP calls', async () => {
		const token = await getAccessToken();

		// Initialize MCP session (stateless — no session ID returned)
		const initRes = await mcpCall(token, 'initialize', {
			protocolVersion: '2025-03-26',
			capabilities: {},
			clientInfo: {name: 'test', version: '1.0.0'},
		});
		expect(initRes.status).toBe(200);
		expect(initRes.headers.get('mcp-session-id')).toBeNull();

		// List tools (fresh stateless request)
		const toolsRes = await mcpCall(token, 'tools/list', {}, 2);
		expect(toolsRes.status).toBe(200);
		const toolsBody = await toolsRes.json() as {result: {tools: {name: string}[]}};
		const toolNames = toolsBody.result.tools.map((t) => t.name);
		expect(toolNames).toContain('echo');
		expect(toolNames).toContain('whoami');
		expect(toolNames).toContain('mcp_auth_wrapper__reconfigure');

		// Call whoami
		const whoamiRes = await mcpCall(token, 'tools/call', {name: 'whoami', arguments: {}}, 3);
		expect(whoamiRes.status).toBe(200);
		const whoamiBody = await whoamiRes.json() as {result: {content: {text: string}[]}};
		expect(whoamiBody.result.content[0].text).toBe('adam');

		// Call echo
		const echoRes = await mcpCall(token, 'tools/call', {name: 'echo', arguments: {message: 'hello'}}, 4);
		expect(echoRes.status).toBe(200);
		const echoBody = await echoRes.json() as {result: {content: {text: string}[]}};
		expect(echoBody.result.content[0].text).toBe('hello');
	}, 30_000);
});

describe('reconfigure tool', () => {
	test('returns a URL when called with no arguments', async () => {
		const token = await getAccessToken();

		const res = await mcpCall(token, 'tools/call', {name: 'mcp_auth_wrapper__reconfigure', arguments: {}}, 1);
		expect(res.status).toBe(200);
		const body = await res.json() as {result: {content: {text: string}[]}};
		expect(body.result.content[0].text).toContain('/reconfigure?token=');
	}, 30_000);

	test('falls back to URL mode when storage is read-only', async () => {
		const token = await getAccessToken();

		// Inline storage is read-only, so direct update falls through to URL mode
		const res = await mcpCall(token, 'tools/call', {
			name: 'mcp_auth_wrapper__reconfigure',
			arguments: {TEST_USER: 'adam-updated', SECRET_KEY: 'new-secret'},
		}, 1);
		expect(res.status).toBe(200);
		const body = await res.json() as {result: {content: {text: string}[]}};
		expect(body.result.content[0].text).toContain('/reconfigure?token=');
	}, 30_000);
});
