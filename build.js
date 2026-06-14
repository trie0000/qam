// QAM ビルド: src/main.ts → dist/qam.bundle.js（IIFE）。relay がこの dist を配信する。
// 配布先 Windows には Node を置かないため、dist/ はビルド済みをコミットして配る。
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function computeBuildId() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  try { walk('src'); } catch { /* ignore */ }
  files.push('package.json');
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    try { hash.update(f); hash.update('\0'); hash.update(fs.readFileSync(f)); } catch { /* ignore */ }
  }
  // 版識別子は内容ハッシュのみ（buildTime を含めない＝更新誤検知防止。開発基準 §6）。
  return hash.digest('hex').slice(0, 12);
}

const BUILD_ID = computeBuildId();
// ビルド日時(JST)。版識別子(BUILD_ID/version.txt)は内容ハッシュのままで、これは表示専用。
const BUILD_TIME = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' JST';
fs.mkdirSync('dist', { recursive: true });

esbuild.buildSync({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  loader: { '.css': 'text' },
  define: { __QAM_BUILD__: JSON.stringify(BUILD_ID), __QAM_BUILDTIME__: JSON.stringify(BUILD_TIME) },
  outfile: 'dist/qam.bundle.js',
  minify: true,
});
fs.writeFileSync('dist/version.txt', BUILD_ID);
console.log('[qam] built dist/qam.bundle.js  version=' + BUILD_ID + '  built=' + BUILD_TIME);
