#!/usr/bin/env node
/**
 * 离线检查：不联网、不出声、不碰安装目录。跑法：node tools/check.mjs
 *
 * 覆盖：清单与声明 / 工具声明 / 配置组路径 / 路径与句柄解析 /
 * 临时文件清理 / 排队 / 非阻塞 / 取消 / 失败事件 / 自描述与 WebUI 形状。
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
  const persisted = [];
  const play = opts.play ?? (async () => ({ backend: 'fake' }));
  const dataDir = opts.dataDir ?? join(scratch, 'data');
  const botDir = opts.botDir ?? join(scratch, 'bot');
  const world = new AudioPlayWorld({
    cfg: { ...def.defaults(), enabled: true, ...overrides },
    dataDir,
    botDir,
    persist: (patch) => persisted.push(structuredClone(patch)),
    scanMs: opts.scanMs,
    playFile: async (one) => {
      calls.push(one);
      return play(one);
    },
  });
  world.__calls = calls;
  world.__persisted = persisted;
  return world;
}

function fakeHost(blobs = {}, events = []) {
  const all = [...events];
  const pushed = [];
  return {
    blob: (handle) => blobs[handle] ?? null,
    store: {
      latestCursor: () => (all.length ? all[all.length - 1].cursor : 0),
      range: ({ fromCursor = 0, limit = 20 } = {}) => all.filter((one) => one.cursor >= fromCursor).slice(0, limit),
    },
    log: { info: () => {}, warn: () => {}, child() { return this; } },
    pushed,
    pushEvent: async (event, opts) => {
      const saved = { ...event, cursor: (all.length ? all[all.length - 1].cursor : 0) + 1 };
      pushed.push({ event: saved, opts });
      all.push(saved);
      return saved;
    },
    add(event) {
      const full = { ...event, cursor: (all.length ? all[all.length - 1].cursor : 0) + 1 };
      all.push(full);
      return full;
    },
  };
}

/** Waits until `check` holds, or fails the check. */
async function until(check, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 15));
  }
  throw new Error('condition never held');
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
    assert(existsSync(join(pkgDir, 'src', 'ENV_PROMPT.md')), '缺提示词模板 src/ENV_PROMPT.md');
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
    eq(defaults.backend, 'auto', 'backend 默认');
    eq(defaults.command, '', 'command 默认');
    eq(defaults.autoPlay, false, 'autoPlay 默认');
    eq(defaults.watchEvents, 'tts.voice', 'watchEvents 默认');
    def.preflight(); // 当前平台满足时不抛
  });

  check('describe 与 describe.json 一致，实例工具都在声明里', () => {
    assert(def.describe && Array.isArray(def.describe.tools) && def.describe.tools.length === 2, '定义缺 describe.tools');
    assert(Array.isArray(def.describe.events), '定义缺 describe.events');
    const file = JSON.parse(readFileSync(join(pkgDir, 'describe.json'), 'utf8'));
    eq(stable(file), stable(JSON.parse(JSON.stringify(def.describe))), 'describe.json 与代码里的 describe 不一致');
    eq(file.tools[0].name, 'audio_play', 'describe 工具名');
    eq(file.events.length, 1, '失败事件应当在自描述里');
    eq(file.events[0].type, mod.AUDIO_PLAY_FAILED_EVENT, 'describe 事件名');
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

  check('空的提示词页，WebUI 只有配置、提示词与状态灯', () => {
    const world = makeWorld();
    const vars = world.envPromptVars();
    assert(vars && typeof vars === 'object' && Object.keys(vars).length === 0, 'envPromptVars 应为空对象');
    const decl = world.webUi('zh');
    assert(Array.isArray(decl.config) && decl.config.length === 1, '缺配置组');
    assert(!decl.panels || decl.panels.length === 0, '不该声明自定义面板');
    assert(Array.isArray(decl.lamps) && decl.lamps.length === 1, '缺状态灯');
    assert(Array.isArray(decl.badges) && decl.badges.length === 1, '缺徽标');
    assert(Array.isArray(decl.promptDocs) && decl.promptDocs.length === 1, '缺提示词页');
    const doc = decl.promptDocs[0];
    eq(doc.key, 'worlds.audio-play.env', '提示词 key');
    eq(doc.title, '提示词', '提示词页标题');
    eq(doc.role, 'envPrompt', '提示词角色');
    assert(existsSync(doc.path), `提示词模板不存在：${doc.path}`);
    eq(readFileSync(doc.path, 'utf8'), '', '提示词模板默认应为空');
  });

  // -------------------------------------------------------------------------
  console.log('World 与工具');

  check('audio_play 与 audio_watch，声明齐全', () => {
    const world = makeWorld();
    const tools = world.tools();
    eq(tools.length, 2, '工具数量');
    const tool = tools[0];
    eq(tool.name, 'audio_play', '工具名');
    assert(Array.isArray(tool.tags) && tool.tags.includes('act'), 'tags');
    eq(tool.interruptible, true, 'interruptible');
    eq(tool.parameters.required?.[0], 'audio', 'required[0]');
    assert(tool.parameters.properties?.audio, '缺 audio 参数');
    assert(tool.parameters.properties?.volume, '缺 volume 参数');
    const watch = tools[1];
    eq(watch.name, 'audio_watch', '监听工具名');
    eq(watch.parameters.required?.[0], 'action', 'watch required[0]');
    assert(watch.parameters.properties?.events, '缺 events 参数');
  });

  check('播放器工具函数与平台声明', () => {
    assert(typeof player.playFile === 'function', '缺 playFile');
    assert(player.supportedPlatform('win32') && player.supportedPlatform('darwin') && player.supportedPlatform('linux'), '支持的平台');
    assert(!player.supportedPlatform('aix'), '不支持的平台');
    if (process.platform === 'win32') assert(existsSync(player.playScriptPath()), 'play.ps1 不在');
  });

  check('播放后端清单与标签', () => {
    assert(Array.isArray(player.AUDIO_PLAY_BACKENDS), '缺后端清单');
    for (const id of ['auto', 'wpf', 'ffplay', 'mpv', 'vlc', 'custom']) {
      assert(player.AUDIO_PLAY_BACKENDS.includes(id), `后端清单缺 ${id}`);
    }
    eq(player.backendLabel('win32'), 'Windows WPF MediaPlayer', 'Windows 默认后端');
    eq(player.backendLabel('darwin'), 'afplay', 'macOS 默认后端');
    eq(player.backendLabel('win32', 'ffplay'), 'ffplay', '指定后端');
    eq(player.backendLabel('win32', 'custom'), '自定义命令', '自定义后端');
    eq(player.backendLabel('win32', 'nope'), '未知后端（nope）', '未知后端标签');
  });

  // -------------------------------------------------------------------------
  console.log('路径与句柄');

  await checkAsync('相对路径先按 workspace 找，立刻回执并在后台播放', async () => {
    const botDir = join(scratch, 'bot-relative');
    const workspace = join(botDir, 'workspace');
    const dataDir = join(scratch, 'data-relative');
    writeFile(join(workspace, 'hello.wav'), Buffer.from('hello-wav'));
    const world = makeWorld({ volume: 55 }, { botDir, dataDir });
    await world.start(fakeHost());
    const out = await world.tools()[0].handler({ audio: 'hello.wav' }, {});
    assert(!out.failed, `不该失败：${out.text}`);
    assert(out.text.includes('开始播放'), '回执应当说开始播放');
    assert(out.text.includes('失败会以事件通知'), '回执应当说明失败会发事件');
    await world.whenIdle();
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
    await world.whenIdle();
    eq(world.__calls.at(-1).path, file, '绝对路径');
    eq(world.__calls.at(-1).volume, 100, '音量上限');
    const two = await tool.handler({ audio: pathToFileURL(file).href, volume: -5 }, {});
    assert(!two.failed, two.text);
    await world.whenIdle();
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
    await world.whenIdle();
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
    await world.whenIdle();
    assert(temp.endsWith('.mp3'), `扩展名不对：${temp}`);
    assert(!existsSync(temp), '临时文件应当已删除');
    await world.stop();
  });

  await checkAsync('解析不了的句柄与找不到的文件发失败事件', async () => {
    const host = fakeHost();
    const world = makeWorld({}, { botDir: join(scratch, 'bot-missing') });
    await world.start(host);
    const handle = await world.tools()[0].handler({ audio: 'log:nope.wav' }, {});
    assert(!handle.failed, handle.text);
    const missing = await world.tools()[0].handler({ audio: 'nope.wav' }, {});
    assert(!missing.failed, missing.text);
    await world.whenIdle();
    eq(host.pushed.length, 2, '两条失败各发一个事件');
    for (const one of host.pushed) {
      eq(one.event.type, mod.AUDIO_PLAY_FAILED_EVENT, '事件名');
      eq(one.opts?.deliver, true, '失败事件投递给模型');
    }
    assert(host.pushed[0].event.text.includes('解析不出来'), host.pushed[0].event.text);
    assert(host.pushed[1].event.text.includes('找不到音频文件'), host.pushed[1].event.text);
    await world.stop();
  });

  // -------------------------------------------------------------------------
  console.log('事件监听');

  await checkAsync('audio_watch 开关与监听类型落盘', async () => {
    const world = makeWorld();
    const watch = world.tools()[1];
    const status = await watch.handler({ action: 'status' }, {});
    assert(status.text.includes('off') && status.text.includes('tts.voice'), status.text);
    const started = await watch.handler({ action: 'start', events: 'tts.voice, listen.chunk' }, {});
    assert(!started.failed, started.text);
    eq(world.cfg.autoPlay, true, 'autoPlay');
    eq(world.cfg.watchEvents, 'tts.voice, listen.chunk', 'watchEvents');
    eq(JSON.stringify(world.__persisted[0]), JSON.stringify({ autoPlay: true, watchEvents: 'tts.voice, listen.chunk' }), 'persist patch');
    const stopped = await watch.handler({ action: 'stop' }, {});
    assert(!stopped.failed, stopped.text);
    eq(world.cfg.autoPlay, false, 'stop');
    const set = await watch.handler({ action: 'set', events: 'tts.voice' }, {});
    assert(!set.failed, set.text);
    eq(world.cfg.watchEvents, 'tts.voice', 'set events');
    eq(world.cfg.autoPlay, false, 'set 不该打开自动播放');
    const missing = await watch.handler({ action: 'set' }, {});
    assert(missing.failed, 'set 不给任何设置应当失败');

    const backend = await watch.handler({ action: 'set', backend: 'ffplay' }, {});
    assert(!backend.failed, backend.text);
    eq(world.cfg.backend, 'ffplay', 'set backend');
    eq(JSON.stringify(world.__persisted.at(-1)), JSON.stringify({ backend: 'ffplay' }), 'backend persist');
    assert((await watch.handler({ action: 'status' }, {})).text.includes('ffplay'), 'status 显示后端');
    const badBackend = await watch.handler({ action: 'set', backend: 'nope' }, {});
    assert(badBackend.failed, '未知后端应当失败');
    const stopBackend = await watch.handler({ action: 'stop', backend: 'ffplay' }, {});
    assert(stopBackend.failed, 'stop 不该改后端');
  });

  await checkAsync('自动监听事件并播放音频；启动前的旧事件与非音频事件不播', async () => {
    const bytes = Buffer.from('watched-wav');
    const handle = 'log:watched.wav';
    const host = fakeHost({ [handle]: { bytes, mime: 'audio/wav' } }, [{
      cursor: 1,
      type: 'tts.voice',
      source: 'tts',
      blobs: [{ handle, mime: 'audio/wav' }],
    }]);
    const world = makeWorld({ autoPlay: true }, { scanMs: 15, dataDir: join(scratch, 'watch-data') });
    await world.start(host);
    await new Promise((done) => setTimeout(done, 50));
    eq(world.__calls.length, 0, '启动前的旧事件不该播');

    host.add({ type: 'tts.voice', source: 'tts', blobs: [{ handle, mime: 'audio/wav' }] });
    host.add({ type: 'other.audio', source: 'other', blobs: [{ handle, mime: 'audio/wav' }] });
    host.add({ type: 'tts.voice', source: 'tts' });
    await until(() => world.__calls.length >= 1);
    await world.whenIdle();
    await new Promise((done) => setTimeout(done, 30));
    eq(world.__calls.length, 1, '只播匹配且有音频的一条');
    assert(world.__calls[0].path.endsWith('.wav'), `临时文件扩展名不对：${world.__calls[0].path}`);
    assert(!existsSync(world.__calls[0].path), '临时文件应当已删除');
    eq(world.__calls[0].volume, 80, '配置音量');
    eq(host.pushed.length, 0, '成功不该发事件');
    await world.stop();
  });

  await checkAsync('打开监听只播之后的新事件，stop 后不再播', async () => {
    const file = writeFile(join(scratch, 'watched-path.wav'));
    const host = fakeHost();
    const world = makeWorld({ autoPlay: false }, { scanMs: 15, dataDir: join(scratch, 'watch-data-2') });
    await world.start(host);
    host.add({ type: 'tts.voice', source: 'tts', meta: { path: file } });
    await new Promise((done) => setTimeout(done, 50));
    eq(world.__calls.length, 0, '关着自动播放时不该播');

    await world.tools()[1].handler({ action: 'start' }, {});
    host.add({ type: 'tts.voice', source: 'tts', meta: { path: file } });
    await until(() => world.__calls.length >= 1);
    await world.whenIdle();
    eq(world.__calls[0].path, file, '按事件里的路径播放');
    eq(host.pushed.length, 0, '成功不该发事件');

    await world.tools()[1].handler({ action: 'stop' }, {});
    host.add({ type: 'tts.voice', source: 'tts', meta: { path: file } });
    await new Promise((done) => setTimeout(done, 60));
    eq(world.__calls.length, 1, 'stop 之后不该再播');
    await world.stop();
  });

  await checkAsync('自动播放失败发失败事件；成功不发', async () => {
    const file = writeFile(join(scratch, 'watch-fail.wav'));
    const host = fakeHost();
    const world = makeWorld({ autoPlay: true }, {
      scanMs: 15,
      dataDir: join(scratch, 'watch-fail-data'),
      play: async () => {
        throw new player.PlaybackError('failed', '自动播放测试失败。');
      },
    });
    await world.start(host);
    host.add({ type: 'tts.voice', source: 'tts', meta: { path: file } });
    await until(() => host.pushed.length >= 1);
    await world.whenIdle();
    eq(host.pushed.length, 1, '一次失败发一个事件');
    const failed = host.pushed[0].event;
    eq(failed.type, mod.AUDIO_PLAY_FAILED_EVENT, '事件名');
    assert(failed.text.includes('自动播放失败'), failed.text);
    assert(failed.text.includes('自动播放测试失败'), failed.text);
    assert(failed.text.includes('tts.voice'), failed.text);
    eq(host.pushed[0].opts?.deliver, true, '失败事件投递给模型');
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

  await checkAsync('audio_play 不等播放结束就返回', async () => {
    const file = writeFile(join(scratch, 'slow.wav'));
    let release = null;
    const world = makeWorld({}, {
      play: () => new Promise((resolve) => {
        release = () => resolve({ backend: 'fake' });
      }),
    });
    const out = await world.tools()[0].handler({ audio: file }, {});
    assert(!out.failed, out.text);
    await until(() => typeof release === 'function');
    assert(release, '后台播放应当已经开始并卡住');
    release();
    await world.whenIdle();
  });

  await checkAsync('播放器失败不回失败回执，而是推失败事件', async () => {
    const file = writeFile(join(scratch, 'fail.wav'));
    const host = fakeHost();
    const world = makeWorld({}, {
      play: async () => {
        throw new player.PlaybackError('failed', '测试用的播放失败。');
      },
    });
    await world.start(host);
    const out = await world.tools()[0].handler({ audio: file }, {});
    assert(!out.failed, out.text);
    await world.whenIdle();
    eq(host.pushed.length, 1, '失败事件数量');
    const failed = host.pushed[0].event;
    eq(failed.type, mod.AUDIO_PLAY_FAILED_EVENT, '事件名');
    assert(failed.text.includes('测试用的播放失败'), failed.text);
    assert(failed.text.includes('fail.wav'), failed.text);
    await world.stop();
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
    assert(a.text.includes('开始播放'), a.text);
    assert(b.text.includes('已排队'), b.text);
    await world.whenIdle();
    eq(maxActive, 1, '不该并发播放');
    eq(order.join(','), 'start:one,end:one,start:two,end:two', '顺序不对');
  });

  await checkAsync('中断信号会取消后台播放，取消不算失败事件', async () => {
    const file = writeFile(join(scratch, 'cancel.wav'));
    const host = fakeHost();
    let started = false;
    let aborted = false;
    const world = makeWorld({}, {
      play: ({ signal }) => new Promise((resolve, reject) => {
        started = true;
        if (signal.aborted) {
          aborted = true;
          reject(new player.PlaybackError('aborted', '播放被取消。'));
          return;
        }
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new player.PlaybackError('aborted', '播放被取消。'));
        }, { once: true });
      }),
    });
    await world.start(host);
    const ac = new AbortController();
    const out = await world.tools()[0].handler({ audio: file }, { signal: ac.signal });
    assert(!out.failed, out.text);
    await until(() => started);
    ac.abort();
    await world.whenIdle();
    assert(aborted, '后台播放应当收到取消');
    eq(host.pushed.length, 0, '取消不该发失败事件');
    await world.stop();
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

  await checkAsync('未知后端与平台不符的后端直接失败，不启动进程', async () => {
    try {
      await player.playFile({ path: 'x.wav', backend: 'nope' });
      throw new Error('应当抛错');
    } catch (err) {
      assert(err instanceof player.PlaybackError, `不是 PlaybackError：${err?.name}`);
      assert(err.message.includes('未知的播放后端'), err.message);
    }
    try {
      await player.playFile({ path: 'x.wav', platform: 'linux', backend: 'wpf' });
      throw new Error('应当抛错');
    } catch (err) {
      assert(err instanceof player.PlaybackError, `不是 PlaybackError：${err?.name}`);
      assert(err.message.includes('只适用于 Windows'), err.message);
    }
  });

  await checkAsync('custom 后端按 command 模板执行并替换占位符', async () => {
    const file = writeFile(join(scratch, 'custom.wav'));
    const command = `"${process.execPath}" -e process.exit(process.argv[2]==String(42)?0:1) "{file}" {volume}`;
    const out = await player.playFile({
      path: file,
      backend: 'custom',
      command,
      volume: 42,
      timeoutMs: 1000,
    });
    eq(out.backend, 'custom', 'custom 后端');
  });

  await checkAsync('custom 后端缺 command 或缺 {file} 时给出明确失败', async () => {
    const file = writeFile(join(scratch, 'custom-missing.wav'));
    for (const [command, expected] of [
      ['', 'command 是空的'],
      [`"${process.execPath}" -e process.exit(0)`, '{file}'],
    ]) {
      try {
        await player.playFile({ path: file, backend: 'custom', command, timeoutMs: 1000 });
        throw new Error('应当抛错');
      } catch (err) {
        assert(err instanceof player.PlaybackError, `不是 PlaybackError：${err?.name}`);
        assert(err.message.includes(expected), err.message);
      }
    }
  });
} catch (err) {
  bad(`未捕获的异常：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 项通过，${warned} 个提醒，${failed} 个失败`);
process.exit(failed === 0 ? 0 : 1);
