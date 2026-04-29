import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
	afterEach, beforeEach, describe, expect, test,
} from 'vitest';
import {ProcessPool} from './process-pool.js';
import {Store} from './store.js';
import type {WrapperConfig} from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stubServerPath = path.join(__dirname, 'stub-stdio-server.fixture.ts');

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const waitForExit = async (pid: number, timeoutMs = 6000): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) {
			return true;
		}

		await new Promise<void>((resolve) => { // eslint-disable-line no-await-in-loop
			setTimeout(resolve, 50);
		});
	}

	return false;
};

const makeConfig = (): WrapperConfig => ({
	command: ['npx', 'tsx', stubServerPath],
	envBase: {},
	auth: {issuer: 'http://upstream.example', clientId: 'x', clientSecret: 'y'},
	storage: {adam: {TEST_USER: 'adam'}},
});

type PoolInternals = {
	processes: Map<string, {transport: {pid: number | null; onerror?: (err: Error) => void}}>;
};

describe('ProcessPool', () => {
	let store: Store;
	let pool: ProcessPool;

	beforeEach(() => {
		store = new Store(makeConfig());
		pool = new ProcessPool('npx', ['tsx', stubServerPath], {}, store);
	});

	afterEach(async () => {
		await pool.shutdown();
		store.close();
	});

	test('terminates the child process when transport.onerror fires', async () => {
		await pool.getClient('adam');

		const internals = pool as unknown as PoolInternals;
		const entry = internals.processes.get('adam');
		expect(entry).toBeDefined();
		const {pid} = entry!.transport;
		expect(pid).not.toBeNull();
		expect(isAlive(pid!)).toBe(true);

		// Simulate a transport-level error — the SDK fires this when, e.g., the child
		// writes malformed JSON to stdout, or the pipe breaks unexpectedly. The pool
		// must terminate the child rather than orphan it.
		entry!.transport.onerror?.(new Error('synthetic transport error'));

		expect(await waitForExit(pid!)).toBe(true);
		expect(internals.processes.has('adam')).toBe(false);
	}, 15_000);

	test('terminates the child process when the user is invalidated', async () => {
		await pool.getClient('adam');

		const internals = pool as unknown as PoolInternals;
		const {pid} = internals.processes.get('adam')!.transport;
		expect(pid).not.toBeNull();
		expect(isAlive(pid!)).toBe(true);

		pool.invalidateUser('adam');

		expect(await waitForExit(pid!)).toBe(true);
		expect(internals.processes.has('adam')).toBe(false);
	}, 15_000);
});
