import {test, expect} from 'vitest';
import {loadConfig} from './config';

const validAuth = {
	issuer: 'https://auth.example.com',
	clientId: 'my-client',
	clientSecret: 'my-secret',
};

const baseConfig = {
	command: ['npx', '-y', 'some-mcp-server'],
	auth: validAuth,
};

test('loads valid config with defaults', () => {
	const config = loadConfig(JSON.stringify(baseConfig));
	expect(config.command).toEqual(['npx', '-y', 'some-mcp-server']);
	expect(config.auth.scopes).toEqual(['openid']);
	expect(config.auth.userClaim).toBe('sub');
	expect(config.auth.clientId).toBe('my-client');
	expect(config.storage).toBe('memory');
	expect(config.port).toBe(3000);
	expect(config.host).toBe('0.0.0.0');
});

test('defaults clientId to mcp-auth-wrapper', () => {
	const config = loadConfig(JSON.stringify({
		...baseConfig,
		auth: {issuer: 'https://auth.example.com'},
	}));
	expect(config.auth.clientId).toBe('mcp-auth-wrapper');
});

test('clientSecret is optional', () => {
	const config = loadConfig(JSON.stringify({
		...baseConfig,
		auth: {issuer: 'https://auth.example.com', clientId: 'x'},
	}));
	expect(config.auth.clientSecret).toBeUndefined();
});

test('loads config with inline users (object storage)', () => {
	const config = loadConfig(JSON.stringify({
		...baseConfig,
		storage: {adam: {API_KEY: 'xxx'}},
	}));
	expect(config.storage).toEqual({adam: {API_KEY: 'xxx'}});
});

test('loads config with file path storage', () => {
	const config = loadConfig(JSON.stringify({
		...baseConfig,
		storage: '/data/mcp.sqlite',
	}));
	expect(config.storage).toBe('/data/mcp.sqlite');
});

test('loads config with envPerUser', () => {
	const config = loadConfig(JSON.stringify({
		...baseConfig,
		envPerUser: [{name: 'API_KEY', label: 'API Key', secret: true}],
	}));
	expect(config.envPerUser).toEqual([{name: 'API_KEY', label: 'API Key', secret: true}]);
});

test('rejects config without command', () => {
	expect(() => loadConfig(JSON.stringify({auth: validAuth}))).toThrow('command');
});

test('rejects config with string command', () => {
	expect(() => loadConfig(JSON.stringify({...baseConfig, command: 'npx'}))).toThrow('command');
});

test('rejects config without auth', () => {
	expect(() => loadConfig(JSON.stringify({command: ['echo']}))).toThrow('auth');
});

test('rejects config without auth.issuer', () => {
	expect(() => loadConfig(JSON.stringify({...baseConfig, auth: {clientId: 'x'}}))).toThrow('issuer');
});

test('rejects empty object storage', () => {
	expect(() => loadConfig(JSON.stringify({...baseConfig, storage: {}}))).toThrow('storage');
});

test('rejects array storage', () => {
	expect(() => loadConfig(JSON.stringify({...baseConfig, storage: []}))).toThrow('storage');
});

test('rejects envPerUser without name', () => {
	expect(() => loadConfig(JSON.stringify({...baseConfig, envPerUser: [{label: 'Key'}]}))).toThrow('name');
});

test('rejects envPerUser without label', () => {
	expect(() => loadConfig(JSON.stringify({...baseConfig, envPerUser: [{name: 'KEY'}]}))).toThrow('label');
});
