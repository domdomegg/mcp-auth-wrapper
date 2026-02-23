import {describe, expect, test, vi} from 'vitest';
import {handleReconfigureCall, getReconfigureTool, RECONFIGURE_TOOL_NAME} from './reconfigure-tool.js';
import type {EnvParam} from './types.js';

const envPerUser: EnvParam[] = [
	{name: 'API_KEY', label: 'API Key'},
	{name: 'REGION', label: 'Region'},
];

const reconfigureUrl = 'http://localhost:3000/reconfigure?token=abc';

const makeDeps = (overrides: {upsertThrows?: boolean} = {}) => {
	const store = {
		upsertUser: overrides.upsertThrows
			? vi.fn(() => { throw new Error('read-only'); })
			: vi.fn(),
	};
	const pool = {invalidateUser: vi.fn()};
	return {
		store: store as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
		pool: pool as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
		userId: 'adam',
		envPerUser,
		reconfigureUrl,
		mocks: {store, pool},
	};
};

describe('getReconfigureTool', () => {
	test('generates tool definition with correct schema', () => {
		const tool = getReconfigureTool(reconfigureUrl, envPerUser);
		expect(tool.name).toBe(RECONFIGURE_TOOL_NAME);
		expect(tool.inputSchema.properties).toEqual({
			API_KEY: {type: 'string', description: 'API Key'},
			REGION: {type: 'string', description: 'Region'},
		});
	});
});

describe('handleReconfigureCall', () => {
	test('returns URL when called with no arguments', () => {
		const deps = makeDeps();
		const result = handleReconfigureCall({}, deps);
		expect(result.content[0].text).toContain(reconfigureUrl);
		expect(result).not.toHaveProperty('isError');
	});

	test('returns URL when called with empty string values', () => {
		const deps = makeDeps();
		const result = handleReconfigureCall({API_KEY: '', REGION: ''}, deps);
		expect(result.content[0].text).toContain(reconfigureUrl);
	});

	test('updates store and invalidates user on valid args', () => {
		const deps = makeDeps();
		const result = handleReconfigureCall({API_KEY: 'my-key', REGION: 'us-east'}, deps);
		expect(result.content[0].text).toContain('Configuration updated');
		expect(deps.mocks.store.upsertUser).toHaveBeenCalledWith('adam', {API_KEY: 'my-key', REGION: 'us-east'});
		expect(deps.mocks.pool.invalidateUser).toHaveBeenCalledWith('adam');
	});

	test('updates with partial args (only some params provided)', () => {
		const deps = makeDeps();
		const result = handleReconfigureCall({API_KEY: 'my-key'}, deps);
		expect(result.content[0].text).toContain('Configuration updated');
		expect(deps.mocks.store.upsertUser).toHaveBeenCalledWith('adam', {API_KEY: 'my-key'});
	});

	test('falls back to URL mode when storage is read-only', () => {
		const deps = makeDeps({upsertThrows: true});
		const result = handleReconfigureCall({API_KEY: 'my-key'}, deps);
		expect(result.content[0].text).toContain(reconfigureUrl);
		expect(result).not.toHaveProperty('isError');
	});

	test('returns error for unknown arguments', () => {
		const deps = makeDeps();
		const result = handleReconfigureCall({BOGUS: 'value'}, deps);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Unknown parameter(s): BOGUS');
		expect(result.content[0].text).toContain('Valid parameters: API_KEY, REGION');
	});

	test('returns error when mix of known and unknown arguments', () => {
		const deps = makeDeps();
		const result = handleReconfigureCall({API_KEY: 'ok', NOPE: 'bad'}, deps);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('NOPE');
		expect(deps.mocks.store.upsertUser).not.toHaveBeenCalled();
	});
});
