import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
	afterEach, beforeEach, describe, expect, test,
} from 'vitest';
import {type Client} from '@modelcontextprotocol/sdk/client/index.js';
import {type StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
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

const wait = async (ms: number) => new Promise<void>((resolve) => {
	setTimeout(resolve, ms);
});

type PoolEntry = {
	client: Client;
	transport: StdioClientTransport;
	lastUsed: number;
};

type PoolInternals = {
	processes: Map<string, PoolEntry>;
	reapIdle: () => void;
};

/**
 * Polls the pool's internal map to record every PID that ever made it in,
 * then at the end identifies PIDs that are still alive but no longer tracked
 * — i.e. children the pool has lost references to and can no longer kill.
 */
class LeakDetector {
	private readonly observed = new Set<number>();
	private readonly interval: ReturnType<typeof setInterval>;

	constructor(private readonly internals: PoolInternals) {
		this.interval = setInterval(() => {
			for (const e of internals.processes.values()) {
				if (e.transport.pid !== null && e.transport.pid !== undefined) {
					this.observed.add(e.transport.pid);
				}
			}
		}, 5);
	}

	stop(): void {
		clearInterval(this.interval);
	}

	/**
	 * Wait for any in-flight close() Promises to settle, then report orphan PIDs:
	 * processes we saw in the map at some point that are still alive but no
	 * longer tracked. Also tries to clean them up so they don't bleed into other tests.
	 */
	async findOrphans(settleMs = 500): Promise<number[]> {
		this.stop();
		await wait(settleMs);
		const inMap = new Set<number>();
		for (const e of this.internals.processes.values()) {
			if (e.transport.pid !== null && e.transport.pid !== undefined) {
				inMap.add(e.transport.pid);
			}
		}

		const orphans = [...this.observed].filter((p) => !inMap.has(p) && isAlive(p));
		// Best-effort cleanup so orphans don't survive into the next test.
		for (const pid of orphans) {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {/* already gone */}
		}

		return orphans;
	}
}

const makeConfig = (users: Record<string, Record<string, string>> = {adam: {TEST_USER: 'adam'}}): WrapperConfig => ({
	command: ['npx', 'tsx', stubServerPath],
	envBase: {},
	auth: {issuer: 'http://upstream.example', clientId: 'x', clientSecret: 'y'},
	storage: users,
});

describe('ProcessPool — leak regressions', () => {
	let store: Store;
	let pool: ProcessPool;
	let internals: PoolInternals;
	let leaks: LeakDetector;

	beforeEach(() => {
		store = new Store(makeConfig());
		pool = new ProcessPool('npx', ['tsx', stubServerPath], {}, store);
		internals = pool as unknown as PoolInternals;
		leaks = new LeakDetector(internals);
	});

	afterEach(async () => {
		const orphans = await leaks.findOrphans(0);
		await pool.shutdown();
		store.close();
		if (orphans.length > 0) {
			// Fail loudly even if a test forgot to assert — orphan = leak.
			throw new Error(`Test leaked ${orphans.length} orphan child process(es): ${orphans.join(', ')}`);
		}
	});

	test('stale transport.onclose from a prior child does not evict the fresh entry', async () => {
		// Spawn child A.
		await pool.getClient('adam');
		const oldEntry = internals.processes.get('adam')!;
		const oldPid = oldEntry.transport.pid!;
		const staleOnclose = oldEntry.transport.onclose;
		expect(staleOnclose).toBeDefined();

		// Reap A: drops it from the map and fires-and-forgets close. A's child
		// will exit some milliseconds later, at which point its onclose fires.
		oldEntry.lastUsed = 0;
		internals.reapIdle();
		expect(internals.processes.has('adam')).toBe(false);

		// In the meantime, a fresh request comes in for the same user, spawning B.
		await pool.getClient('adam');
		const newEntry = internals.processes.get('adam')!;
		expect(newEntry.transport.pid).not.toBe(oldPid);
		const newPid = newEntry.transport.pid!;

		// Now A's child fully exits and its (now-stale) onclose fires.
		// On the buggy code this evicts B from the map.
		staleOnclose?.();

		// B must remain tracked.
		expect(internals.processes.get('adam')).toBe(newEntry);
		expect(isAlive(newPid)).toBe(true);

		// And no orphans.
		await waitForExit(oldPid);
		expect(await leaks.findOrphans()).toEqual([]);
	}, 15_000);

	test('stale transport.onerror from a prior child does not evict the fresh entry', async () => {
		await pool.getClient('adam');
		const oldEntry = internals.processes.get('adam')!;
		const oldPid = oldEntry.transport.pid!;
		const staleOnerror = oldEntry.transport.onerror;

		// Same setup as above but exercising the onerror handler.
		pool.invalidateUser('adam');
		expect(internals.processes.has('adam')).toBe(false);

		await pool.getClient('adam');
		const newEntry = internals.processes.get('adam')!;
		expect(newEntry.transport.pid).not.toBe(oldPid);

		// A late transport error on the old transport fires its onerror,
		// which on the buggy code calls processes.delete(userId) → kills B's entry.
		staleOnerror?.(new Error('synthetic late error from old transport'));

		expect(internals.processes.get('adam')).toBe(newEntry);
		await waitForExit(oldPid);
		expect(await leaks.findOrphans()).toEqual([]);
	}, 15_000);

	test('invalidateUser then immediate getClient leaks no children once the old close completes', async () => {
		await pool.getClient('adam');
		const oldPid = internals.processes.get('adam')!.transport.pid!;

		pool.invalidateUser('adam');
		await pool.getClient('adam');
		const newPid = internals.processes.get('adam')!.transport.pid!;
		expect(newPid).not.toBe(oldPid);

		// Wait for A's child (and its onclose handler) to finish doing its thing.
		expect(await waitForExit(oldPid)).toBe(true);
		await wait(200);

		// B must still be tracked and alive.
		expect(internals.processes.get('adam')?.transport.pid).toBe(newPid);
		expect(isAlive(newPid)).toBe(true);
		expect(await leaks.findOrphans()).toEqual([]);
	}, 15_000);

	test('reapIdle then immediate getClient leaks no children', async () => {
		await pool.getClient('adam');
		const oldPid = internals.processes.get('adam')!.transport.pid!;

		// Force-stale the entry and trigger reap directly (avoid waiting 5 minutes).
		internals.processes.get('adam')!.lastUsed = 0;
		internals.reapIdle();

		await pool.getClient('adam');
		const newPid = internals.processes.get('adam')!.transport.pid!;
		expect(newPid).not.toBe(oldPid);

		expect(await waitForExit(oldPid)).toBe(true);
		await wait(200);

		expect(internals.processes.get('adam')?.transport.pid).toBe(newPid);
		expect(await leaks.findOrphans()).toEqual([]);
	}, 15_000);
});

describe('ProcessPool — concurrent spawn race', () => {
	let store: Store;
	let pool: ProcessPool;
	let internals: PoolInternals;
	let leaks: LeakDetector;

	beforeEach(() => {
		store = new Store(makeConfig());
		pool = new ProcessPool('npx', ['tsx', stubServerPath], {}, store);
		internals = pool as unknown as PoolInternals;
		leaks = new LeakDetector(internals);
	});

	afterEach(async () => {
		const orphans = await leaks.findOrphans(0);
		await pool.shutdown();
		store.close();
		if (orphans.length > 0) {
			throw new Error(`Test leaked ${orphans.length} orphan child process(es): ${orphans.join(', ')}`);
		}
	});

	test('two concurrent getClient calls for the same user share one child', async () => {
		const [a, b] = await Promise.all([pool.getClient('adam'), pool.getClient('adam')]);
		expect(a).toBe(b);
		await wait(200);
		expect(await leaks.findOrphans()).toEqual([]);
	}, 15_000);

	test('many concurrent getClient calls for the same user share one child', async () => {
		const N = 25;
		const clients = await Promise.all(Array.from({length: N}, async () => pool.getClient('adam')));
		expect(new Set(clients).size).toBe(1);
		await wait(200);
		expect(await leaks.findOrphans()).toEqual([]);
	}, 30_000);
});

describe('ProcessPool — stress', () => {
	let store: Store;
	let pool: ProcessPool;
	let internals: PoolInternals;
	let leaks: LeakDetector;

	beforeEach(() => {
		store = new Store(makeConfig({
			adam: {TEST_USER: 'adam'},
			beth: {TEST_USER: 'beth'},
			carl: {TEST_USER: 'carl'},
		}));
		pool = new ProcessPool('npx', ['tsx', stubServerPath], {}, store);
		internals = pool as unknown as PoolInternals;
		leaks = new LeakDetector(internals);
	});

	afterEach(async () => {
		const orphans = await leaks.findOrphans(0);
		await pool.shutdown();
		store.close();
		if (orphans.length > 0) {
			throw new Error(`Test leaked ${orphans.length} orphan child process(es): ${orphans.join(', ')}`);
		}
	});

	test('repeated invalidate-then-respawn for the same user does not accumulate orphans', async () => {
		const cycles = 8;
		for (let i = 0; i < cycles; i++) {
			await pool.getClient('adam'); // eslint-disable-line no-await-in-loop
			pool.invalidateUser('adam');
		}

		await pool.getClient('adam');
		// Allow any pending close()s to settle.
		await wait(3000);
		expect(internals.processes.has('adam')).toBe(true);
		expect(await leaks.findOrphans()).toEqual([]);
	}, 60_000);

	test('repeated reap-then-respawn for the same user does not accumulate orphans', async () => {
		const cycles = 8;
		for (let i = 0; i < cycles; i++) {
			await pool.getClient('adam'); // eslint-disable-line no-await-in-loop
			internals.processes.get('adam')!.lastUsed = 0;
			internals.reapIdle();
		}

		await pool.getClient('adam');
		await wait(3000);
		expect(internals.processes.has('adam')).toBe(true);
		expect(await leaks.findOrphans()).toEqual([]);
	}, 60_000);

	test('mixed concurrent operations across users do not leak', async () => {
		const users = ['adam', 'beth', 'carl'] as const;
		const ops: Promise<unknown>[] = [];

		// Burst-spawn each user a few times concurrently.
		for (let i = 0; i < 3; i++) {
			for (const u of users) {
				ops.push(pool.getClient(u));
			}
		}

		await Promise.all(ops);
		// Now mix concurrent invalidate + respawn across users.
		for (const u of users) {
			pool.invalidateUser(u);
		}

		await Promise.all(users.map(async (u) => pool.getClient(u)));
		await wait(3000);

		for (const u of users) {
			expect(internals.processes.has(u)).toBe(true);
		}

		expect(await leaks.findOrphans()).toEqual([]);
	}, 60_000);
});
