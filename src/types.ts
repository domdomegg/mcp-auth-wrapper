export type EnvParam = {
	name: string;
	label: string;
	description?: string;
	secret?: boolean;
};

export type AuthConfig = {
	issuer: string;
	clientId: string;
	clientSecret?: string;
	scopes?: string[];
	userClaim?: string;
};

export type WrapperConfig = {
	command: string[];
	auth: AuthConfig;
	/** `"memory"`, a file path for SQLite, or an inline user map (read-only). Defaults to `"memory"`. */
	storage: string | Record<string, Record<string, string>>;
	envBase?: Record<string, string>;
	envPerUser?: EnvParam[];
	port?: number;
	host?: string;
	issuerUrl?: string;
	secret?: string;
};
