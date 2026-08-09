import {DEFAULT_PROFILE_ID} from './store.js';
import type {EnvParam} from './types.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS module, can't use import.meta
const pkg = require('../package.json') as {version: string; repository?: {url?: string}};
const {version} = pkg;
const repoUrl = pkg.repository?.url?.replace(/\.git$/, '').replace(/^git\+/, '') ?? 'https://github.com/domdomegg/mcp-auth-wrapper';

const VARS_LIGHT = `--bg: #fafafa; --fg: #111; --muted: #888; --subtle: #999;
      --input-bg: #fff; --input-border: #ddd; --input-focus: #999;
      --btn-bg: #111; --btn-fg: #fafafa; --btn-hover: #333;
      --banner-bg: #f0fdf4; --banner-fg: #166534; --banner-border: #bbf7d0;
      --footer: #aaa; --footer-hover: #888;`;

const VARS_DARK = `--bg: #161616; --fg: #e5e5e5; --muted: #777; --subtle: #666;
      --input-bg: #1e1e1e; --input-border: #333; --input-focus: #666;
      --btn-bg: #e5e5e5; --btn-fg: #161616; --btn-hover: #ccc;
      --banner-bg: #052e16; --banner-fg: #4ade80; --banner-border: #166534;
      --footer: #555; --footer-hover: #777;`;

const STYLES = `@media (prefers-color-scheme: light) { :root { ${VARS_LIGHT} } }
  @media (prefers-color-scheme: dark) { :root { ${VARS_DARK} } }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace; padding: 48px 24px; max-width: 520px; margin: 0 auto; background: var(--bg); color: var(--fg); }
  h1 { font-size: 14px; text-transform: uppercase; letter-spacing: 2px; font-weight: 700; margin-bottom: 8px; color: var(--muted); }
  .msg { font-size: 13px; color: var(--subtle); margin-bottom: 28px; }
  .banner { font-size: 12px; padding: 10px 14px; border: 1px solid var(--banner-border); border-radius: 4px; margin-bottom: 20px; background: var(--banner-bg); color: var(--banner-fg); }
  label { display: block; font-size: 12px; font-weight: 500; margin-top: 20px; margin-bottom: 4px; }
  .desc { font-size: 11px; color: var(--subtle); margin-bottom: 4px; }
  input { font: inherit; font-size: 13px; width: 100%; padding: 8px 10px; border: 1px solid var(--input-border); border-radius: 4px; background: var(--input-bg); color: var(--fg); }
  input:focus { border-color: var(--input-focus); border-width: 2px; padding: 7px 9px; outline: none; }
  /* Profile picker. Radios rather than a select: a native dropdown's option
     list is OS chrome that cannot be styled, and one control with one
     selection leaves no ambiguity about which profile is being used.
     Collapsed by default — the common case is not changing profile. */
  .step { border: 1px solid var(--input-border); border-radius: 4px; margin-bottom: 28px; }
  .step > summary { list-style: none; cursor: pointer; padding: 12px 14px; display: flex; align-items: baseline; gap: 8px; }
  .step > summary::-webkit-details-marker { display: none; }
  .step-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }
  .step-value { font-size: 13px; }
  .step-toggle { margin-left: auto; font-size: 11px; color: var(--subtle); }
  .step[open] > summary { border-bottom: 1px solid var(--input-border); }
  .step[open] .step-toggle::after { content: 'close'; }
  .step:not([open]) .step-toggle::after { content: 'change'; }
  .opts { padding: 4px 0; display: flex; flex-direction: column; }
  .opt { display: flex; align-items: center; gap: 10px; padding: 7px 14px; cursor: pointer; }
  .opt:hover { background: var(--input-bg); }
  /* Drawn by hand: accent-color alone leaves the unselected ring nearly
     invisible against a dark background. */
  .opt input[type=radio] { appearance: none; width: 14px; height: 14px; flex: none; margin: 0; border: 1px solid var(--muted); border-radius: 50%; background: transparent; display: grid; place-content: center; }
  .opt input[type=radio]:checked { border-color: var(--fg); }
  /* Centred by the grid rather than by insets, which ignore the border and
     leave the dot a pixel off. */
  .opt input[type=radio]::after { content: ''; width: 6px; height: 6px; border-radius: 50%; background: transparent; }
  .opt input[type=radio]:checked::after { background: var(--fg); }
  .opt-name { font-size: 13px; }
  .opt-actions { margin-left: auto; display: flex; gap: 12px; }
  .opt-actions a { font-size: 11px; color: var(--subtle); text-decoration: none; border-bottom: 1px solid var(--input-border); }
  .opt-actions a:hover { color: var(--fg); }
  /* block + auto margins fills the space left over, without the arithmetic:
     width:100% with margins overflows, and width:auto on an input falls back
     to its intrinsic size rather than stretching. */
  .new-name { display: block; margin: 0 14px 12px 38px; width: unset; min-width: 0; align-self: stretch; }
  button, .btn { display: inline-block; margin-top: 24px; font: inherit; font-size: 12px; font-weight: 600; padding: 8px 20px; border-radius: 4px; border: none; cursor: pointer; background: var(--btn-bg); color: var(--btn-fg); text-decoration: none; }
  button:hover, .btn:hover { background: var(--btn-hover); }
  footer { margin-top: 48px; font-size: 10px; color: var(--footer); }
  footer a { color: var(--footer); text-decoration: none; }
  footer a:hover { color: var(--footer-hover); border-bottom: 1px solid var(--footer-hover); }`;

const footerHtml = `<footer><a href="${escapeHtml(repoUrl)}">mcp-auth-wrapper</a> v${escapeHtml(version)}</footer>`;

const pageHead = (title: string) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="mcp-auth-wrapper">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>`;

const paramFields = (params: EnvParam[], existingValues?: Record<string, string>) => params.map((p) => `<label for="${escapeHtml(p.name)}">${escapeHtml(p.label)}</label>
${p.description ? `<div class="desc">${escapeHtml(p.description)}</div>` : ''}
<input id="${escapeHtml(p.name)}" name="${escapeHtml(p.name)}" type="${p.secret ? 'password' : 'text'}" value="${escapeHtml(existingValues?.[p.name] ?? '')}">`).join('\n');

export type ProfileChoice = {id: string; label: string; inUse?: boolean};

/** Radio value meaning "create one", so the picker stays a single control. */
export const NEW_PROFILE_OPTION = '__new__';

/**
 * Lets one identity keep several separate configurations of the same server.
 * Only rendered when there is genuinely a choice — with a single profile it
 * collapses to a hidden field, so the form is exactly as it was before
 * profiles existed.
 *
 * Rendered as its own step above the credential fields: picking a profile
 * decides *which* settings are being edited, so it is not a sibling of them.
 * "New profile" is one of the options rather than a separate field, so there
 * is only ever one answer to "which profile is this?".
 */
const profileStep = (profiles: ProfileChoice[], selected: string, manageUrl?: string): string => {
	if (profiles.length <= 1) {
		return `<input type="hidden" name="profileId" value="${escapeHtml(selected)}">`;
	}

	const current = profiles.find((p) => p.id === selected)?.label ?? 'Default';

	const actions = (p: ProfileChoice) => {
		if (!manageUrl) {
			return '';
		}

		const base = `${manageUrl}${manageUrl.includes('?') ? '&' : '?'}profile=${encodeURIComponent(p.id)}`;
		// The default profile is the fallback for everything else, so it cannot
		// be deleted — offering the link would only produce an error.
		const remove = p.id === DEFAULT_PROFILE_ID
			? ''
			: `<a href="${escapeHtml(`${base}&action=delete`)}">delete</a>`;
		return `<span class="opt-actions"><a href="${escapeHtml(`${base}&action=rename`)}">rename</a>${remove}</span>`;
	};

	const options = profiles.map((p) => `<label class="opt">
<input type="radio" name="profileId" value="${escapeHtml(p.id)}"${p.id === selected ? ' checked' : ''}>
<span class="opt-name">${escapeHtml(p.label)}</span>
${actions(p)}
</label>`).join('\n');

	return `<details class="step">
<summary><span class="step-label">Profile</span><span class="step-value">${escapeHtml(current)}</span><span class="step-toggle"></span></summary>
<div class="opts">
${options}
<label class="opt">
<input type="radio" name="profileId" value="${NEW_PROFILE_OPTION}">
<span class="opt-name">+ New profile</span>
</label>
<input class="new-name" name="newProfileLabel" type="text" placeholder="Name for the new profile">
</div>
</details>`;
};

export const renderParamsForm = (
	params: EnvParam[],
	sessionId: string,
	existingValues?: Record<string, string>,
	profiles: ProfileChoice[] = [],
	selectedProfile = 'default',
	manageUrl?: string,
): string => `${pageHead('Configure')}
<body>
<h1>Configure</h1>
<p class="msg">${describeConfigureIntent(params.length > 0, profiles.length > 1)}</p>
<form method="POST">
<input type="hidden" name="session" value="${escapeHtml(sessionId)}">
${profileStep(profiles, selectedProfile, manageUrl)}
${paramFields(params, existingValues)}
<button type="submit">save &amp; continue</button>
</form>
${footerHtml}
</body></html>`;

const describeConfigureIntent = (hasParams: boolean, hasChoice: boolean): string => {
	if (hasParams && hasChoice) {
		return 'Choose a profile, then enter its credentials.';
	}

	if (hasChoice) {
		return 'Choose which profile this connection uses.';
	}

	return 'Enter your credentials to complete setup.';
};

export const renderLandingPage = (installUrl: string, showSignIn: boolean): string => `${pageHead('mcp-auth-wrapper')}
<body>
<h1>mcp-auth-wrapper</h1>
<p class="msg" style="margin-bottom:16px">To connect, add this server to your MCP client — you'll be prompted to log in and enter any required credentials.</p>
<a class="btn" style="margin-top:0" href="${escapeHtml(installUrl)}">install in client</a>
${showSignIn ? '<p class="msg" style="margin-top:48px;margin-bottom:0">Already connected? <a href="/login" style="color:var(--fg)">Sign in</a> to update your configuration.</p>' : ''}
${footerHtml}
</body></html>`;

export const renderReconfigurePage = (
	params: EnvParam[],
	token: string,
	existingValues: Record<string, string>,
	saved?: boolean,
	profiles: ProfileChoice[] = [],
	activeProfile = DEFAULT_PROFILE_ID,
	renaming?: string,
): string => {
	// Renaming replaces the form entirely: it is a different edit from changing
	// credentials, and showing both at once invites saving the wrong one.
	if (renaming) {
		const label = profiles.find((p) => p.id === renaming)?.label ?? '';
		return `${pageHead('Rename profile')}
<body>
<h1>Rename profile</h1>
<p class="msg">Choose a new name for this profile.</p>
<form method="POST">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<input type="hidden" name="renameProfile" value="${escapeHtml(renaming)}">
<label for="renameTo">Name</label>
<input id="renameTo" name="renameTo" type="text" value="${escapeHtml(label)}">
<button type="submit">save</button>
</form>
${footerHtml}
</body></html>`;
	}

	const active = profiles.find((p) => p.id === activeProfile)?.label;

	return `${pageHead('Reconfigure')}
<body>
<h1>Reconfigure</h1>
${saved ? '<div class="banner">Settings saved. New configuration will be used on the next request.</div>' : ''}
<p class="msg">${active && profiles.length > 1
	? `Editing the <strong>${escapeHtml(active)}</strong> profile — the one this connection uses.`
	: 'Update your credentials below.'}</p>
<form method="POST">
<input type="hidden" name="token" value="${escapeHtml(token)}">
${paramFields(params, existingValues)}
<button type="submit">save</button>
</form>
${profiles.length > 1 ? renderProfileList(profiles, activeProfile, token) : ''}
${footerHtml}
</body></html>`;
};

/**
 * Profiles other than the one being edited, so they can be renamed or removed
 * without first connecting a client to them.
 */
const renderProfileList = (profiles: ProfileChoice[], activeProfile: string, token: string): string => {
	const rows = profiles.map((p) => {
		const base = `/reconfigure?token=${encodeURIComponent(token)}&profile=${encodeURIComponent(p.id)}`;
		const remove = p.id === DEFAULT_PROFILE_ID
			? ''
			: `<a href="${escapeHtml(`${base}&action=delete`)}">delete</a>`;
		return `<div class="opt">
<span class="opt-name">${escapeHtml(p.label)}${p.id === activeProfile ? ' <span class="step-label">in use here</span>' : ''}</span>
<span class="opt-actions"><a href="${escapeHtml(`${base}&action=rename`)}">rename</a>${remove}</span>
</div>`;
	}).join('\n');

	return `<div class="step" style="margin-top:40px">
<div class="step-label" style="padding:12px 14px 4px">Your profiles</div>
<div class="opts">${rows}</div>
</div>`;
};

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
