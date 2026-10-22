#!/usr/bin/env node
/**
 * 离线检查：不联网、不出声、不碰安装目录。跑法：node tools/check.mjs
 *
 * 覆盖：清单与声明 / 工具声明 / 配置组路径 / 路径与句柄解析 /
 * 临时文件清理 / 排队 / 取消 / 失败回执 / 自描述与 WebUI 形状。
 * 播放器本身用注入的假 playFile 顶掉，所以不会真的发出声音。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'audio-play-check-'));

let passed = 0;
let failed = 0;
let warned = 0;

const ok = (line) => { passed++; console.log(`  ok    ${line}`); };
const bad = (line) => { failed++; console.log(`  FAIL  ${line}`); };
const hint = (line) => { warned++; console.log(`  提醒  ${line}`); };

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message ?? '不相等'}：${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}
function check(label, fn) {
  try {
    fn();
    ok(label);
  } catch (err) {
    bad(`${label} — ${err?.message ?? err}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (err) {
    bad(`${label} — ${err?.message ?? err}`);
  }
}

/** 键序无关的 JSON 形态：对比 describe.json 与代码里的声明（与框架的深比较等价）。 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

const mod = await import(pathToFileURL(join(pkgDir, 'src', 'index.js')).href);
const def = mod.default;
const config = await import(pathToFileURL(join(pkgDir, 'src', 'config.js')).href);
const player = await import(pathToFileURL(join(pkgDir, 'src', 'player.js')).href);
const { AudioPlayWorld } = mod;

function makeWorld(overrides = {}, opts = {}) {
  const calls = [];
  const play = opts.play ?? (async () => ({ backend: 'fake' }));
  const dataDir = opts.dataDir ?? join(scratch, 'data');
  const botDir = opts.botDir ?? join(scratch, 'bot');
  const world = new AudioPlayWorld({
    cfg: { ...def.defaults(), enabled: true, ...overrides },
    dataDir,
    botDir,
    playFile: async (one) => {
      calls.push(one);
      return play(one);
    },
  });
  world.__calls = calls;
  return world;
}

function fakeHost(blobs = {}) {
  return {
    blob: (handle) => blobs[handle] ?? null,
    log: { info: () => {}, warn: () => {}, child() { return this; } },
  };
}

function writeFile(path, bytes = Buffer.from('fake-audio-bytes')) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

try {
  // -------------------------------------------------------------------------
  console.log('清单与声明');

  check('package.json 的 cortico 段与自描述', () => {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    eq(manifest.cortico?.kind, 'world', 'kind');
    eq(manifest.cortico?.api, 6, 'api');
    eq(manifest.cortico?.describe, 'describe.json', 'describe');
    eq(manifest.cortico?.displayName, '音频播放', 'displayName');
    assert(Array.isArray(manifest.keywords) && manifest.keywords.includes('cortico-world'), 'keywords 缺 cortico-world');
    assert(Array.isArray(manifest.files) && manifest.files.includes('describe.json'), 'files 缺 describe.json');
    assert(existsSync(join(pkgDir, 'describe.json')), 'describe.json 不在包里');
    // 这个 World 不要浏览器面板；没有 webUiClient 是刻意的。
    assert(manifest.cortico?.webUiClient === undefined, '不该声明 webUiClient');
    if (process.platform === 'win32') assert(existsSync(join(pkgDir, 'src', 'play.ps1')), 'Windows 缺 src/play.ps1');
  });

  check('CHANGELOG.md 有当前版本的一节', () => {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const src = readFileSync(join(pkgDir, 'CHANGELOG.md'), 'utf8');
    const version = String(manifest.version ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert(new RegExp(`^##\\s*\\[?${version}\\]?`, 'm').test(src), `CHANGELOG.md 缺 ## ${manifest.version} 一节`);
  });

  check('默认导出是 WorldDefinition', () => {
    eq(def.id, 'audio-play', 'id');
    eq(def.label, '音频播放', 'label');
    const defaults = def.defaults();
    eq(defaults.enabled, false, 'enabled 默认 false');
    eq(defaults.volume, 80, 'volume 默认');
    eq(defaults.timeoutMs, 120000, 'timeoutMs 默认');
    def.preflight(); // 当前平台满足时不抛
  });

  check('describe 与 describe.json 一致，实例工具都在声明里', () => {
    assert(def.describe && Array.isArray(def.describe.tools) && def.describe.tools.length === 1, '定义缺 describe.tools');
    assert(Array.isArray(def.describe.events), '定义缺 describe.events');
    const file = JSON.parse(readFileSync(join(pkgDir, 'describe.json'), 'utf8'));
    eq(stable(file), stable(JSON.parse(JSON.stringify(def.describe))), 'describe.json 与代码里的 describe 不一致');
    eq(file.tools[0].name, 'audio_play', 'describe 工具名');
    eq(file.events.length, 0, '这个 World 不该声明事件');
    const names = new Set(file.tools.map((t) => t.name));
    for (const tool of makeWorld().tools()) assert(names.has(tool.name), `工具 ${tool.name} 不在 describe.tools 里`);
  });

  check('配置组覆盖 DEFAULTS 的其余键（enabled 由框架开关管理），且都在 worlds.audio-play 段内', () => {
    const group = config.configGroup('zh');
    const paths = Object.keys(group.schema.properties);
    for (const path of paths) {
      assert(path.startsWith('worlds.audio-play.'), `配置路径不在 worlds.audio-play：${path}`);
      const short = path.slice('worlds.audio-play.'.length);
      assert(Object.hasOwn(config.DEFAULTS, short), `配置 ${short} 没有默认值`);
    }
    for (const short of Object.keys(config.DEFAULTS)) {
      if (short === 'enabled') {
        assert(!paths.includes('worlds.audio-play.enabled'), 'World 启用开关由框架渲染，不该进配置 schema');
        continue;
      }
      assert(paths.includes(`worlds.audio-play.${short}`), `默认值 ${short} 没有进 schema`);
    }
  });

  check('不写系统提示词，WebUI 只有配置与状态灯', () => {
    const world = makeWorld();
    eq(world.envPromptVars(), null, 'envPromptVars 应为 null');
    const decl = world.webUi('zh');
    assert(Array.isArray(decl.config) && decl.config.length === 1, '缺配置组');
    assert(!decl.panels || decl.panels.length === 0, '不该声明自定义面板');
    assert(Array.isArray(decl.lamps) && decl.lamps.length === 1, '缺状态灯');
    assert(Array.isArray(decl.badges) && decl.badges.length === 1, '缺徽标');
  });

  // -------------------------------------------------------------------------
  console.log('World 与工具');

  check('工具只有一个 audio_play，声明齐全', () => {
    const world = makeWorld();
    const tools = world.tools();
    eq(tools.length, 1, '工具数量');
    const tool = tools[0];
    eq(tool.name, 'audio_play', '工具名');
    assert(Array.isArray(tool.tags) && tool.tags.includes('act'), 'tags');
    eq(tool.interruptible, true, 'interruptible');
    eq(tool.parameters.required?.[0], 'audio', 'required[0]');
    assert(tool.parameters.properties?.audio, '缺 audio 参数');
    assert(tool.parameters.properties?.volume, '缺 volume 参数');
  });

  check('播放器工具函数与平台声明', () => {
    assert(typeof player.playFile === 'function', '缺 playFile');
    assert(player.supportedPlatform('win32') && player.supportedPlatform('darwin') && player.supportedPlatform('linux'), '支持的平台');
    assert(!player.supportedPlatform('aix'), '不支持的平台');
    if (process.platform === 'win32') assert(existsSync(player.playScriptPath()), 'play.ps1 不在');
  });

  // -------------------------------------------------------------------------
  console.log('路径与句柄');

  await checkAsync('相对路径先按 workspace 找，播放并回成功', async () => {
    const botDir = join(scratch, 'bot-relative');
    const workspace = join(botDir, 'workspace');
    const dataDir = join(scratch, 'data-relative');
    writeFile(join(workspace, 'hello.wav'), Buffer.from('hello-wav'));
    const world = makeWorld({ volume: 55 }, { botDir, dataDir });
    await world.start(fakeHost());
    const out = await world.tools()[0].handler({ audio: 'hello.wav' }, {});
    assert(!out.failed, `不该失败：${out.text}`);
    assert(out.text.includes('播放完了'), '回执缺字样');
    eq(world.__calls.length, 1, '播放次数');
    eq(world.__calls[0].path, join(workspace, 'hello.wav'), '路径');
    eq(world.__calls[0].volume, 55, '配置音量');
    await world.stop();
  });

  await checkAsync('绝对路径、file:// 与 volume 覆盖', async () => {
    const dataDir = join(scratch, 'data-absolute');
    const file = join(scratch, 'absolute.wav');
    writeFile(file);
    const world = makeWorld({ volume: 55 }, { dataDir });
    const tool = world.tools()[0];
    const one = await tool.handler({ audio: file, volume: 999 }, {});
    assert(!one.failed, one.text);
    eq(world.__calls.at(-1).path, file, '绝对路径');
    eq(world.__calls.at(-1).volume, 100, '音量上限');
    const two = await tool.handler({ audio: pathToFileURL(file).href, volume: -5 }, {});
    assert(!two.failed, two.text);
    eq(world.__calls.at(-1).path, file, 'file:// 路径');
    eq(world.__calls.at(-1).volume, 0, '音量下限');
  });

  await checkAsync('log: 句柄落成临时文件，放完就删', async () => {
    const dataDir = join(scratch, 'data-handle');
    const bytes = Buffer.from('handle-wav-bytes');
    const world = makeWorld({}, { dataDir });
    await world.start(fakeHost({ 'log:abc.wav': { bytes, mime: 'audio/wav' } }));
    let seen = null;
    world.playFile = async (one) => {
      seen = { ...one, bytes: readFileSync(one.path) };
      return { backend: 'fake' };
    };
    const out = await world.tools()[0].handler({ audio: 'log:abc.wav', volume: 30 }, {});
    assert(!out.failed, out.text);
    assert(out.text.includes('log:abc.wav'), '回执应显示句柄');
    assert(seen.path.endsWith('.wav'), `临时文件扩展名不对：${seen.path}`);
    assert(seen.bytes.equals(bytes), '临时文件内容不对');
    assert(!existsSync(seen.path), '临时文件应当已删除');
    eq(seen.volume, 30, '工具音量');
    await world.stop();
  });

  await checkAsync('mem: 句柄按 MIME 选扩展名', async () => {
    const dataDir = join(scratch, 'data-mem');
    const world = makeWorld({}, { dataDir });
    await world.start(fakeHost({ 'mem:voice': { bytes: Buffer.from('mp3-bytes'), mime: 'audio/mpeg' } }));
    let temp = '';
    world.playFile = async (one) => {
      temp = one.path;
      return { backend: 'fake' };
    };
    const out = await world.tools()[0].handler({ audio: 'mem:voice' }, {});
    assert(!out.failed, out.text);
    assert(temp.endsWith('.mp3'), `扩展名不对：${temp}`);
    assert(!existsSync(temp), '临时文件应当已删除');
    await world.stop();
  });

  await checkAsync('解析不了的句柄与找不到的文件都失败', async () => {
    const world = makeWorld({}, { botDir: join(scratch, 'bot-missing') });
    await world.start(fakeHost());
    const handle = await world.tools()[0].handler({ audio: 'log:nope.wav' }, {});
    assert(handle.failed && handle.text.includes('解析不出来'), handle.text);
    const missing = await world.tools()[0].handler({ audio: 'nope.wav' }, {});
    assert(missing.failed && missing.text.includes('找不到音频文件'), missing.text);
    await world.stop();
  });

  // -------------------------------------------------------------------------
  console.log('失败、排队与取消');

  await checkAsync('空参数不播放', async () => {
    const world = makeWorld();
    const out = await world.tools()[0].handler({ audio: '   ' }, {});
    assert(out.failed && out.text.includes('audio 是空的'), out.text);
    eq(world.__calls.length, 0, '不该调用播放器');
  });

  await checkAsync('播放器失败原样变成失败回执', async () => {
    const file = writeFile(join(scratch, 'fail.wav'));
    const world = makeWorld({}, {
      play: async () => {
        throw new player.PlaybackError('failed', '测试用的播放失败。');
      },
    });
    const out = await world.tools()[0].handler({ audio: file }, {});
    assert(out.failed && out.text.includes('测试用的播放失败'), out.text);
  });

  await checkAsync('同一时间只放一段，后到的排队', async () => {
    const one = writeFile(join(scratch, 'one.wav'));
    const two = writeFile(join(scratch, 'two.wav'));
    let active = 0;
    let maxActive = 0;
    const order = [];
    const world = makeWorld({}, {
      play: async ({ path }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`start:${path.endsWith('one.wav') ? 'one' : 'two'}`);
        await new Promise((resolve) => setTimeout(resolve, 40));
        order.push(`end:${path.endsWith('one.wav') ? 'one' : 'two'}`);
        active -= 1;
        return { backend: 'fake' };
      },
    });
    const tool = world.tools()[0];
    const [a, b] = await Promise.all([
      tool.handler({ audio: one }, {}),
      tool.handler({ audio: two }, {}),
    ]);
    assert(!a.failed && !b.failed, `${a.text} / ${b.text}`);
    eq(maxActive, 1, '不该并发播放');
    eq(order.join(','), 'start:one,end:one,start:two,end:two', '顺序不对');
  });

  await checkAsync('中断信号会取消播放', async () => {
    const file = writeFile(join(scratch, 'cancel.wav'));
    const world = makeWorld({}, {
      play: ({ signal }) => new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(new player.PlaybackError('aborted', '播放被取消。'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(new player.PlaybackError('aborted', '播放被取消。'));
        }, { once: true });
      }),
    });
    const ac = new AbortController();
    const pending = world.tools()[0].handler({ audio: file }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    const out = await pending;
    assert(out.failed && out.text.includes('播放被取消'), out.text);
  });

  // -------------------------------------------------------------------------
  console.log('播放器平台分派');

  await checkAsync('不支持的平台直接失败，不启动进程', async () => {
    try {
      await player.playFile({ path: 'x.wav', platform: 'aix' });
      throw new Error('应当抛错');
    } catch (err) {
      assert(err instanceof player.PlaybackError, `不是 PlaybackError：${err?.name}`);
      eq(err.code, 'missing', '错误码');
      assert(err.message.includes('没有可用的播放后端'), err.message);
    }
  });
} catch (err) {
  bad(`未捕获的异常：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 项通过，${warned} 个提醒，${failed} 个失败`);
process.exit(failed === 0 ? 0 : 1);
