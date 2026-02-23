import {createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID} from 'node:crypto';
import type {Response} from 'express';
import type {OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens} from '@modelcontextprotocol/sdk/shared/auth.js';
import type {AuthorizationParams, OAuthServerProvider} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type {OAuthRegisteredClientsStore} from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {AuthInfo} from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {OidcClient} from './auth.js';
import type {WrapperConfig} from './types.js';

const ACCESS_TOKEN_TTL_MS = 3_600_000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3_600_000; // 30 days — must be > ACCESS_TOKEN_TTL_MS, otherwise refresh is useless
const AUTH_CODE_TTL_MS = 300_000; // 5 minutes
const PENDING_AUTH_TTL_MS = 600_000; // 10 minutes — must be >= AUTH_CODE_TTL_MS, as pending auth spans upstream login + param collection

/** Encrypt + authenticate a JSON payload. Returns a URL-safe base64 string. */
const seal = <T>(payload: T, key: Buffer): string => {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const plaintext = Buffer.from(JSON.stringify(payload));
	const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, tag, encrypted]).toString('base64url');
};

/** Decrypt + verify a sealed payload. Returns undefined if tampered or expired. */
const unseal = <T extends {expiresAt: number}>(sealed: string, key: Buffer): T | undefined => {
	try {
		const buf = Buffer.from(sealed, 'base64url');
		const iv = buf.subarray(0, 12);
		const tag = buf.subarray(12, 28);
		const encrypted = buf.subarray(28);
		const decipher = createDecipheriv('aes-256-gcm', key, iv);
		decipher.setAuthTag(tag);
		const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
		const payload = JSON.parse(decrypted.toString()) as T;
		if (payload.expiresAt < Date.now()) {
			return undefined;
		}

		return payload;
	} catch {
		return undefined;
	}
};

/** Data encoded into the upstream state parameter. */
type PendingAuthPayload = {
	upstreamCodeVerifier: string;
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	state?: string;
	scopes: string[];
	expiresAt: number;
	userId?: string;
};

/** Data encoded into the authorization code. */
type AuthCodePayload = {
	clientId: string;
	userId: string;
	codeChallenge: string;
	redirectUri: string;
	scopes: string[];
	expiresAt: number;
};

/** Data encoded into access and refresh tokens. */
type TokenPayload = {
	type: 'access' | 'refresh';
	clientId: string;
	userId: string;
	scopes: string[];
	expiresAt: number;
};

export class WrapperOAuthProvider implements OAuthServerProvider {
	readonly clientsStore: OAuthRegisteredClientsStore;
	private readonly key: Buffer;

	constructor(
		private readonly oidcClient: OidcClient,
		private readonly config: WrapperConfig,
	) {
		this.key = config.secret
			? createHash('sha256').update(config.secret).digest()
			: randomBytes(32);

		this.clientsStore = {
			// Always return a synthetic client — we handle /authorize ourselves
			// and only need this for the SDK's /token client authentication.
			getClient: (clientId: string) => ({
				client_id: clientId,
				redirect_uris: [],
				token_endpoint_auth_method: 'none' as const,
			}) as OAuthClientInformationFull,
			registerClient: (metadata: OAuthClientInformationFull) => ({
				...metadata,
				client_id: metadata.client_id || randomUUID(),
				client_id_issued_at: Math.floor(Date.now() / 1000),
			}),
		};
	}

	async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
		const {codeVerifier, codeChallenge} = this.oidcClient.generateCodeVerifierAndChallenge();

		const payload: PendingAuthPayload = {
			upstreamCodeVerifier: codeVerifier,
			clientId: client.client_id,
			redirectUri: params.redirectUri,
			codeChallenge: params.codeChallenge,
			scopes: params.scopes ?? [],
			expiresAt: Date.now() + PENDING_AUTH_TTL_MS,
		};
		if (params.state) {
			payload.state = params.state;
		}

		const sealedState = seal(payload, this.key);
		const issuerUrl = this.config.issuerUrl ?? `http://localhost:${this.config.port ?? 3000}`;
		const callbackUrl = `${issuerUrl}/callback`;

		const url = await this.oidcClient.buildAuthorizeUrl({
			redirectUri: callbackUrl,
			state: sealedState,
			codeChallenge,
		});

		res.redirect(url);
	}

	/** Unseal the state returned from the upstream callback. */
	unsealState(sealedState: string): PendingAuthPayload | undefined {
		return unseal<PendingAuthPayload>(sealedState, this.key);
	}

	/** Re-seal a modified payload (e.g. after adding userId). */
	sealState(payload: PendingAuthPayload): string {
		return seal(payload, this.key);
	}

	completeAuthorization(pending: PendingAuthPayload, userId: string): {redirectUrl: string} {
		const code = seal<AuthCodePayload>({
			clientId: pending.clientId,
			userId,
			codeChallenge: pending.codeChallenge,
			redirectUri: pending.redirectUri,
			scopes: pending.scopes,
			expiresAt: Date.now() + AUTH_CODE_TTL_MS,
		}, this.key);

		const redirectUrl = new URL(pending.redirectUri);
		redirectUrl.searchParams.set('code', code);
		if (pending.state) {
			redirectUrl.searchParams.set('state', pending.state);
		}

		return {redirectUrl: redirectUrl.toString()};
	}

	async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
		const ac = unseal<AuthCodePayload>(authorizationCode, this.key);
		if (!ac) {
			throw new Error('Invalid authorization code');
		}

		return ac.codeChallenge;
	}

	// Note: we don't validate redirect_uri here. OAuth 2.1 requires it, but since we
	// don't enforce client registration (any client_id + redirect_uri is accepted), there's
	// nothing meaningful to check against. PKCE prevents code interception regardless.
	async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
		const ac = unseal<AuthCodePayload>(authorizationCode, this.key);
		if (!ac) {
			throw new Error('Invalid authorization code');
		}

		if (ac.clientId !== client.client_id) {
			throw new Error('Authorization code was not issued to this client');
		}

		const accessToken = seal<TokenPayload>({
			type: 'access',
			clientId: client.client_id,
			userId: ac.userId,
			scopes: ac.scopes,
			expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
		}, this.key);

		const refreshToken = seal<TokenPayload>({
			type: 'refresh',
			clientId: client.client_id,
			userId: ac.userId,
			scopes: ac.scopes,
			expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
		}, this.key);

		return {
			access_token: accessToken,
			token_type: 'bearer',
			expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
			refresh_token: refreshToken,
			scope: ac.scopes.join(' '),
		};
	}

	async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
		const rt = unseal<TokenPayload>(refreshToken, this.key);
		if (!rt || rt.type !== 'refresh') {
			throw new Error('Invalid refresh token');
		}

		if (rt.clientId !== client.client_id) {
			throw new Error('Refresh token was not issued to this client');
		}

		const newAccessToken = seal<TokenPayload>({
			type: 'access',
			clientId: client.client_id,
			userId: rt.userId,
			scopes: rt.scopes,
			expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
		}, this.key);

		const newRefreshToken = seal<TokenPayload>({
			type: 'refresh',
			clientId: client.client_id,
			userId: rt.userId,
			scopes: rt.scopes,
			expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
		}, this.key);

		return {
			access_token: newAccessToken,
			token_type: 'bearer',
			expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
			refresh_token: newRefreshToken,
			scope: rt.scopes.join(' '),
		};
	}

	async verifyAccessToken(token: string): Promise<AuthInfo> {
		const td = unseal<TokenPayload>(token, this.key);
		if (!td || td.type !== 'access') {
			throw new Error('Invalid or expired access token');
		}

		return {
			token,
			clientId: td.clientId,
			scopes: td.scopes,
			expiresAt: Math.floor(td.expiresAt / 1000),
			extra: {userId: td.userId},
		};
	}

	async revokeToken(_client: OAuthClientInformationFull, _request: OAuthTokenRevocationRequest): Promise<void> {
		// Tokens are stateless sealed blobs — revocation is a no-op.
		// Tokens remain valid until their TTL expires.
	}
}
