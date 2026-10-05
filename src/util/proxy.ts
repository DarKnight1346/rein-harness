import {EnvHttpProxyAgent, setGlobalDispatcher} from 'undici';

/**
 * Corporate proxies: Node's built-in fetch ignores HTTPS_PROXY / HTTP_PROXY, so Rein's own requests
 * (updates, the decision model, web fetch, MCP servers) would go direct and fail behind a proxy.
 * When a proxy is set, route every fetch through it, honoring NO_PROXY, and never for local
 * connections (local MCP servers, sign-in callbacks). The CLIs Rein runs (claude, codex), MCP
 * servers and shell commands inherit the same variables. A TLS-inspecting proxy's certificate goes
 * in NODE_EXTRA_CA_CERTS (Node reads it at startup). Returns the proxy in use, credentials hidden.
 */
export function installProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pick = (...names: string[]) => names.map((n) => env[n]).find((v) => v && v.trim());
  const https = pick('HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy');
  const http = pick('HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy');
  if (!https && !http) return undefined;
  const noProxy = [pick('NO_PROXY', 'no_proxy'), 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
  setGlobalDispatcher(new EnvHttpProxyAgent({...(http ? {httpProxy: http} : {}), ...(https ? {httpsProxy: https} : {}), noProxy}));
  return (https ?? http)!.replace(/\/\/[^@/]*@/, '//***@');
}
