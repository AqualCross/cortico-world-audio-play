/**
 * 音频播放的 WebUI 面板（浏览器侧 bundle）。
 *
 * 宿主按 `/assets/extensions/<包>/<版本>/dist/webui.js` 取这个文件，
 * 直接 `import()` 它的 default 导出；所以它是纯浏览器 ES 模块：
 * 不 import 任何东西（`cortico/*` 在这里只允许 `import type`），只用 ctx.ui。
 */

const STYLE = `
.aq-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.aq-item { border: 1px solid rgba(128,128,128,.35); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.aq-current { border-color: rgba(74,168,255,.75); box-shadow: inset 3px 0 0 #4aa8ff; }
.aq-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.aq-name { font-weight: 600; word-break: break-all; }
.aq-sub { opacity: .65; font-size: 11px; word-break: break-all; }
.aq-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 2px; }
.aq-empty { padding: 22px 8px; text-align: center; opacity: .8; }
.aq-conn { display: flex; gap: 6px; align-items: center; }
.aq-foot { font-size: 11px; opacity: .7; }
.aq-elapsed { font-variant-numeric: tabular-nums; }
button:disabled { opacity: .45; cursor: default; }
`;

const ZH = {
  title: '队列',
  titleEn: 'Queue',
  desc: '正在播放与排队中的音频；可跳过当前、移除排队项或清空队列。',
  refresh: '刷新',
  skip: '跳过当前',
  clear: '清空队列',
  clearAsk: '清空播放队列？',
  clearBody: '当前这条会停止，排队中的条目都会被丢掉。',
  remove: '移除',
  copyRef: '复制来源',
  current: '当前',
  pending: '排队',
  backend: '后端',
  nowPlaying: '正在播放',
  position: (n) => `第 ${n} 条`,
  empty: '队列是空的。',
  manual: '手动',
  event: '事件',
  volume: '音量',
  elapsed: (seconds) => `已播 ${clock(seconds)}`,
  autoOn: '自动播放：开',
  autoOff: '自动播放：关',
  watch: '监听',
  connecting: '连接中',
  connected: '已连接',
  busy: '处理中',
  unknown: '未知错误',
  loadBad: '读取队列失败',
};

const EN = {
  title: 'Queue',
  titleEn: '',
  desc: 'Audio playing now and waiting in line; skip the current item, remove a waiting one, or clear the queue.',
  refresh: 'Refresh',
  skip: 'Skip current',
  clear: 'Clear queue',
  clearAsk: 'Clear the playback queue?',
  clearBody: 'The current item stops and everything waiting is dropped.',
  remove: 'Remove',
  copyRef: 'Copy source',
  current: 'Current',
  pending: 'Waiting',
  backend: 'Backend',
  nowPlaying: 'Now playing',
  position: (n) => `#${n}`,
  empty: 'The queue is empty.',
  manual: 'Manual',
  event: 'Event',
  volume: 'Volume',
  elapsed: (seconds) => `${clock(seconds)} played`,
  autoOn: 'Auto-play: on',
  autoOff: 'Auto-play: off',
  watch: 'Watching',
  connecting: 'Connecting',
  connected: 'Connected',
  busy: 'Working',
  unknown: 'Unknown error',
  loadBad: 'Could not read the queue',
};

function clock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} 秒`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const text = (language) => (language === 'en' ? EN : ZH);

/** 异常一律收敛成一行字。 */
function message(err) {
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return String(err);
}

function injectStyle(ctx) {
  const el = ctx.ui.h('style');
  el.textContent = STYLE;
  ctx.root.appendChild(el);
}

function queuePanel(ctx) {
  const tx = text(ctx.language);
  injectStyle(ctx);

  const sheet = ctx.ui.sheet({ title: tx.title, en: tx.titleEn || undefined, desc: tx.desc });
  ctx.root.appendChild(sheet.el);
  const body = sheet.body;

  const stats = ctx.ui.statgrid();
  body.appendChild(stats);

  const rowbar = ctx.ui.rowbar();
  const connBox = ctx.ui.h('div', 'aq-conn');
  rowbar.appendChild(connBox);
  rowbar.appendChild(ctx.ui.h('span', 'grow'));
  body.appendChild(rowbar);

  const actions = ctx.ui.actions();
  body.appendChild(actions);

  const note = ctx.ui.msgline('');
  body.appendChild(note);

  const list = ctx.ui.h('div', 'aq-list');
  body.appendChild(list);

  const foot = ctx.ui.h('div', 'aq-foot');
  body.appendChild(foot);

  let snapshot = null;
  let live = false;
  let seq = 0;

  const setConn = (label, tone) => {
    connBox.textContent = '';
    connBox.appendChild(ctx.ui.pill(label, tone));
  };
  const say = (line) => {
    note.textContent = line || '';
  };

  const originLabel = (item) => (item.origin === 'event'
    ? `${tx.event}${item.type ? ` ${item.type}` : ''}`
    : tx.manual);

  const tick = () => {
    const el = list.querySelector('[data-elapsed]');
    const started = snapshot?.current?.startedAtMs;
    if (!el || !started) return;
    el.textContent = tx.elapsed((Date.now() - started) / 1000);
  };

  const updateActions = () => {
    skipBtn.disabled = !snapshot?.current;
    clearBtn.disabled = !snapshot?.current && !(snapshot?.pending?.length);
  };

  const card = (item, isCurrent) => {
    const el = ctx.ui.h('div', isCurrent ? 'aq-item aq-current' : 'aq-item');
    el.dataset.id = item.id;

    const head = ctx.ui.h('div', 'aq-head');
    head.appendChild(ctx.ui.pill(isCurrent ? tx.nowPlaying : tx.position(item.position), isCurrent ? 'on' : 'plain'));
    head.appendChild(ctx.ui.h('span', 'aq-name', item.shown || item.ref || item.id));
    el.appendChild(head);

    const bits = [item.id, originLabel(item), `${tx.volume} ${item.volume}`];
    const meta = ctx.ui.h('div', 'aq-sub', bits.join(' · '));
    el.appendChild(meta);

    const bar = ctx.ui.h('div', 'aq-row');
    if (isCurrent) {
      const elapsed = ctx.ui.h('span', 'aq-sub aq-elapsed');
      elapsed.dataset.elapsed = '1';
      elapsed.textContent = tx.elapsed(item.elapsedSec);
      bar.appendChild(elapsed);
      bar.append(
        ctx.ui.button(tx.skip, { size: 'sm', onClick: () => { void run('skip'); } }),
        ctx.ui.copyButton(item.ref, { label: tx.copyRef }),
      );
    } else {
      bar.append(
        ctx.ui.button(tx.remove, { variant: 'danger', size: 'sm', onClick: () => { void run('remove', [item.id]); } }),
        ctx.ui.copyButton(item.ref, { label: tx.copyRef }),
      );
    }
    el.appendChild(bar);
    return el;
  };

  const render = (data) => {
    if (!data || typeof data !== 'object') return;
    snapshot = data;
    const counts = data.counts ?? { current: data.current ? 1 : 0, pending: data.pending?.length ?? 0 };
    stats.replaceChildren(
      ctx.ui.stat({ k: tx.current, v: counts.current ? (data.current?.id ?? '1') : '—' }),
      ctx.ui.stat({ k: tx.pending, v: String(counts.pending ?? 0) }),
      ctx.ui.stat({ k: tx.backend, v: data.backend || '—' }),
    );
    foot.textContent = `${data.autoPlay ? tx.autoOn : tx.autoOff} · ${tx.watch}：${data.watchEvents || '—'}`;

    list.replaceChildren();
    if (!data.current && !(data.pending?.length)) {
      list.appendChild(ctx.ui.h('div', 'aq-empty', tx.empty));
    } else {
      if (data.current) list.appendChild(card(data.current, true));
      for (const item of data.pending ?? []) list.appendChild(card(item, false));
    }
    updateActions();
    tick();
  };

  const reload = async (busy) => {
    const mine = ++seq;
    const release = busy ? ctx.ui.busy(tx.busy, tx.refresh) : null;
    try {
      const data = await ctx.invoke('list', []);
      if (mine !== seq || ctx.signal.aborted) return;
      render(data);
      say('');
    } catch (err) {
      if (mine !== seq) return;
      say(`${tx.loadBad}：${message(err)}`);
      ctx.ui.toast(`${tx.loadBad}：${message(err)}`, 'bad');
    } finally {
      if (release) release.dispose();
    }
  };

  const run = async (method, args = []) => {
    const release = ctx.ui.busy(tx.busy, tx.refresh);
    try {
      const res = await ctx.invoke(method, args);
      if (res && typeof res === 'object') render(res);
      if (res?.message) ctx.ui.toast(res.message, 'ok');
    } catch (err) {
      ctx.ui.toast(message(err), 'bad');
      void reload(false);
    } finally {
      release.dispose();
    }
  };

  const skipBtn = ctx.ui.button(tx.skip, { size: 'sm', onClick: () => { void run('skip'); } });
  const clearBtn = ctx.ui.button(tx.clear, {
    variant: 'danger',
    size: 'sm',
    onClick: async () => {
      const ok = await ctx.ui.confirm({ title: tx.clearAsk, body: tx.clearBody, danger: true });
      if (!ok) return;
      await run('clear');
    },
  });
  skipBtn.disabled = true;
  clearBtn.disabled = true;

  actions.append(
    ctx.ui.button(tx.refresh, { size: 'sm', onClick: () => { void reload(true); } }),
    skipBtn,
    clearBtn,
  );

  setConn(tx.connecting, 'plain');
  ctx.own(ctx.stream({
    open: () => {
      live = true;
      setConn(tx.connected, 'on');
    },
    close: () => {
      live = false;
      setConn(tx.connecting, 'off');
    },
    message: (raw) => {
      let frame = null;
      try {
        frame = JSON.parse(raw);
      } catch (e) {
        return;
      }
      if (!frame || typeof frame !== 'object') return;
      if ((frame.t === 'ready' || frame.t === 'queue') && frame.queue) render(frame.queue);
      if (frame.t === 'error') ctx.ui.toast(frame.message || tx.unknown, 'bad');
    },
  }));

  ctx.interval(tick, 1000);
  ctx.interval(() => {
    if (!live) void reload(false);
  }, 3000);

  void reload(true);
}

export default {
  panels: {
    queue: { mount: queuePanel },
  },
};
