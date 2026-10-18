#!/usr/bin/env node
/**
 * 真放一声：造一段 0.6 秒的 WAV，走完 audio_play → 系统播放器 → 回执。
 * 会从本机扬声器出声；音量默认 30。跑法：
 *   node tools/smoke.mjs
 *   $env:SMOKE_HANDLE = "1"; node tools/smoke.mjs    # 走 log: 句柄
 *
 * 可调：SMOKE_SECONDS / SMOKE_VOLUME / SMOKE_FREQ。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import definition from '../src/definition.js';
import { AudioPlayWorld } from '../src/world.js';

const seconds = Math.min(Math.max(Number(process.env.SMOKE_SECONDS) || 0.6, 0.1), 5);
const volume = Math.min(Math.max(Number(process.env.SMOKE_VOLUME) || 30, 0), 100);
const freq = Math.min(Math.max(Number(process.env.SMOKE_FREQ) || 440, 80), 2000);
const useHandle = process.argv.includes('--handle') || process.env.SMOKE_HANDLE === '1';

/** 低音量 440 Hz 正弦波，16-bit 单声道 PCM；不联网、不依赖任何东西。 */
function sampleWav(seconds, freq, amplitude = 0.22) {
  const sampleRate = 24000;
  const total = Math.max(1, Math.round(sampleRate * seconds));
  const bytes = Buffer.alloc(44 + total * 2);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + total * 2, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(total * 2, 40);
  const fade = Math.max(1, Math.round(sampleRate * 0.02));
  for (let i = 0; i < total; i += 1) {
    const edge = Math.min(1, i / fade, (total - 1 - i) / fade);
    const value = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amplitude * edge;
    bytes.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return bytes;
}

const scratch = mkdtempSync(join(tmpdir(), 'audio-play-smoke-'));
const file = join(scratch, 'tone.wav');
const bytes = sampleWav(seconds, freq);
writeFileSync(file, bytes);

const host = {
  blob: (handle) => (handle === 'log:smoke.wav' ? { bytes, mime: 'audio/wav' } : null),
  log: { info: () => {}, warn: (message, data) => console.warn(`[warn] ${message}`, data ?? ''), child() { return this; } },
};

const world = new AudioPlayWorld({
  cfg: { ...definition.defaults(), enabled: true, volume },
  dataDir: join(scratch, 'data'),
  botDir: scratch,
});
await world.start(host);

try {
  const audio = useHandle ? 'log:smoke.wav' : file;
  console.log(`播放：${useHandle ? audio : file}（${seconds.toFixed(1)} 秒，音量 ${volume}）`);
  const started = Date.now();
  const out = await world.tools()[0].handler({ audio }, {});
  const elapsed = ((Date.now() - started) / 1000).toFixed(2);
  console.log(out.text);
  console.log(`用时：${elapsed} 秒`);
  if (out.failed) process.exitCode = 1;
} finally {
  await world.stop();
  rmSync(scratch, { recursive: true, force: true });
}
