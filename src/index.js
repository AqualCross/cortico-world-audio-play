/**
 * 扩展入口：默认导出必须是 WorldDefinition。
 * `cortico.kind = world`、`api = 6` 与 `keywords` 里的 `cortico-world` 见 package.json。
 */
import definition, { audioPlayDefinition } from './definition.js';

export default definition;
export { audioPlayDefinition };
export { AUDIO_PLAY_FAILED_EVENT, AudioPlayWorld } from './world.js';
export { ID as AUDIO_PLAY_WORLD_ID, DEFAULTS as AUDIO_PLAY_DEFAULTS } from './config.js';
export { AUDIO_PLAY_BACKENDS, PlaybackError, backendLabel, playFile, supportedPlatform } from './player.js';
