/**
 * 音频播放的配置段与文案。
 *
 * 段名是 `config.json` 的 `worlds.audio-play`。WebUI 热改就地写这个对象，
 * World 每次用时现读，所以这里只有默认值与 schema，不持有副本。
 */

export const ID = 'audio-play';
export const LABEL = '音频播放';

/** `worlds.audio-play` 段的默认值；`enabled` 由框架的 World 开关管理，其余键与 configGroup 里的路径一一对应。 */
export const DEFAULTS = Object.freeze({
  enabled: false,
  volume: 80,
  timeoutMs: 120000,
});

const ZH = {
  label: '音频播放',
  badgeVolume: '音量',
  lamp: '播放后端',
  lampHint: (backend) => `本机扬声器 · ${backend}`,
  config: {
    title: '音频播放',
    volume: '音量',
    volumeDesc: '0–100；工具参数 volume 可临时覆盖。',
    timeout: '超时',
    timeoutDesc: '单次播放的等待上限；超过就停掉播放器并报失败。',
  },
};

const EN = {
  label: 'Audio Play',
  badgeVolume: 'Volume',
  lamp: 'Playback',
  lampHint: (backend) => `local speakers · ${backend}`,
  config: {
    title: 'Audio Play',
    volume: 'Volume',
    volumeDesc: '0–100; the volume tool argument overrides it for one call.',
    timeout: 'Timeout',
    timeoutDesc: 'How long one playback may take; past it the player is stopped and the call fails.',
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
      },
    },
  };
}
