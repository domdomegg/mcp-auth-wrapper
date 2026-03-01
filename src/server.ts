/* eslint-disable @typescript-eslint/no-deprecated -- Using low-level Server to proxy JSON Schema without Zod conversion */
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	ListResourcesRequestSchema,
	ListPromptsRequestSchema,
	GetPromptRequestSchema,
	ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {OAuthClientInformationFull} from '@modelcontextprotocol/sdk/shared/auth.js';
import type {AuthorizationParams} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {mcpAuthRouter, getOAuthProtectedResourceMetadataUrl} from '@modelcontextprotocol/sdk/server/auth/router.js';
import {requireBearerAuth} from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import express from 'express';
import type {WrapperOAuthProvider} from './oauth-provider.js';
import type {OidcClient} from './auth.js';
import type {Store} from './store.js';
import type {ProcessPool} from './process-pool.js';
import type {WrapperConfig} from './types.js';
import {renderParamsForm, renderReconfigurePage} from './pages.js';
import {RECONFIGURE_TOOL_NAME, getReconfigureTool, handleReconfigureCall} from './reconfigure-tool.js';

/** Safely extract a string from a parsed form body (may be string, array, or undefined) */
const getString = (value: unknown): string | undefined =>
	typeof value === 'string' ? value : undefined;

const createProxyServer = (
	pool: ProcessPool,
	store: Store,
	userId: string,
	config: WrapperConfig,
	baseUrl: string,
	accessToken: string,
): Server => {
	const server = new Server(
		{name: 'mcp-auth-wrapper', version: '1.0.0'},
		{capabilities: {tools: {}, resources: {}, prompts: {}}},
	);

	const envPerUser = config.envPerUser ?? [];
	const hasParams = envPerUser.length > 0;
	const reconfigureUrl = `${baseUrl}/reconfigure?token=${accessToken}`;

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		const client = await pool.getClient(userId);
		const result = await client.listTools();

		if (hasParams) {
			result.tools.push(getReconfigureTool(reconfigureUrl, envPerUser));
		}

		return result;
	});

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		if (hasParams && request.params.name === RECONFIGURE_TOOL_NAME) {
			return handleReconfigureCall(
				request.params.arguments ?? {},
				{
					store, pool, userId, envPerUser, reconfigureUrl,
				},
			);
		}

		const client = await pool.getClient(userId);
		return client.callTool({
			name: request.params.name,
			arguments: request.params.arguments,
		});
	});

	server.setRequestHandler(ListResourcesRequestSchema, async () => {
		const client = await pool.getClient(userId);
		return client.listResources();
	});

	server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
		const client = await pool.getClient(userId);
		return client.readResource({
			uri: request.params.uri,
		});
	});

	server.setRequestHandler(ListPromptsRequestSchema, async () => {
		const client = await pool.getClient(userId);
		return client.listPrompts();
	});

	server.setRequestHandler(GetPromptRequestSchema, async (request) => {
		const client = await pool.getClient(userId);
		return client.getPrompt({
			name: request.params.name,
			arguments: request.params.arguments,
		});
	});

	return server;
};

export const createApp = (
	config: WrapperConfig,
	pool: ProcessPool,
	provider: WrapperOAuthProvider,
	oidcClient: OidcClient,
	store: Store,
): express.Express => {
	const app = express();
	const baseUrl = config.issuerUrl ?? `http://localhost:${config.port ?? 3000}`;
	const issuerUrl = new URL(baseUrl);
	const mcpUrl = new URL('/mcp', issuerUrl);

	// Custom /authorize handler — accepts any client_id and redirect_uri without
	// requiring prior registration. The SDK's built-in handler validates these against
	// a client registry, which we don't need. PKCE is still enforced.
	app.all('/authorize', (req, res) => {
		const params = req.method === 'POST' ? req.body as Record<string, unknown> : req.query;

		const clientId = getString(params.client_id);
		const redirectUri = getString(params.redirect_uri);
		const codeChallenge = getString(params.code_challenge);
		const codeChallengeMethod = getString(params.code_challenge_method);
		const scope = getString(params.scope);
		const state = getString(params.state);

		if (!clientId || !redirectUri || !codeChallenge) {
			res.status(400).json({error: 'invalid_request', error_description: 'Missing client_id, redirect_uri, or code_challenge'});
			return;
		}

		if (codeChallengeMethod && codeChallengeMethod !== 'S256') {
			res.status(400).json({error: 'invalid_request', error_description: 'code_challenge_method must be S256'});
			return;
		}

		const client = {client_id: clientId, redirect_uris: [redirectUri]} as OAuthClientInformationFull;
		const authParams: AuthorizationParams = {
			scopes: scope ? scope.split(' ') : [],
			redirectUri,
			codeChallenge,
		};
		if (state) {
			authParams.state = state;
		}

		void provider.authorize(client, authParams, res).catch((err: unknown) => {
			console.error('Authorize error:', err);
			if (!res.headersSent) {
				res.status(500).json({error: 'server_error', error_description: 'Failed to initiate authorization. See server logs for more details.'});
			}
		});
	});

	// Compatibility: many clients probe /.well-known/oauth-protected-resource at the root,
	// but RFC 9728 says the path should be /.well-known/oauth-protected-resource/mcp when
	// the resource URL is /mcp. Serve the metadata at the root path too for broad compat.
	app.get('/.well-known/oauth-protected-resource', (_req, res) => {
		res.json({
			resource: mcpUrl.href,
			authorization_servers: [issuerUrl.href],
		});
	});

	// OAuth routes (discovery, token, register, revoke — /authorize is handled above).
	// Rate limiting is disabled: the MCP SDK defaults conflict with reverse proxies
	// (X-Forwarded-For / trust proxy issues), and it's unnecessary here because all
	// auth codes and tokens are AES-256-GCM sealed blobs with fresh random IVs and
	// mandatory PKCE — brute forcing is cryptographically infeasible.
	const noRateLimit = {rateLimit: false as const};
	app.use(mcpAuthRouter({
		provider,
		issuerUrl,
		baseUrl: issuerUrl,
		resourceServerUrl: mcpUrl,
		tokenOptions: noRateLimit,
		authorizationOptions: noRateLimit,
		clientRegistrationOptions: noRateLimit,
		revocationOptions: noRateLimit,
	}));

	// Upstream OIDC callback
	app.get('/callback', async (req, res) => {
		try {
			const code = getString(req.query.code);
			const sealedState = getString(req.query.state);

			if (!code || !sealedState) {
				res.status(400).send('Missing code or state parameter');
				return;
			}

			const pending = provider.unsealState(sealedState);
			if (!pending) {
				res.status(400).send('Invalid or expired authorization session');
				return;
			}

			const callbackUrl = `${baseUrl}/callback`;
			const {userId} = await oidcClient.exchangeCode(code, callbackUrl, pending.upstreamCodeVerifier);

			// Show the params form if envPerUser is configured and storage is writable,
			// so users can review/update their configuration on re-auth (e.g. via a Reconfigure flow).
			// Skip if storage is inline (read-only) and user already has all params.
			const existingParams = store.getUser(userId);
			const isInlineStorage = typeof config.storage === 'object';
			const needsParams = config.envPerUser
				&& config.envPerUser.length > 0
				&& !(isInlineStorage && existingParams && config.envPerUser.every((p) => existingParams[p.name]));

			if (needsParams) {
				// Re-seal with userId attached so /params can use it
				pending.userId = userId;
				const newSealedState = provider.sealState(pending);
				res.redirect(`${baseUrl}/params?session=${newSealedState}`);
				return;
			}

			// User is fully configured — if not in store yet, create empty entry
			if (!existingParams) {
				store.upsertUser(userId, {});
			}

			const {redirectUrl} = provider.completeAuthorization(pending, userId);
			res.redirect(redirectUrl);
		} catch (err) {
			console.error('Callback error:', err);
			res.status(500).send('Authentication failed');
		}
	});

	// Params form
	app.get('/params', (req, res) => {
		const sealedSession = getString(req.query.session);
		if (!sealedSession) {
			res.status(400).send('Missing session parameter');
			return;
		}

		const pending = provider.unsealState(sealedSession);
		if (!pending?.userId) {
			res.status(400).send('Invalid or expired session');
			return;
		}

		const existingValues = store.getUser(pending.userId);
		res.send(renderParamsForm(config.envPerUser ?? [], sealedSession, existingValues));
	});

	app.post('/params', express.urlencoded({extended: false}), (req, res) => {
		const sealedSession = getString(req.body.session);
		if (!sealedSession) {
			res.status(400).send('Missing session parameter');
			return;
		}

		const pending = provider.unsealState(sealedSession);
		if (!pending?.userId) {
			res.status(400).send('Invalid or expired session');
			return;
		}

		const params: Record<string, string> = {};
		for (const p of config.envPerUser ?? []) {
			const value = getString(req.body[p.name]);
			if (value) {
				params[p.name] = value;
			}
		}

		store.upsertUser(pending.userId, params);
		pool.invalidateUser(pending.userId);

		const {redirectUrl} = provider.completeAuthorization(pending, pending.userId);
		res.redirect(redirectUrl);
	});

	// Reconfigure page (auth via access token in URL)
	app.get('/reconfigure', async (req, res) => {
		const token = getString(req.query.token);
		if (!token) {
			res.status(401).send('Missing token');
			return;
		}

		try {
			const authInfo = await provider.verifyAccessToken(token);
			const userId = getString(authInfo.extra?.userId);
			if (!userId) {
				res.status(401).send('Missing user identity');
				return;
			}

			const existingValues = store.getUser(userId) ?? {};
			res.send(renderReconfigurePage(config.envPerUser ?? [], token, existingValues));
		} catch {
			res.status(401).send('Invalid or expired token');
		}
	});

	app.post('/reconfigure', express.urlencoded({extended: false}), async (req, res) => {
		const token = getString(req.body.token);
		if (!token) {
			res.status(401).send('Missing token');
			return;
		}

		try {
			const authInfo = await provider.verifyAccessToken(token);
			const userId = getString(authInfo.extra?.userId);
			if (!userId) {
				res.status(401).send('Missing user identity');
				return;
			}

			const params: Record<string, string> = {};
			for (const p of config.envPerUser ?? []) {
				const value = getString(req.body[p.name]);
				if (value) {
					params[p.name] = value;
				}
			}

			store.upsertUser(userId, params);
			pool.invalidateUser(userId);

			res.send(renderReconfigurePage(config.envPerUser ?? [], token, params, true));
		} catch {
			res.status(401).send('Invalid or expired token');
		}
	});

	// Protected MCP endpoint
	const bearerAuth = requireBearerAuth({
		verifier: provider,
		resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
	});

	app.all('/mcp', bearerAuth, async (req, res) => {
		const userId = getString(req.auth?.extra?.userId);
		if (!userId) {
			res.status(401).json({error: 'Missing user identity'});
			return;
		}

		const accessToken = req.auth!.token;

		// Check if user has params configured
		const userParams = store.getUser(userId);
		if (!userParams) {
			res.status(403).json({error: 'User not configured. Please reconfigure via the reconfigure tool.'});
			return;
		}

		// Stateless: fresh transport and proxy server per request (no session tracking)
		const transport = new StreamableHTTPServerTransport({
			enableJsonResponse: true,
		});

		const server = createProxyServer(pool, store, userId, config, baseUrl, accessToken);
		await server.connect(transport as unknown as Transport);

		await transport.handleRequest(req, res);
	});

	return app;
};
