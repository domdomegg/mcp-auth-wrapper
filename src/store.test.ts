import {test, expect, beforeEach} from 'vitest';
import {Store} from './store';
import type {WrapperConfig} from './types';

const baseAuth = {
	issuer: 'https://auth.example.com',
	clientId: 'test',
	clientSecret: 'secret',
};

const memoryConfig: WrapperConfig = {
	command: ['echo'],
	auth: baseAuth,
	storage: 'memory',
};

let store: Store;

beforeEach(() => {
	store = new Store(memoryConfig);
});

test('upsertUser and getUser', () => {
	expect(store.getUser('adam')).toBeUndefined();
	store.upsertUser('adam', {API_KEY: 'xxx'});
	expect(store.getUser('adam')).toEqual({API_KEY: 'xxx'});
});

test('upsertUser overwrites existing', () => {
	store.upsertUser('adam', {API_KEY: 'old'});
	store.upsertUser('adam', {API_KEY: 'new'});
	expect(store.getUser('adam')).toEqual({API_KEY: 'new'});
});

test('inline storage seeds users and prevents mutations', () => {
	const inlineStore = new Store({
		...memoryConfig,
		storage: {adam: {KEY: 'val'}},
	});
	expect(inlineStore.getUser('adam')).toEqual({KEY: 'val'});
	expect(() => {
		inlineStore.upsertUser('bob', {KEY: 'val'});
	}).toThrow('inline');
});
