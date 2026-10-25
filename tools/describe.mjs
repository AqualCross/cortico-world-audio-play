#!/usr/bin/env node
/**
 * 重新生成 describe.json（与框架 `pnpm describe:extension` 对 World 的导出一致）：
 * 工具与事件取自定义的 describe，提示词取 role=envPrompt 的模板原文。
 * 跑法：node tools/describe.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const mod = await import(pathToFileURL(join(pkgDir, 'src', 'index.js')).href);
const def = mod.default;

// 官方导出器用一个临时部署构造 World，再读 webUi('zh') 的提示词声明；
// 这里只构造实例、不调用 start()。
const world = def.create({
  cfg: def.defaults(),
  dataDir: join(tmpdir(), 'audio-play-describe'),
  botDir: pkgDir,
  persist: () => {},
});
const docs = (world.webUi?.('zh')?.promptDocs ?? []).filter((doc) => doc.role === 'envPrompt');
const prompts = [];
const seen = new Set();
for (const doc of docs) {
  if (seen.has(doc.key) || !existsSync(doc.path)) continue;
  seen.add(doc.key);
  prompts.push({
    key: doc.key,
    title: doc.title,
    ...(doc.role ? { role: doc.role } : {}),
    content: readFileSync(doc.path, 'utf8'),
  });
}

const file = {
  tools: [...def.describe.tools],
  events: [...def.describe.events],
  ...(prompts.length ? { prompts } : {}),
};
writeFileSync(join(pkgDir, 'describe.json'), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
console.log(`describe.json 已写入：${file.tools.length} 个工具，${file.events.length} 个事件，${prompts.length} 个提示词。`);
