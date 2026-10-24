/**
 * 音频播放 World。
 *
 * 只做一件事：把工具参数里的音频（本地路径，或 log:/mem: 句柄）交给本机播放器，
 * 开始播放后立刻返回；失败发事件，成功不回报。这里不合成、不发送、也不保存音频。
 *
 * 句柄来自对话附件或工作区，Core 已经会解析；需要文件路径才能交给播放器，
 * 所以句柄会先落成临时文件，播放结束就删掉。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULTS, ID, configGroup, text, watchTypes } from './config.js';
import {
  AUDIO_PLAY_BACKENDS,
  PlaybackError,
  backendLabel,
  playFile,
  supportedPlatform,
} from './player.js';

const msg = (err) => (err instanceof Error ? err.message : String(err));
const asText = (value) => (typeof value === 'string' ? value.trim() : '');

/** MIME → 临时文件扩展名；句柄名里的扩展名优先。 */
const EXT_BY_MIME = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'audio/webm': 'webm',
  'audio/x-ms-wma': 'wma',
};

/** 只允许这些扩展名落到临时文件；句柄名不可信，别把 .exe / .ps1 写出来。 */
const AUDIO_EXT = new Set([
  'wav', 'mp3', 'ogg', 'opus', 'aac', 'm4a', 'flac', 'webm', 'wma',
  'aif', 'aiff', 'caf', 'amr', 'pcm',
]);

const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ENV_PROMPT = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 播放失败事件；成功不发事件。 */
export const AUDIO_PLAY_FAILED_EVENT = 'audio-play.failed';

/** 自动播放连续失败时，失败事件至少隔这么久再发一次，避免事件潮。 */
const AUTO_FAILURE_EVENT_MS = 30000;

/** 全部工具的声明（不含 handler）；定义里的 describe 与 `tools()` 都取它。 */
export const AUDIO_PLAY_TOOL_DECLS = [
  {
    name: 'audio_play',
    tags: ['act'],
    interruptible: true,
    description: 'Start playing an audio file through the local speakers and return at once. The audio comes from a local file path or a log:/mem: handle, such as the path or handle returned by tts_speak. It only plays sound; it does not send anything. A playback failure arrives later as an audio-play.failed event.',
    parameters: {
      type: 'object',
      properties: {
        audio: { type: 'string', description: 'Audio file path (absolute, or relative to the bot workspace) or a log:/mem: handle, e.g. the path or log: handle returned by tts_speak.' },
        volume: { type: 'integer', minimum: 0, maximum: 100, description: 'Playback volume 0–100 for this call; omit to use the configured volume.' },
      },
      required: ['audio'],
    },
  },
  {
    name: 'audio_watch',
    tags: ['act'],
    description: 'Read or change playback settings. start turns on automatic playback of event audio for the configured event types (tts.voice by default) and plays new events that carry an audio attachment; stop turns it off; set changes the watched event types and/or the playback backend without changing whether watching is on; status shows the settings and last playback. Every change is saved to the config. Playback failures arrive as audio-play.failed events; success is silent.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'set', 'status'], description: 'start = watch new events and play their audio; stop = stop watching; set = change the watched types and/or the playback backend; status = show the current settings.' },
        events: { type: 'string', description: 'For start and set: comma-separated event types to watch, e.g. tts.voice. For start it defaults to the configured list.' },
        backend: { type: 'string', enum: [...AUDIO_PLAY_BACKENDS], description: 'For start and set: the playback backend. auto = platform default; wpf = Windows system player; ffplay, mpv, vlc, afplay, paplay, aplay = that command; custom = the command configured in the settings.' },
      },
      required: ['action'],
    },
  },
];

function extensionOf(name, mime) {
  const fromName = extname(String(name ?? '')).replace(/^\./, '').toLowerCase();
  if (AUDIO_EXT.has(fromName)) return fromName;
  return EXT_BY_MIME[String(mime ?? '').toLowerCase()] ?? 'bin';
}

export class AudioPlayWorld {
  #host = null;
  #active = new Set();
  #tail = Promise.resolve();
  #queued = 0;
  #busy = 0;
  #stopped = false;
  #lastAutoFailureAt = 0;
  #lastError = '';
  #lastPlayedAt = '';
  #persist = null;
  #scanMs;
  #timer = null;
  #watchCursor = 0;
  #lastWatched = '';

  constructor(opts = {}) {
    this.id = ID;
    this.cfg = opts.cfg ?? { ...DEFAULTS };
    this.dataDir = opts.dataDir ?? process.cwd();
    this.botDir = opts.botDir ?? process.cwd();
    this.language = 'zh';
    this.playFile = typeof opts.playFile === 'function' ? opts.playFile : playFile;
    this.#persist = typeof opts.persist === 'function' ? opts.persist : null;
    this.#scanMs = Number.isFinite(Number(opts.scanMs)) && Number(opts.scanMs) >= 10 ? Number(opts.scanMs) : 1000;
  }

  // -------------------------------------------------------------------------
  // 配置：config.json 的段被 WebUI 热改，每次用时现读
  // -------------------------------------------------------------------------

  #raw(key) {
    const value = this.cfg?.[key];
    return value === undefined || value === null ? DEFAULTS[key] : value;
  }

  #num(key, min, max) {
    const n = Number(this.#raw(key));
    if (!Number.isFinite(n)) return Number(DEFAULTS[key]) || min;
    return Math.min(Math.max(n, min), max);
  }

  #bool(key) {
    const value = this.#raw(key);
    return typeof value === 'boolean' ? value : Boolean(DEFAULTS[key]);
  }

  #volume(args) {
    if (!args || args.volume === undefined || args.volume === null || args.volume === '') {
      return Math.round(this.#num('volume', 0, 100));
    }
    const n = Number(args.volume);
    if (!Number.isFinite(n)) return Math.round(this.#num('volume', 0, 100));
    return Math.min(Math.max(Math.round(n), 0), 100);
  }

  #timeout() {
    return Math.round(this.#num('timeoutMs', 5000, 900000));
  }

  #backend() {
    return String(this.#raw('backend') ?? 'auto').trim().toLowerCase() || 'auto';
  }

  #command() {
    return asText(this.#raw('command'));
  }

  #backendSays() {
    return backendLabel(process.platform, this.#backend());
  }

  #text() {
    return text(this.language);
  }

  /** 句柄临时文件的目录：<dataDir>/audio-play/tmp。 */
  tempDir() {
    return join(this.dataDir, 'audio-play', 'tmp');
  }

  // -------------------------------------------------------------------------
  // 提示词
  // -------------------------------------------------------------------------

  /** 提示词模板默认是空的；工具自身的描述就够了，部署者可以在提示词页补充。 */
  envPromptVars() {
    return {};
  }

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  tools() {
    return [
      { ...AUDIO_PLAY_TOOL_DECLS[0], handler: (args, ctx) => this.#play(args ?? {}, ctx) },
      { ...AUDIO_PLAY_TOOL_DECLS[1], handler: async (args) => this.#watchAction(args ?? {}) },
    ];
  }

  /** 当前要监听的事件类型；空集合表示不播。 */
  #watchTypes() {
    return new Set(watchTypes(this.#raw('watchEvents')));
  }

  #watchSays() {
    const types = watchTypes(this.#raw('watchEvents'));
    const auto = this.#bool('autoPlay') ? 'on' : 'off';
    const bits = [`自动播放：${auto}`, `监听：${types.join(', ') || '（空）'}`, `后端：${this.#backendSays()}`];
    if (this.#backend() === 'custom') bits.push(`命令：${this.#command() || '（未配置）'}`);
    if (this.#busy) bits.push(`在途 ${this.#busy}`);
    if (this.#lastWatched) bits.push(`上次：${this.#lastWatched}`);
    return bits.join(' · ');
  }

  /** 改监听相关配置；写盘失败只回报，不改内存。 */
  #applyConfig(patch) {
    try {
      this.#persist?.(patch);
    } catch (err) {
      return `配置没写进去：${msg(err)}`;
    }
    for (const [key, value] of Object.entries(patch)) this.cfg[key] = value;
    return '';
  }

  #watchAction(args) {
    const action = asText(args.action) || 'status';
    if (action === 'status') return { text: this.#watchSays() };
    if (action !== 'start' && action !== 'stop' && action !== 'set') {
      return { text: '[audio_watch 没执行] action 只能是 start、stop、set 或 status。', failed: true };
    }
    if (action === 'stop' && args.backend !== undefined) {
      return { text: '[audio_watch 没执行] stop 只停止监听；换播放后端用 set。', failed: true };
    }
    const patch = action === 'set' ? {} : { autoPlay: action === 'start' };
    if (action !== 'stop' && args.events !== undefined) {
      const types = watchTypes(args.events);
      if (!types.length) return { text: '[audio_watch 没执行] events 至少要有一个事件类型。', failed: true };
      patch.watchEvents = types.join(', ');
    }
    if (action !== 'stop' && args.backend !== undefined) {
      const backend = asText(args.backend).toLowerCase();
      if (!AUDIO_PLAY_BACKENDS.includes(backend)) {
        return { text: `[audio_watch 没执行] backend 只能是 ${AUDIO_PLAY_BACKENDS.join(' / ')}。`, failed: true };
      }
      patch.backend = backend;
    }
    if (action === 'set' && Object.keys(patch).length === 0) {
      return { text: '[audio_watch 没执行] set 需要给 events 或 backend。', failed: true };
    }
    const error = this.#applyConfig(patch);
    if (error) return { text: `[audio_watch 失败] ${error}`, failed: true };
    // 换后端或重新打开监听后，下一次失败应当重新通知。
    if (patch.autoPlay === true || 'backend' in patch) this.#lastAutoFailureAt = 0;
    // 打开、关上或换监听列表都不补播旧事件：游标从现在开始。
    if ('autoPlay' in patch || 'watchEvents' in patch) {
      this.#watchCursor = this.#host?.store?.latestCursor?.() ?? this.#watchCursor;
    }
    const verb = action === 'start' ? '开始监听' : action === 'stop' ? '停止监听' : '已更新设置';
    return { text: `${verb}；${this.#watchSays()}` };
  }

  /** 扫一遍事件库；关着自动播放时只把游标推到最新。 */
  #scanWatched() {
    const host = this.#host;
    if (!host) return;
    try {
      if (!this.#bool('autoPlay')) {
        this.#watchCursor = host.store.latestCursor();
        return;
      }
      const types = this.#watchTypes();
      if (!types.size) {
        this.#watchCursor = host.store.latestCursor();
        return;
      }
      const events = host.store.range({ fromCursor: this.#watchCursor + 1, limit: 20 });
      for (const event of events) {
        this.#watchCursor = Math.max(this.#watchCursor, event.cursor);
        if (!types.has(event.type)) continue;
        const ref = this.#audioRefOf(event);
        if (!ref) continue;
        void this.#enqueue(() => this.#playWatched(event, ref))
          .catch((err) => this.#host?.log?.warn?.('自动播放：后台任务异常', { err: msg(err) }));
      }
    } catch (err) {
      this.#lastError = `${new Date().toISOString()} 读事件失败：${msg(err)}`;
    }
  }

  /** 事件里的音频：优先取音频附件句柄，其次取正文里写的路径。 */
  #audioRefOf(event) {
    const blobs = Array.isArray(event.blobs) ? event.blobs : [];
    const blob = blobs.find((one) => one
      && (/^audio\//i.test(String(one.mime ?? '')) || AUDIO_EXT.has(extensionOf(one.name, one.mime))));
    if (blob?.handle) return { ref: blob.handle, temp: true };
    const path = typeof event.meta?.path === 'string' ? event.meta.path.trim() : '';
    if (path) return { ref: path, temp: false };
    return null;
  }

  async #playWatched(event, ref) {
    // 排队期间关掉监听、或 World 停了：这条不再播。
    if (this.#stopped || !this.#bool('autoPlay')) return;
    const volume = this.#volume({});
    let audio;
    try {
      audio = this.#resolveAudio(ref.ref);
    } catch (err) {
      const fallback = ref.temp && typeof event.meta?.path === 'string' ? event.meta.path.trim() : '';
      if (fallback) {
        try {
          audio = this.#resolveAudio(fallback);
        } catch {
          audio = null;
        }
      }
      if (!audio) {
        await this.#reportFailure(err, { origin: 'event', ref: ref.ref, type: event.type, volume });
        return;
      }
    }
    if (this.#stopped || !this.#bool('autoPlay')) {
      if (audio.temp) this.#removeTemp(audio.path);
      return;
    }
    const own = new AbortController();
    this.#active.add(own);
    this.#busy += 1;
    try {
      await this.playFile({
        path: audio.path,
        volume,
        timeoutMs: this.#timeout(),
        backend: this.#backend(),
        command: this.#command(),
        signal: own.signal,
      });
      this.#lastPlayedAt = new Date().toISOString();
      this.#lastWatched = event.type;
    } catch (err) {
      await this.#reportFailure(err, { origin: 'event', ref: ref.ref, type: event.type, volume });
    } finally {
      this.#busy -= 1;
      this.#active.delete(own);
      if (audio.temp) this.#removeTemp(audio.path);
    }
  }

  /** 同一时间只放一段；后到的调用排队，避免两段声音叠在一起。 */
  #enqueue(task) {
    this.#queued += 1;
    const run = () => {
      this.#queued -= 1;
      return task();
    };
    const result = this.#tail.then(run, run);
    this.#tail = result.then(() => {}, () => {});
    return result;
  }

  /** 等当前队列（正在播放和排队中）全部结束；自检与 smoke 用。 */
  whenIdle() {
    return this.#tail;
  }

  #play(args, ctx) {
    if (this.#stopped) {
      return { text: '[audio_play 没执行] 音频播放已停止；等 World 重新启用后再试。', failed: true };
    }
    const raw = asText(args.audio);
    if (!raw) {
      return {
        text: '[audio_play 没执行] audio 是空的。给一个音频文件路径或 log:/mem: 句柄；不想播放就别调用。',
        failed: true,
      };
    }

    const volume = this.#volume(args);
    const timeoutMs = this.#timeout();
    const own = new AbortController();
    this.#active.add(own);
    const signal = ctx?.signal ? AbortSignal.any([ctx.signal, own.signal]) : own.signal;
    void this.#enqueue(() => this.#runPlay({ raw, volume, timeoutMs, signal, own }))
      .catch((err) => this.#host?.log?.warn?.('音频播放：后台任务异常', { err: msg(err) }));

    const behind = Math.max(0, this.#busy + this.#queued - 1);
    const shown = /^(log|mem|file):/i.test(raw) ? raw : basename(raw);
    const head = behind > 0 ? `已排队（前面还有 ${behind} 条）` : '开始播放';
    return { text: `${head}：${shown}（音量 ${volume}）；放完不再回报，失败会以事件通知。` };
  }

  /** 后台播放：解析音频、等播放器结束、清临时文件；失败推事件。 */
  async #runPlay({ raw, volume, timeoutMs, signal, own }) {
    if (this.#stopped || signal.aborted) {
      this.#active.delete(own);
      return;
    }
    let audio = null;
    this.#busy += 1;
    try {
      audio = this.#resolveAudio(raw);
      await this.playFile({
        path: audio.path,
        volume,
        timeoutMs,
        backend: this.#backend(),
        command: this.#command(),
        signal,
      });
      this.#lastPlayedAt = new Date().toISOString();
    } catch (err) {
      await this.#reportFailure(err, { origin: 'manual', ref: raw, volume });
    } finally {
      this.#busy -= 1;
      this.#active.delete(own);
      if (audio?.temp) this.#removeTemp(audio.path);
    }
  }

  /**
   * 失败记进状态和日志；非取消、非停机的失败再推一条 audio-play.failed 事件。
   * 自动播放的失败事件有冷却，避免一个坏后端把事件库刷满。
   */
  async #reportFailure(err, info) {
    // 停机和取消不是播放失败：不记错误、不发事件。
    if (this.#stopped) return;
    if (err instanceof PlaybackError && err.code === 'aborted') return;
    const detail = err instanceof PlaybackError ? err.message : msg(err);
    this.#lastError = `${new Date().toISOString()} ${detail}`;
    this.#host?.log?.warn?.('音频播放失败', {
      err: detail,
      origin: info.origin,
      ref: info.ref,
      type: info.type,
    });
    if (info.origin === 'event') {
      if (!this.#bool('autoPlay')) return;
      const now = Date.now();
      if (now - this.#lastAutoFailureAt < AUTO_FAILURE_EVENT_MS) return;
      this.#lastAutoFailureAt = now;
    }
    await this.#pushFailure(detail, info);
  }

  async #pushFailure(detail, info) {
    const host = this.#host;
    if (!host?.pushEvent) return;
    const label = info.origin === 'event' ? '自动播放失败' : '播放失败';
    const bits = [`音量 ${info.volume}`];
    if (info.ref) bits.unshift(`音频：${info.ref}`);
    if (info.type) bits.push(`事件：${info.type}`);
    try {
      await host.pushEvent({
        type: AUDIO_PLAY_FAILED_EVENT,
        source: this.id,
        ts: new Date().toISOString(),
        text: `${label}：${detail}\n${bits.join(' · ')}`,
        meta: {
          origin: info.origin,
          ref: info.ref ?? '',
          type: info.type ?? '',
          volume: info.volume,
          backend: this.#backend(),
        },
      }, { deliver: true, trigger: 'debounce' });
    } catch (err) {
      host.log?.warn?.('音频播放：失败事件没送出去', { err: msg(err) });
    }
  }

  /**
   * 把工具参数里的一句引用解成音频文件：
   * `log:`/`mem:` 句柄问宿主并落成临时文件；否则当路径（绝对 / workspace / bot 目录 / 插件数据目录）。
   */
  #resolveAudio(ref) {
    const raw = asText(ref).replace(/^["']|["']$/g, '');
    if (!raw) throw new Error('audio 是空的：给一个音频文件路径，或 log:/mem: 句柄。');

    if (/^(log|mem):/i.test(raw)) {
      let blob = null;
      try {
        blob = this.#host?.blob?.(raw) ?? null;
      } catch {
        blob = null;
      }
      if (!blob) {
        throw new Error(`句柄 ${raw} 解析不出来：log: 句柄来自对话里的附件，mem: 句柄来自工作区；也可以直接给文件路径。`);
      }
      const bytes = Buffer.isBuffer(blob.bytes) ? blob.bytes : Buffer.from(blob.bytes ?? []);
      if (!bytes.length) throw new Error(`句柄 ${raw} 里没有内容。`);
      const base = raw.split(/[/\\]/).pop() ?? raw;
      const name = (base.split(':').pop() || 'audio').trim();
      const path = this.#writeTemp(bytes, extensionOf(name, blob.mime));
      return {
        path,
        name,
        ref: raw,
        kind: 'handle',
        temp: true,
        bytes: bytes.length,
      };
    }

    let wanted = raw;
    if (/^file:/i.test(wanted)) {
      try {
        wanted = fileURLToPath(wanted);
      } catch {
        throw new Error(`不是有效的文件地址：${raw}`);
      }
    }
    const candidates = isAbsolute(wanted)
      ? [wanted]
      : [
          resolve(this.botDir, 'workspace', wanted),
          resolve(this.botDir, wanted),
          resolve(this.dataDir, wanted),
        ];
    for (const candidate of candidates) {
      try {
        const stat = statSync(candidate);
        if (!stat.isFile()) continue;
        return {
          path: candidate,
          name: basename(candidate),
          ref: candidate,
          kind: 'file',
          temp: false,
          bytes: stat.size,
        };
      } catch {
        // 下一个候选
      }
    }
    throw new Error(`找不到音频文件：${raw}（相对路径先按 bot 目录的 workspace/、再按 bot 目录、最后按插件数据目录找）`);
  }

  #writeTemp(bytes, ext) {
    const dir = this.tempDir();
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      throw new Error(`建不了临时目录：${msg(err)}`);
    }
    const safeExt = String(ext ?? 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
    const file = join(dir, `play-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.${safeExt}`);
    try {
      writeFileSync(file, bytes, { flag: 'wx' });
    } catch (err) {
      throw new Error(`句柄内容写不进临时文件：${msg(err)}`);
    }
    return file;
  }

  #removeTemp(path) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* 删不掉就留给下次启动清理。 */
    }
  }

  /** 清掉上次进程崩溃留下的旧临时文件；只动自己命名的那批。 */
  #cleanTemp() {
    const dir = this.tempDir();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('play-')) continue;
      const path = join(dir, entry.name);
      try {
        if (now - statSync(path).mtimeMs > TEMP_MAX_AGE_MS) rmSync(path, { force: true });
      } catch {
        /* 被别的进程占着就算了。 */
      }
    }
  }

  #state() {
    return {
      language: this.language,
      node: process.version,
      platform: process.platform,
      backend: this.#backendSays(),
      backendId: this.#backend(),
      command: this.#command(),
      supported: supportedPlatform(process.platform),
      tempDir: this.tempDir(),
      busy: this.#busy > 0,
      queued: this.#queued,
      volume: Math.round(this.#num('volume', 0, 100)),
      timeoutMs: this.#timeout(),
      lastError: this.#lastError,
      lastPlayedAt: this.#lastPlayedAt,
      lastWatched: this.#lastWatched,
      autoPlay: this.#bool('autoPlay'),
      watchEvents: watchTypes(this.#raw('watchEvents')).join(', '),
    };
  }

  // -------------------------------------------------------------------------
  // WebUI：只有配置组与状态灯，没有自定义面板
  // -------------------------------------------------------------------------

  webUi(language = 'zh') {
    this.language = language === 'en' ? 'en' : 'zh';
    const t = this.#text();
    const state = this.#state();
    return {
      label: t.label,
      lamps: [{
        label: t.lamp,
        state: state.supported ? 'online' : 'error',
        hint: t.lampHint(state.backend),
      }],
      badges: [{
        label: t.badgeVolume,
        value: `${state.volume}%`,
        tone: state.volume > 0 ? 'on' : 'off',
      }],
      config: [configGroup(this.language)],
      promptDocs: [{
        key: `worlds.${ID}.env`,
        title: t.promptTitle,
        path: ENV_PROMPT,
        role: 'envPrompt',
      }],
    };
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  async start(host) {
    this.#host = host;
    this.#stopped = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#watchCursor = host.store.latestCursor();
    this.#timer = setInterval(() => this.#scanWatched(), this.#scanMs);
    this.#timer.unref?.();
    try {
      mkdirSync(this.tempDir(), { recursive: true });
      this.#cleanTemp();
    } catch (err) {
      host?.log?.warn?.('音频播放：临时目录建不出来', { err: msg(err) });
    }
    host?.log?.info?.('音频播放已就绪', {
      backend: this.#backend(),
      backendLabel: this.#backendSays(),
      command: this.#command(),
      volume: this.#volume({}),
      tempDir: this.tempDir(),
      autoPlay: this.#bool('autoPlay'),
      watchEvents: watchTypes(this.#raw('watchEvents')).join(', '),
    });
  }

  async stop() {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    for (const own of this.#active) own.abort();
    this.#active.clear();
    // 让排队中的任务跑完（它们看到 stopped 就直接返回），顺带清掉临时文件。
    await this.#tail;
    this.#host = null;
  }
}
