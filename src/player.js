/**
 * 本机扬声器播放：把一个音频文件交给系统播放器，等它放完。
 *
 * 这里只认文件，不认句柄，也不合成音频。句柄由 World 先落成临时文件再交进来。
 * 没有 npm 依赖：
 * - Windows：`play.ps1` + WPF MediaPlayer（`powershell.exe`，系统自带）；
 * - macOS：`afplay`；
 * - Linux：`ffplay` / `mpv` / `paplay` / `aplay` 里第一个能用的。
 *
 * 播放器进程退出 0 = 放完了；其余退出码、超时和取消都变成 PlaybackError。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLAY_PS1 = fileURLToPath(new URL('./play.ps1', import.meta.url));
const CAPTURE_BYTES = 16 * 1024;

const msg = (err) => (err instanceof Error ? err.message : String(err));
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const oneLine = (value, max = 300) => {
  const s = String(value ?? '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') // ffplay 会往 stderr 写清行之类的控制序列
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

export class PlaybackError extends Error {
  /**
   * @param {'missing'|'spawn'|'timeout'|'aborted'|'media'|'open'|'failed'} code
   * @param {string} message
   * @param {string} [detail]
   */
  constructor(code, message, detail = '') {
    super(message);
    this.name = 'PlaybackError';
    this.code = code;
    this.detail = detail;
  }
}

/** 给状态灯/日志看的后端名字。 */
export function backendLabel(platform = process.platform) {
  if (platform === 'win32') return 'Windows WPF MediaPlayer';
  if (platform === 'darwin') return 'afplay';
  if (platform === 'linux') return 'ffplay / mpv / paplay / aplay';
  return '不支持的平台';
}

export function supportedPlatform(platform = process.platform) {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux';
}

/** 包里的 PowerShell 脚本；Windows 的 preflight 会检查它在不在。 */
export function playScriptPath() {
  return PLAY_PS1;
}

/**
 * 跑一个播放器进程，收集少量输出。只有「起不来 / 超时 / 取消」会 reject；
 * 非零退出码原样放进结果，由调用方按平台解释。
 */
function run(command, args, opts = {}) {
  const { timeoutMs = 0, signal } = opts;
  if (signal?.aborted) {
    return Promise.reject(new PlaybackError('aborted', '播放被取消。'));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new PlaybackError('spawn', `播放器起不来：${msg(err)}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer = null;

    const append = (which, chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      if (which === 'out') stdout = (stdout + text).slice(-CAPTURE_BYTES);
      else stderr = (stderr + text).slice(-CAPTURE_BYTES);
    };
    child.stdout?.on('data', (chunk) => append('out', chunk));
    child.stderr?.on('data', (chunk) => append('err', chunk));

    const stop = () => {
      try {
        child.kill();
      } catch {
        /* 已经退了 */
      }
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    // 极少数情况下 signal 在 spawn 与 addEventListener 之间被取消。
    if (signal?.aborted) onAbort();

    child.on('error', (err) => {
      if (err?.code === 'ENOENT') {
        finish(reject, new PlaybackError('missing', `找不到播放命令 ${command}。`));
        return;
      }
      finish(reject, new PlaybackError('spawn', `播放器起不来：${msg(err)}`));
    });
    child.on('close', (code, closeSignal) => {
      if (aborted) {
        finish(reject, new PlaybackError('aborted', '播放被取消。'));
        return;
      }
      if (timedOut) {
        finish(reject, new PlaybackError('timeout', `播放超时（${Math.round(timeoutMs / 1000)} 秒）。`));
        return;
      }
      finish(resolve, { code: code ?? -1, signal: closeSignal, stdout, stderr });
    });
  });
}

function detailOf(result) {
  return oneLine(result.stderr || result.stdout);
}

function failed(command, result) {
  const detail = detailOf(result);
  return new PlaybackError(
    'failed',
    `${command} 播放失败（退出码 ${result.code}）。${detail ? ` ${detail}` : ''}`,
    detail,
  );
}

/**
 * ffplay 遇到打不开的文件也可能退 0，只把错误写在 stderr；这里把常见的
 * 「其实没播成」捞出来，免得给模型回一个假的成功。
 */
function ffplayProblem(result) {
  const detail = detailOf(result);
  if (result.code !== 0) return detail || `退出码 ${result.code}`;
  if (/Invalid data found|Could not open|Could not initialize|Failed to|No such file|No available audio device|Unable to open/i.test(detail)) {
    return detail;
  }
  return '';
}

async function playWindowsWpf({ path, volume, timeoutMs, signal }) {
  const result = await run('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    PLAY_PS1,
    '-Path',
    path,
    '-Volume',
    String(volume),
    '-TimeoutMs',
    String(timeoutMs),
  ], {
    // 脚本自己按 timeoutMs 收尾；给 PowerShell 启动和退出留一点余量。
    timeoutMs: timeoutMs + 20000,
    signal,
  });

  if (result.code === 0) return { backend: 'wpf' };
  const detail = detailOf(result);
  if (result.code === 2) {
    throw new PlaybackError('media', `播放失败：系统播放器解不开这段音频（格式或编码不受支持）。${detail ? ` ${detail}` : ''}`, detail);
  }
  if (result.code === 3) {
    throw new PlaybackError('timeout', `播放超时（${Math.round(timeoutMs / 1000)} 秒）。`, detail);
  }
  if (result.code === 4) {
    const missing = /file-not-found/i.test(detail);
    throw new PlaybackError(
      'open',
      missing ? '音频文件不存在。' : `播放器打不开这个文件。${detail ? ` ${detail}` : ''}`,
      detail,
    );
  }
  throw new PlaybackError('failed', `Windows 播放器出错（退出码 ${result.code}）。${detail ? ` ${detail}` : ''}`, detail);
}

async function playWithFfplay({ path, volume, timeoutMs, signal }) {
  const result = await run('ffplay', [
    '-nodisp',
    '-autoexit',
    '-loglevel',
    'error',
    '-volume',
    String(volume),
    path,
  ], {
    timeoutMs: timeoutMs + 5000,
    signal,
  });
  const problem = ffplayProblem(result);
  if (!problem) return { backend: 'ffplay' };
  throw new PlaybackError('failed', `ffplay 播放失败：${problem}`, problem);
}

async function playWindows(opts) {
  try {
    return await playWindowsWpf(opts);
  } catch (err) {
    const original = err instanceof PlaybackError ? err : new PlaybackError('failed', msg(err));
    // WPF 不认 OGG/OPUS 等格式、或 WPF 本身起不来时，若机器上装了 ffplay，再给它一次机会。
    if (original.code !== 'media' && original.code !== 'open' && original.code !== 'failed') throw original;
    try {
      return await playWithFfplay(opts);
    } catch (fallback) {
      if (fallback instanceof PlaybackError && fallback.code === 'missing') {
        original.message = `${original.message} 可以先转成 wav / mp3，或安装 ffplay 再试。`;
        throw original;
      }
      const extra = fallback instanceof PlaybackError ? fallback.message : msg(fallback);
      throw new PlaybackError('failed', `${original.message} 换 ffplay 也失败：${extra}`);
    }
  }
}

async function playDarwin({ path, volume, timeoutMs, signal }) {
  const result = await run('afplay', ['-v', String(volume / 100), path], {
    timeoutMs: timeoutMs + 5000,
    signal,
  });
  if (result.code === 0) return { backend: 'afplay' };
  throw failed('afplay', result);
}

async function playLinux({ path, volume, timeoutMs, signal }) {
  const candidates = [
    {
      command: 'ffplay',
      backend: 'ffplay',
      args: ['-nodisp', '-autoexit', '-loglevel', 'error', '-volume', String(volume), path],
    },
    {
      command: 'mpv',
      backend: 'mpv',
      args: ['--no-video', '--really-quiet', '--no-terminal', `--volume=${volume}`, path],
    },
    {
      command: 'paplay',
      backend: 'paplay',
      args: [path],
    },
    {
      command: 'aplay',
      backend: 'aplay',
      args: ['-q', path],
    },
  ];

  let failure = null;
  for (const one of candidates) {
    try {
      const result = await run(one.command, one.args, {
        timeoutMs: timeoutMs + 5000,
        signal,
      });
      if (one.command === 'ffplay') {
        const problem = ffplayProblem(result);
        if (!problem) return { backend: one.backend };
        failure = new PlaybackError('failed', `ffplay 播放失败：${problem}`, problem);
        continue;
      }
      if (result.code === 0) return { backend: one.backend };
      failure = failed(one.command, result);
    } catch (err) {
      if (err instanceof PlaybackError && err.code === 'missing') continue;
      throw err;
    }
  }
  if (failure) throw failure;
  throw new PlaybackError('missing', '没有可用的播放命令：安装 ffplay、mpv、paplay 或 aplay 之一。');
}

/**
 * 播放一个本地音频文件，等它结束。
 *
 * @param {{
 *   path: string,
 *   volume?: number,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   platform?: NodeJS.Platform,
 * }} opts
 * @returns {Promise<{backend: 'wpf'|'ffplay'|'afplay'|'mpv'|'paplay'|'aplay'}>}
 */
export async function playFile(opts = {}) {
  const path = String(opts.path ?? '');
  if (!path) throw new PlaybackError('open', '没有音频文件可播放。');
  const rawVolume = Number(opts.volume);
  const volume = Number.isFinite(rawVolume) ? clamp(Math.round(rawVolume), 0, 100) : 80;
  const timeoutMs = Math.max(1000, Math.round(Number(opts.timeoutMs) || 120000));
  const platform = opts.platform ?? process.platform;
  const common = { path, volume, timeoutMs, signal: opts.signal };

  if (platform === 'win32') return playWindows(common);
  if (platform === 'darwin') return playDarwin(common);
  if (platform === 'linux') return playLinux(common);
  throw new PlaybackError('missing', `当前系统（${platform}）没有可用的播放后端。`);
}
