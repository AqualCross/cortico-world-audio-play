/**
 * WorldDefinition：装配层在构造所有可用定义时也会跑 create()，
 * 所以构造函数必须是纯的（不建目录、不启动播放器）。
 */
import { existsSync } from 'node:fs';

import { DEFAULTS, ID, LABEL } from './config.js';
import { playScriptPath, supportedPlatform } from './player.js';
import { AUDIO_PLAY_FAILED_EVENT, AUDIO_PLAY_TOOL_DECLS, AudioPlayWorld } from './world.js';

/** 自描述里每个工具配一句给人看的话，按工具名。 */
const TOOL_SUMMARIES = {
  audio_play: {
    zh: '把一段音频（本地文件或 log:/mem: 句柄，比如 tts_speak 回执里的那个）交给本机扬声器，开始播放后立刻返回；失败会发 audio-play.failed 事件，成功不再回报。',
    en: 'Start playing an audio file or a log:/mem: handle (such as the one returned by tts_speak) through the local speakers and return at once; a failure arrives later as an audio-play.failed event, and success is silent.',
  },
  audio_watch: {
    zh: '打开或关闭事件音频的自动播放，更换监听的事件类型或播放后端，或查看当前设置；播放新事件里的音频附件。',
    en: 'Turn automatic playback of event audio on or off, change the watched event types or the playback backend, or read the current settings; plays audio attachments on new events.',
  },
};

/** 与框架 `describeTools()` 相同的拼法：取发给模型的字段，再加一句 summary。 */
function describeTools(decls) {
  return decls.map(({ name, description, parameters, tags }) => ({
    name,
    description,
    parameters,
    tags,
    summary: TOOL_SUMMARIES[name],
  }));
}

export const audioPlayDefinition = {
  id: ID,
  label: LABEL,
  /** `worlds.audio-play` 段的默认值；启用与否由部署决定，定义里恒为 false。 */
  defaults: () => structuredClone(DEFAULTS),
  preflight: (ctx) => {
    if (typeof AbortSignal?.any !== 'function') {
      throw new Error('音频播放需要 Node 22+ 的 AbortSignal.any');
    }
    if (!supportedPlatform()) {
      throw new Error(`音频播放不支持当前系统（${process.platform}）：Windows 用 WPF，macOS 用 afplay，Linux 用 ffplay / mpv / paplay / aplay。`);
    }
    const backend = String(ctx?.cfg?.backend ?? 'auto').trim().toLowerCase() || 'auto';
    if (process.platform === 'win32' && (backend === 'auto' || backend === 'wpf') && !existsSync(playScriptPath())) {
      throw new Error('音频播放缺少 src/play.ps1：重新安装扩展后再试。');
    }
  },
  create: (ctx) => new AudioPlayWorld({
    cfg: ctx.cfg,
    dataDir: ctx.dataDir,
    botDir: ctx.botDir,
    persist: typeof ctx.persist === 'function' ? (patch) => ctx.persist(patch) : undefined,
  }),
  /** 自描述：可能出现的全部工具与事件，不进提示词。`describe:extension` 把它导出成 describe.json。 */
  describe: {
    tools: describeTools(AUDIO_PLAY_TOOL_DECLS),
    events: [{
      type: AUDIO_PLAY_FAILED_EVENT,
      description: {
        zh: '播放失败：正文带音频来源、音量与原因，没有附件；手动播放和自动播放失败都会发，成功不发。',
        en: 'A failed playback: the text carries the audio reference, volume and reason, with no attachment; both manual and watched playback emit it, success is silent.',
      },
      trigger: 'debounce',
    }],
  },
};

export default audioPlayDefinition;
