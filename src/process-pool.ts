import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {Store} from './store.js';

const IDLE_TIMEOUT_MS = 300_000;
const noop = () => {/* ignore close errors */};

type Entry = {
	client: Client;
	transport: StdioClientTransport;
	lastUsed: number;
};

export class ProcessPool {
	// The published view of currently-tracked children. Mutations to this map
	// must always be guarded by an identity check on the entry being removed,
	// because a stale transport's onclose may fire long after its entry has
	// been replaced — see attachHandlers below.
	private readonly processes = new Map<string, Entry>();

	// Concurrent getClient calls for the same user share one Promise so we
	// only ever spawn one child per (userId, in-flight burst).
	private readonly inflight = new Map<string, Promise<Entry>>();

	private readonly reapInterval: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly command: string,
		private readonly args: string[],
		private readonly baseEnv: Record<string, string>,
		private readonly store: Store,
	) {
		this.reapInterval = setInterval(() => {
			this.reapIdle();
		}, 60_000);
	}

	async getClient(userId: string): Promise<Client> {
		const ready = this.processes.get(userId);
		if (ready) {
			ready.lastUsed = Date.now();
			return ready.client;
		}

		const pending = this.inflight.get(userId);
		if (pending) {
			const entry = await pending;
			entry.lastUsed = Date.now();
			return entry.client;
		}

		const userParams = this.store.getUser(userId);
		if (!userParams) {
			throw new Error(`Unknown user: ${userId}`);
		}

		// Build the spawn promise synchronously and publish it before any await,
		// so concurrent callers all see it on their next tick.
		const spawnPromise = this.spawn(userId, userParams);
		this.inflight.set(userId, spawnPromise);

		spawnPromise.catch(noop).finally(() => {
			if (this.inflight.get(userId) === spawnPromise) {
				this.inflight.delete(userId);
			}
		});

		const entry = await spawnPromise;
		entry.lastUsed = Date.now();
		return entry.client;
	}

	invalidateUser(userId: string): void {
		const entry = this.processes.get(userId);
		if (entry) {
			entry.client.close().catch(noop);
			this.processes.delete(userId);
		}
	}

	async shutdown(): Promise<void> {
		if (this.reapInterval) {
			clearInterval(this.reapInterval);
		}

		await Promise.all([...this.processes.values()].map(async (entry) => entry.client.close().catch(noop)));
		this.processes.clear();
	}

	private async spawn(userId: string, userParams: Record<string, string>): Promise<Entry> {
		const transport = new StdioClientTransport({
			command: this.command,
			args: this.args,
			env: {...process.env as Record<string, string>, ...this.baseEnv, ...userParams},
		});

		const client = new Client({name: 'mcp-auth-wrapper', version: '1.0.0'});
		const entry: Entry = {client, transport, lastUsed: Date.now()};

		// Attach handlers BEFORE awaiting connect so a close-during-connect is caught.
		this.attachHandlers(userId, entry);

		await client.connect(transport);

		// Publish into `processes` synchronously after connect completes, so any
		// caller awaiting the spawn promise sees the entry in the map immediately.
		this.processes.set(userId, entry);
		return entry;
	}

	private attachHandlers(userId: string, entry: Entry): void {
		// Identity guard: only mutate the map if the entry being closed is
		// still the active one for this user. A late close from a prior child
		// must not evict its replacement.
		const removeIfCurrent = () => {
			if (this.processes.get(userId) === entry) {
				this.processes.delete(userId);
			}
		};

		entry.transport.onclose = removeIfCurrent;
		entry.transport.onerror = () => {
			removeIfCurrent();
			entry.transport.close().catch(noop);
		};
	}

	private reapIdle(): void {
		const now = Date.now();
		for (const [userId, entry] of this.processes) {
			if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
				entry.client.close().catch(noop);
				this.processes.delete(userId);
			}
		}
	}
}
