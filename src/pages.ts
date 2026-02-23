import type {EnvParam} from './types.js';

const escapeHtml = (s: string): string => s
	.replace(/&/g, '&amp;')
	.replace(/</g, '&lt;')
	.replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;');

export const renderParamsForm = (
	params: EnvParam[],
	sessionId: string,
	existingValues?: Record<string, string>,
): string => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Configure MCP Server</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 20px}
label{display:block;margin:16px 0 4px;font-weight:600}
input{width:100%;padding:8px;box-sizing:border-box;border:1px solid #ccc;border-radius:4px}
button{margin-top:20px;padding:10px 24px;background:#0066cc;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:16px}
.desc{font-size:13px;color:#666;margin-top:2px}</style>
</head><body>
<h1>Configure MCP Server</h1>
<p>Enter your credentials to complete setup.</p>
<form method="POST">
<input type="hidden" name="session" value="${escapeHtml(sessionId)}">
${params.map((p) => `<label for="${escapeHtml(p.name)}">${escapeHtml(p.label)}</label>
${p.description ? `<div class="desc">${escapeHtml(p.description)}</div>` : ''}
<input id="${escapeHtml(p.name)}" name="${escapeHtml(p.name)}" type="${p.secret ? 'password' : 'text'}" value="${escapeHtml(existingValues?.[p.name] ?? '')}">`).join('\n')}
<button type="submit">Save &amp; Continue</button>
</form></body></html>`;

export const renderReconfigurePage = (
	params: EnvParam[],
	token: string,
	existingValues: Record<string, string>,
	saved?: boolean,
): string => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reconfigure MCP Server</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 20px}
label{display:block;margin:16px 0 4px;font-weight:600}
input{width:100%;padding:8px;box-sizing:border-box;border:1px solid #ccc;border-radius:4px}
button{margin-top:20px;padding:10px 24px;background:#0066cc;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:16px}
.desc{font-size:13px;color:#666;margin-top:2px}
.success{background:#d4edda;border:1px solid #c3e6cb;padding:12px;border-radius:4px;margin-bottom:16px}</style>
</head><body>
<h1>Reconfigure MCP Server</h1>
${saved ? '<div class="success">Settings saved. Your MCP server will use the new configuration on the next request.</div>' : ''}
<p>Update your credentials below.</p>
<form method="POST">
<input type="hidden" name="token" value="${escapeHtml(token)}">
${params.map((p) => `<label for="${escapeHtml(p.name)}">${escapeHtml(p.label)}</label>
${p.description ? `<div class="desc">${escapeHtml(p.description)}</div>` : ''}
<input id="${escapeHtml(p.name)}" name="${escapeHtml(p.name)}" type="${p.secret ? 'password' : 'text'}" value="${escapeHtml(existingValues[p.name] ?? '')}">`).join('\n')}
<button type="submit">Save</button>
</form></body></html>`;
