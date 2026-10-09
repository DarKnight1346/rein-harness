import {existsSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Build caches a repo is set up with (Bazel remote/disk cache, Nx Cloud, Turborepo remote cache, the
 * Gradle build cache), so agent builds use them, and /build can say whether the sandbox lets them.
 */
export type BuildCache = {system: 'bazel' | 'nx' | 'turbo' | 'gradle'; kind: 'remote' | 'local'; where: string};

const read = (f: string) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

export function detectCaches(root: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): BuildCache[] {
  const out: BuildCache[] = [];
  const bazelrc = ['.bazelrc', 'user.bazelrc', '.bazelrc.user'].map((f) => read(path.join(root, f))).join('\n') + read(path.join(home, '.bazelrc'));
  for (const m of bazelrc.matchAll(/--(remote_cache|remote_executor|disk_cache)[= ](\S+)/g)) out.push({system: 'bazel', kind: m[1] === 'disk_cache' ? 'local' : 'remote', where: m[2]!});
  const nx = read(path.join(root, 'nx.json'));
  if (nx) out.push(/"nxCloud(?:AccessToken|Id)"/.test(nx) || env.NX_CLOUD_ACCESS_TOKEN ? {system: 'nx', kind: 'remote', where: 'Nx Cloud'} : {system: 'nx', kind: 'local', where: '.nx/cache'});
  if (existsSync(path.join(root, 'turbo.json')))
    out.push(env.TURBO_TOKEN || /"token"/.test(read(path.join(root, '.turbo', 'config.json'))) ? {system: 'turbo', kind: 'remote', where: env.TURBO_API ?? 'Vercel Remote Cache'} : {system: 'turbo', kind: 'local', where: '.turbo/cache'});
  const gradle = read(path.join(root, 'gradle.properties')) + read(path.join(root, 'settings.gradle')) + read(path.join(root, 'settings.gradle.kts'));
  if (/org\.gradle\.caching\s*=\s*true/.test(gradle) || /buildCache\s*\{/.test(gradle)) out.push({system: 'gradle', kind: /remote\s*[(<{]/.test(gradle) ? 'remote' : 'local', where: /remote\s*[(<{]/.test(gradle) ? 'remote build cache' : '~/.gradle/caches/build-cache-1'});
  return out;
}

/** Folders a build system writes outside the project, that the sandbox should leave writable (macOS Bazel's output base). */
export function buildOutputDirs(): string[] {
  const user = os.userInfo().username;
  return process.platform === 'darwin' ? [`/private/var/tmp/_bazel_${user}`].filter((p) => existsSync(p)) : [];
}
