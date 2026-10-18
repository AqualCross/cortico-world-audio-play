#!/usr/bin/env node
/**
 * 重新生成 describe.json（与框架 `pnpm describe:extension` 对 World 的导出一致）：
 * 工具与事件取自定义的 describe；这个 World 没有提示词文档。
 * 跑法：node tools/describe.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const mod = await import(pathToFileURL(join(pkgDir, 'src', 'index.js')).href);
const def = mod.default;

const file = {
  tools: [...def.describe.tools],
  events: [...def.describe.events],
};
writeFileSync(join(pkgDir, 'describe.json'), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
console.log(`describe.json 已写入：${file.tools.length} 个工具，${file.events.length} 个事件。`);
