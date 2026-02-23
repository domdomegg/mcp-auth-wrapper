import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {Store} from './store.js';

const IDLE_TIMEOUT_MS = 300_000;
const noop = () => {/* ignore close errors */};

export class ProcessPool {
	private readonly processes = new Map<string, {
		client: Client;
		transport: StdioClientTransport;
		lastUsed: number;
	}>();

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
		const existing = this.processes.get(userId);
		if (existing) {
			existing.lastUsed = Date.now();
			return existing.client;
		}

		const userParams = this.store.getUser(userId);
		if (!userParams) {
			throw new Error(`Unknown user: ${userId}`);
		}

		const transport = new StdioClientTransport({
			command: this.command,
			args: this.args,
			env: {...process.env as Record<string, string>, ...this.baseEnv, ...userParams},
		});

		const client = new Client({name: 'mcp-auth-wrapper', version: '1.0.0'});
		await client.connect(transport);

		this.processes.set(userId, {client, transport, lastUsed: Date.now()});

		// Remove stale entry if the child process dies unexpectedly
		transport.onclose = () => {
			this.processes.delete(userId);
		};

		transport.onerror = () => {
			this.processes.delete(userId);
		};

		return client;
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
