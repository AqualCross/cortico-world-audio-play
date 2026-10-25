/**
 * 音频播放的配置段与文案。
 *
 * 段名是 `config.json` 的 `worlds.audio-play`。WebUI 热改就地写这个对象，
 * World 每次用时现读，所以这里只有默认值与 schema，不持有副本。
 */
import { AUDIO_PLAY_BACKENDS } from './player.js';

export const ID = 'audio-play';
export const LABEL = '音频播放';

/** `worlds.audio-play` 段的默认值；`enabled` 由框架的 World 开关管理，其余键与 configGroup 里的路径一一对应。 */
export const DEFAULTS = Object.freeze({
  enabled: false,
  volume: 80,
  timeoutMs: 120000,
  backend: 'auto',
  command: '',
  autoPlay: false,
  watchEvents: 'tts.voice',
});

/** `watchEvents` 的写法：逗号或空白分隔的事件类型。 */
export function watchTypes(value) {
  return [...new Set(String(value ?? '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean))];
}

const ZH = {
  label: '音频播放',
  badgeVolume: '音量',
  lamp: '播放后端',
  lampHint: (backend) => `本机扬声器 · ${backend}`,
  promptTitle: '提示词',
  panelQueueTitle: '队列',
  panelQueueDesc: '正在播放与排队中的音频；可跳过当前、移除排队项或清空队列。',
  config: {
    title: '音频播放',
    volume: '音量',
    volumeDesc: '0–100；工具参数 volume 可临时覆盖。',
    timeout: '超时',
    timeoutDesc: '单次播放的等待上限；超过就停掉播放器并报失败。',
    backend: '播放后端',
    backendDesc: 'auto 用当前平台的默认选择（Windows 系统播放器、macOS afplay、Linux 依次尝试 ffplay / mpv / paplay / aplay）；也可以指定 wpf（Windows 系统播放器）、ffplay、mpv、VLC、afplay、paplay、aplay，或用自定义命令。',
    command: '自定义命令',
    commandDesc: '后端为 custom 时执行；{file} 换成音频文件，{volume} 换成 0–100 的音量，例如 mpv --no-video --volume={volume} "{file}"。',
    autoPlay: '自动播放事件音频',
    autoPlayDesc: '监听事件库里的指定事件，把带音频附件的事件播放出来；只播打开之后的新事件，重启不补。桌宠也能用 audio_watch 开关。',
    watchEvents: '监听事件类型',
    watchEventsDesc: '逗号分隔的事件类型；默认 tts.voice（文本转语音的声音事件）。只挑带音频附件的事件。',
  },
};

const EN = {
  label: 'Audio Play',
  badgeVolume: 'Volume',
  lamp: 'Playback',
  lampHint: (backend) => `local speakers · ${backend}`,
  promptTitle: 'Prompt',
  panelQueueTitle: 'Queue',
  panelQueueDesc: 'Audio playing now and waiting in line; skip the current item, remove a waiting one, or clear the queue.',
  config: {
    title: 'Audio Play',
    volume: 'Volume',
    volumeDesc: '0–100; the volume tool argument overrides it for one call.',
    timeout: 'Timeout',
    timeoutDesc: 'How long one playback may take; past it the player is stopped and the call fails.',
    backend: 'Playback backend',
    backendDesc: 'auto uses the platform default (the Windows system player, afplay on macOS, or the first of ffplay / mpv / paplay / aplay on Linux). You can also pick wpf (the Windows system player), ffplay, mpv, VLC, afplay, paplay or aplay, or use a custom command.',
    command: 'Custom command',
    commandDesc: 'Run when the backend is custom. {file} becomes the audio file and {volume} the volume 0–100, for example mpv --no-video --volume={volume} "{file}".',
    autoPlay: 'Play event audio',
    autoPlayDesc: 'Watch the configured event types and play events that carry an audio attachment; only new events after this is enabled, nothing is replayed on restart. The pet can toggle it with audio_watch.',
    watchEvents: 'Event types',
    watchEventsDesc: 'Comma-separated event types; the default is tts.voice (the Text to Speech voice event). Only events with an audio attachment are played.',
  },
};

export function text(language = 'zh') {
  return language === 'en' ? EN : ZH;
}

/** WebUI 的配置组；路径必须落在 `worlds.audio-play.` 段内，且每个键都在 DEFAULTS 里有对应项（`enabled` 除外，它由框架的 World 开关渲染）。 */
export function configGroup(language = 'zh') {
  const t = text(language).config;
  const K = `worlds.${ID}`;
  return {
    id: `world:${ID}`,
    owner: `world:${ID}`,
    schema: {
      type: 'object',
      title: t.title,
      properties: {
        [`${K}.volume`]: {
          type: 'integer',
          title: t.volume,
          description: t.volumeDesc,
          minimum: 0,
          maximum: 100,
          'x-suffix': '%',
          'x-hot': true,
        },
        [`${K}.timeoutMs`]: {
          type: 'integer',
          title: t.timeout,
          description: t.timeoutDesc,
          minimum: 5000,
          maximum: 900000,
          multipleOf: 1000,
          'x-suffix': 'ms',
          'x-hot': true,
        },
        [`${K}.backend`]: {
          type: 'string',
          title: t.backend,
          description: t.backendDesc,
          enum: [...AUDIO_PLAY_BACKENDS],
          'x-hot': true,
        },
        [`${K}.command`]: { type: 'string', title: t.command, description: t.commandDesc, 'x-hot': true },
        [`${K}.autoPlay`]: { type: 'boolean', title: t.autoPlay, description: t.autoPlayDesc, 'x-hot': true },
        [`${K}.watchEvents`]: { type: 'string', title: t.watchEvents, description: t.watchEventsDesc, 'x-hot': true },
      },
    },
  };
}
