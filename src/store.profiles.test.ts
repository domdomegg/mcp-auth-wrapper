import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	afterEach, beforeEach, describe, expect, test,
} from 'vitest';
import {DEFAULT_PROFILE_ID, Store} from './store.js';
import type {WrapperConfig} from './types.js';

const makeConfig = (): WrapperConfig => ({
	command: ['true'],
	envBase: {},
	auth: {issuer: 'http://upstream.example', clientId: 'x', clientSecret: 'y'},
	storage: 'memory',
});

describe('Store — profiles', () => {
	let store: Store;

	beforeEach(() => {
		store = new Store(makeConfig());
	});

	afterEach(() => {
		store.close();
	});

	test('a client with no binding resolves to the default profile', () => {
		// Everything connected before profiles existed must keep working.
		expect(store.resolveProfileId('adam', 'client-1')).toBe(DEFAULT_PROFILE_ID);
		expect(store.resolveProfileId('adam', undefined)).toBe(DEFAULT_PROFILE_ID);
	});

	test('binding a client routes it to that profile', () => {
		store.upsertProfile('adam', 'work', 'Work', {TOKEN: 'w'});
		store.setBinding('adam', 'client-2', 'work');

		expect(store.resolveProfileId('adam', 'client-2')).toBe('work');
		// Other clients are unaffected.
		expect(store.resolveProfileId('adam', 'client-1')).toBe(DEFAULT_PROFILE_ID);
	});

	test('profiles hold their own params', () => {
		store.upsertProfile('adam', DEFAULT_PROFILE_ID, 'Default', {TOKEN: 'personal'});
		store.upsertProfile('adam', 'work', 'Work', {TOKEN: 'work'});

		expect(store.getProfile('adam', DEFAULT_PROFILE_ID)?.params).toEqual({TOKEN: 'personal'});
		expect(store.getProfile('adam', 'work')?.params).toEqual({TOKEN: 'work'});
	});

	test('profiles are per user', () => {
		store.upsertProfile('adam', 'work', 'Work', {TOKEN: 'a'});
		expect(store.getProfile('bella', 'work')).toBeUndefined();
	});

	test('deleting a profile rebinds its clients to the default', () => {
		store.upsertProfile('adam', DEFAULT_PROFILE_ID, 'Default', {});
		store.upsertProfile('adam', 'work', 'Work', {});
		store.setBinding('adam', 'client-2', 'work');

		store.deleteProfile('adam', 'work');

		// Must not be left pointing at something that no longer exists.
		expect(store.getProfile('adam', 'work')).toBeUndefined();
		expect(store.resolveProfileId('adam', 'client-2')).toBe(DEFAULT_PROFILE_ID);
	});

	test('the default profile cannot be deleted', () => {
		store.upsertProfile('adam', DEFAULT_PROFILE_ID, 'Default', {});
		expect(() => {
			store.deleteProfile('adam', DEFAULT_PROFILE_ID);
		}).toThrow(/default/i);
	});

	test('a client can be moved between profiles', () => {
		store.upsertProfile('adam', 'work', 'Work', {});
		store.setBinding('adam', 'client-2', 'work');
		store.setBinding('adam', 'client-2', DEFAULT_PROFILE_ID);

		expect(store.resolveProfileId('adam', 'client-2')).toBe(DEFAULT_PROFILE_ID);
	});

	test('listProfiles puts the default first', () => {
		store.upsertProfile('adam', 'work', 'Work', {});
		store.upsertProfile('adam', DEFAULT_PROFILE_ID, 'Default', {});

		expect(store.listProfiles('adam').map((p) => p.id)).toEqual([DEFAULT_PROFILE_ID, 'work']);
	});

	test('existing user params become the default profile on upgrade', () => {
		// Pre-profiles installs store params against the user directly. Reopening
		// the same file is what an upgrade actually looks like, so use one rather
		// than an in-memory db, which is not shared between instances.
		const file = join(mkdtempSync(join(tmpdir(), 'wrapper-store-')), 'mcp.sqlite');
		const before = new Store({...makeConfig(), storage: file});
		before.upsertUser('legacy', {TOKEN: 'old'});
		// Simulate a row written before profiles existed.
		before.close();

		const after = new Store({...makeConfig(), storage: file});
		try {
			const profile = after.getProfile('legacy', DEFAULT_PROFILE_ID);
			expect(profile?.params).toEqual({TOKEN: 'old'});
			// And that user's clients resolve to it without any binding.
			expect(after.resolveProfileId('legacy', 'client-1')).toBe(DEFAULT_PROFILE_ID);
		} finally {
			after.close();
		}
	});

	test('writing the default profile keeps the legacy user row in step', () => {
		// So a rollback to a build without profiles still finds its params.
		store.upsertProfile('adam', DEFAULT_PROFILE_ID, 'Default', {TOKEN: 'v'});
		expect(store.getUser('adam')).toEqual({TOKEN: 'v'});
	});

	// Reconfigure edits whichever profile the connection resolves to. Writing to
	// the user row instead would leave the running configuration untouched,
	// which is what happened before the reconfigure page knew about profiles.
	test('editing a bound profile changes what that client resolves to', () => {
		store.upsertProfile('adam', DEFAULT_PROFILE_ID, 'Default', {TOKEN: 'personal'});
		store.upsertProfile('adam', 'work', 'Work', {TOKEN: 'old'});
		store.setBinding('adam', 'client-2', 'work');

		const bound = store.resolveProfileId('adam', 'client-2');
		store.upsertProfile('adam', bound, 'Work', {TOKEN: 'new'});

		expect(store.getProfile('adam', 'work')?.params).toEqual({TOKEN: 'new'});
		// The other profile is untouched.
		expect(store.getProfile('adam', DEFAULT_PROFILE_ID)?.params).toEqual({TOKEN: 'personal'});
	});

	test('renaming keeps the profile id, its params and its bindings', () => {
		store.upsertProfile('adam', 'work', 'Work', {TOKEN: 'w'});
		store.setBinding('adam', 'client-2', 'work');

		const profile = store.getProfile('adam', 'work')!;
		store.upsertProfile('adam', 'work', 'Claube', profile.params);

		expect(store.getProfile('adam', 'work')?.label).toBe('Claube');
		expect(store.getProfile('adam', 'work')?.params).toEqual({TOKEN: 'w'});
		expect(store.resolveProfileId('adam', 'client-2')).toBe('work');
	});
});
