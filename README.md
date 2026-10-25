# 音频播放 · cortico-world-audio-play

给 Coopanion 桌宠补上一件小事：**把一段音频从本机扬声器放出来**。`audio_play` 接一个本地音频路径，
或 `log:` / `mem:` 句柄（`tts_speak` 回执里的路径和附件句柄都能直接用），开始播放后立刻返回；
只有播放失败才发一条事件。后到的音频排队，`audio_queue` 可以跳过当前这条、删掉排队项或清空队列。

这是一个 `cortico` 的 **World 扩展**（`kind: world`，`api: 6`），只补一个 `audio-play` 世界，
不合成、不发送、不保存音频，也没有 npm 运行时依赖。

> 典型接力：`tts_speak` 把文字合成成音频并交回附件句柄 → 把路径或 `log:` 句柄交给
> `audio_play` → 本机扬声器出声。TTS 负责“做出来”，这里负责“放出来”，谁也不用改谁。
>
> MIT 许可，见 [LICENSE](LICENSE)。非官方扩展：与 Coopanion / cortico 的作者无关。

## 它做了什么

装好并启用之后，桌宠会多出三个工具：

| 工具 | 标签 | 作用 |
| --- | --- | --- |
| `audio_play` | `act` | 开始播放一个本地音频文件或 `log:` / `mem:` 句柄后立刻返回；失败发 `audio-play.failed` 事件 |
| `audio_watch` | `act` | 打开/关闭事件音频的自动播放、更换监听的事件类型或播放后端，或查看状态 |
| `audio_queue` | `act` | 查看播放队列、跳过当前这条、按 id 移除排队中的一条、停止当前并清空队列 |

`audio_play` 的参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `audio` | 是 | 音频文件路径（绝对路径；相对路径按 bot 的 workspace → bot 目录 → 插件数据目录找），或 `log:` / `mem:` 句柄 |
| `volume` | 否 | 本次播放音量 0–100；省略时用 `worlds.audio-play.volume` |

回执只表示已经交给后台播放，例如：

```text
开始播放（q1）：voice-20261018-140322.wav（音量 80）；放完不再回报，失败会以事件通知。
已排队（q2，前面还有 1 条）：log:xxxxxxxxxxxxxxxx.wav（音量 60）；放完不再回报，失败会以事件通知。
```

后台播放失败时发一条事件：

```text
自动播放失败：ffplay 播放失败：No such file or directory
音频：log:xxxxxxxxxxxxxxxx.wav · 音量 80 · 事件：tts.voice
```

失败事件不区分手动播放和自动播放；成功不发事件。`audio_play` 参数本身有误（`audio` 为空）或
World 已停止时，仍然直接回失败，不会启动后台播放。

`audio_watch` 的 `action` 是 `start` / `stop` / `set` / `status`；`events` 用逗号分隔事件类型（默认 `tts.voice`），`backend` 可以指定播放后端（选项见下面的「它怎么出声」）。`start` 之后本扩展自己监听并播放，不需要模型再调 `audio_play`。

`audio_queue` 的 `action` 是 `list` / `skip` / `remove` / `clear`，`id` 只给 `remove` 用：

| action | 行为 |
| --- | --- |
| `list` | 当前这条（id、来源、音量、已播几秒）与排队中的条目 |
| `skip` | 中止当前这条，下一条立刻开始；没有当前项时丢掉排队里的第一条 |
| `remove` | 按 id 删掉排队中的某条；当前这条要用 `skip` |
| `clear` | 停掉当前这条并清空排队 |

跳过和清空是**取消**，不是失败：播放器进程会被停掉，不发 `audio-play.failed`。手动播放和事件自动播放共用同一个队列，`music.played` 这类事件音频也能跳掉。队列只在内存里，重启应用后不会保留。

## 安装

包目录就是你现在看的这个目录。它没有运行时依赖，不需要先 `pnpm install`。三种装法，选一种：

**A. 控制台里装（推荐）**

设置 → 扩展 → 安装本地扩展，把本目录选给它。

**B. 命令行装**

在 `data/extensions` 目录里（`extensions/package.json` 所在处）执行：

```powershell
pnpm add "D:\path\to\cortico-world-audio-play" --ignore-workspace
```

它会往 `extensions/package.json` 的 `dependencies` 里写一条 `link:` 路径并连到 `node_modules/`。

**C. 手工连**

把 `data/extensions/node_modules/cortico-world-audio-play` 做成指向本目录的目录联接，
并自己在 `extensions/package.json` 里加
`"cortico-world-audio-play": "link:D:\\path\\to\\cortico-world-audio-play"`。

**装完必须重启 Coopanion**：扩展是 ESM 模块，进程内不会重新加载。重启后在 World 页启用本 World（写 `config.json` 的 `worlds.audio-play.enabled = true`），
`audio_play` 才会挂给桌宠。

### 一份能用的 `worlds.audio-play` 长什么样

`<安装目录>\data\home\<bot 目录>\config.json` 里：

```json
{
  "worlds": {
    "audio-play": {
      "enabled": true,
      "volume": 80,
      "timeoutMs": 120000,
      "backend": "auto"
    }
  }
}
```

改之前建议先备份 `config.json`（例如存成 `config.json.bak-audio-play-<时间戳>`）。
`enabled` 之外的项都可以在控制台「音频播放」页热改，不用重启。

## 配置

都在 `worlds.audio-play` 段：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否把 `audio_play` 挂给桌宠 |
| `volume` | `80` | 默认音量 0–100；工具参数 `volume` 可临时覆盖 |
| `timeoutMs` | `120000` | 单次播放的等待上限；超过就停掉播放器并报失败 |
| `backend` | `auto` | 播放后端：`auto` / `wpf` / `ffplay` / `mpv` / `vlc` / `afplay` / `paplay` / `aplay` / `custom` |
| `command` | 空 | `backend` 为 `custom` 时执行的命令模板；`{file}` 是音频文件，`{volume}` 是音量 0–100 |
| `autoPlay` | `false` | 监听事件库，把指定事件里的音频自动播放；只播打开之后的新事件 |
| `watchEvents` | `tts.voice` | 要监听的事件类型，逗号分隔；默认是 `cortico-world-tts` 的声音事件 |

不需要密钥，也没有 `.env` 配置。`autoPlay`、`watchEvents` 与 `backend` 也能由桌宠用 `audio_watch` 修改；`command` 只能在配置里写，桌宠不能改。

## 它怎么出声

播放器由 `worlds.audio-play.backend` 选择，扩展本身不装音频库。默认 `auto` 跟平台走：

| 平台 | `auto` 的后端 | 说明 |
| --- | --- | --- |
| Windows | PowerShell + WPF `MediaPlayer` | 用 `powershell.exe -STA` 跑包里的 `src/play.ps1`；系统自带，不额外装东西。WAV / MP3 / WMA 以及系统解码器支持的格式都能放。WPF 打不开时，如果 PATH 里有 `ffplay`，会自动再试一次（OGG / OPUS 常常靠它）。 |
| macOS | `afplay` | 系统自带，支持常见格式；音量用 `-v` 传。 |
| Linux | `ffplay` → `mpv` → `paplay` → `aplay` | 按顺序找第一个能用的；`paplay` / `aplay` 只有 WAV，且不支持音量参数。 |

也可以直接指定后端：

| `backend` | 命令 | 音量 | 说明 |
| --- | --- | --- | --- |
| `wpf` | `powershell.exe` + `src/play.ps1` | 支持 | 只适用于 Windows。 |
| `ffplay` | `ffplay -nodisp -autoexit` | 支持 | 需要先装 ffmpeg 并放进 PATH。 |
| `mpv` | `mpv --no-video` | 支持 | 需要先装 mpv 并放进 PATH。 |
| `vlc` | `vlc --intf dummy --play-and-exit` | 支持 | 需要 `vlc` 在 PATH 里。 |
| `afplay` | `afplay` | 支持 | 只适用于 macOS。 |
| `paplay` / `aplay` | `paplay` / `aplay -q` | 不支持 | 只适用于 Linux；音量由系统混音器决定。 |
| `custom` | `worlds.audio-play.command` | 看模板 | 按模板启动任意播放器；播放器要等到放完再退出，提前退出会被当成已播完。 |

`custom` 的命令模板按空白切分，参数可以用双引号或单引号包住；`{file}` 换成音频路径，`{volume}` 换成 0–100 的音量，例如：

```json
"command": "\"C:\\Program Files\\mpv\\mpv.exe\" --no-video --volume={volume} \"{file}\""
```

指定的命令找不到时，这次播放失败并提示是哪个后端，不会悄悄换成别的播放器。`auto` 在 Windows 上仍有 WPF → ffplay 的回退。

Windows 的 PowerShell 脚本退出码会翻成中文提示：

| 退出码 | 含义 |
| --- | --- |
| `0` | 放完了 |
| `2` | 格式 / 编码 / 解码器问题（`MediaFailed`） |
| `3` | 超时 |
| `4` | 文件不存在或打不开 |
| `5` | 播放流程没有正常结束 |

**同一时间只放一段**：后到的 `audio_play` 会排队，等前一段结束再开始，避免两段声音叠在一起。
工具回执在排队时立刻返回并带上队列 id（`q7`），播放器在后台依次播放；放完不会再有成功回执。
要跳过或清空，用 `audio_queue`。

## 句柄与路径

`audio` 支持三种写法：

1. **绝对路径**：`D:\Coopanion\data\...\voice.wav`
2. **相对路径**：先找 `<bot 目录>\workspace\<路径>`，再找 `<bot 目录>\<路径>`，最后找
   `<插件数据目录>\<路径>`。`file:///...` 这种文件 URL 也认。
3. **句柄**：`log:` 是对话里的附件（渠道收到的语音条、`tts_speak` / `listen` 交回的音频），
   `mem:` 是工作区里的文件。句柄由 Core 解析；扩展拿到字节后写成临时文件，放完就删。

### 和 TTS 接力

`tts_speak` 的回执里会有一行文件路径，以及一行模型可见的附件说明：

```text
合成好了。
文件：D:\Coopanion\data\...\voice-20261018-140322.wav
...
[blob log:xxxxxxxxxxxxxxxx.wav audio/wav voice-20261018-140322.wav]
```

两个都能直接给 `audio_play`：

```json
{ "audio": "D:\\Coopanion\\data\\...\\voice-20261018-140322.wav" }
```

```json
{ "audio": "log:xxxxxxxxxxxxxxxx.wav", "volume": 60 }
```

如果 TTS 用 `delivery: event` 或开启了 `autoSpeak`，不用手动交接：打开下面的 `autoPlay`，声音事件会被自动播放。

## 监听事件音频

`autoPlay: true` 后，本扩展每秒扫一次事件库，把 `watchEvents` 里列出的、带音频附件的新事件依次播放。它只播打开监听之后的事件；重启、关闭再打开都不补播旧事件。

- `watchEvents` 默认 `tts.voice`，也就是 `cortico-world-tts` 的声音事件；多个事件类型用逗号分隔。事件类型按扩展命名，别的扩展发音频事件时填它的事件名。
- 音频优先取事件附件句柄，其次取事件 `meta.path`（TTS 的声音事件两者都有）；和 `audio_play` 共用同一条播放队列。
- 桌宠可以用 `audio_watch` 控制：`start` / `stop` / `set`（换监听类型和/或播放后端）/ `status`，改动会写进配置。
- 播放失败会发 `audio-play.failed` 事件；成功不发事件。

## 播放失败事件

后台播放失败（找不到文件、句柄失效、播放命令缺失、格式不支持、超时等）时，本扩展发一条
`audio-play.failed` 事件，正文带音频来源、音量与原因，meta 带 `origin`（`manual` / `event`）、
`ref`、`type` 与 `backend`。事件默认投递到对话事件流，会唤醒桌宠。

- 手动 `audio_play` 和自动播放失败都走同一条事件；取消（用户打断、World 停止）不算失败，不发事件。
- 自动播放连续失败时，失败事件 30 秒内最多发一次；完整失败记录仍然写日志与状态。
- 成功没有后续事件。工具回执里的「开始播放」只表示已经入队，不代表一定放出来了。

## 控制台页

控制台左栏会多出「音频播放」：状态灯显示当前选择的播放后端，徽标显示默认音量。

「队列」页显示正在播放与排队中的音频：每条带 id、来源（手动 / 事件类型）、音量，当前这条
还显示已播时长；可以跳过当前、按条移除、清空队列。队列变化会实时推送到页面，页面关闭时
不轮询；推送断开时每 3 秒补一次快照。

「配置」页可以改是否启用、音量、超时、播放后端与自定义命令。所有配置都在 `worlds.audio-play`
段，热改就地生效。

「提示词」页默认是空的：工具描述已经够用，不写不会往系统前缀里加任何内容；需要补充
播放习惯或使用约定时再写。

## 自检

离线检查（不联网、不出声、不碰安装目录）：

```powershell
node tools/check.mjs
```

改了工具、事件或提示词模板后，先 `node tools/describe.mjs` 重新生成 `describe.json`；
Cortico 官方的 `pnpm check:extension` 会核对这份自描述。

用框架自带的判据跑一遍装配检查（manifest 解析、dry-mount、工具名冲突、配置路径）：

```powershell
$env:COOPANION_APP_ROOT = "D:\Coopanion\resources\app"
node --experimental-transform-types tools/drymount.mts
```

真放一声短的测试音（会从本机扬声器出声；音量默认 30）：

```powershell
node tools/smoke.mjs
```

`tools/smoke.mjs` 会在临时目录里造一段 0.6 秒的 WAV，走完
「路径 → `audio_play` → 系统播放器 → 回执」，然后删掉临时文件。加 `SMOKE_HANDLE=1`
则走 `log:` 句柄那条路（不经过文件路径）：

```powershell
$env:SMOKE_HANDLE = "1"; node tools/smoke.mjs
```

## 目录结构

```
cortico-world-audio-play/
├─ package.json        # cortico: { kind: world, api: 6, webUiClient, describe }
├─ describe.json       # 自描述：工具、事件与提示词（pnpm describe:extension 生成）
├─ CHANGELOG.md
├─ README.md
├─ src/
│  ├─ index.js         # 入口：default 导出 WorldDefinition
│  ├─ definition.js    # id/label/defaults/preflight/create/describe
│  ├─ config.js        # worlds.audio-play 默认值、中英文案、配置组 schema
│  ├─ world.js         # AudioPlayWorld：参数解析、显式队列、队列页接口与生命周期
│  ├─ ENV_PROMPT.md    # 控制台「提示词」页的模板，默认空
│  ├─ player.js        # 后端分派：auto / wpf / ffplay / mpv / vlc / afplay / paplay / aplay / custom
│  └─ play.ps1         # Windows 的 WPF MediaPlayer 播放脚本（纯 ASCII）
├─ dist/
│  └─ webui.js         # 「队列」页（纯浏览器 ES 模块，无需构建）
└─ tools/
   ├─ check.mjs        # 离线检查
   ├─ describe.mjs     # 重新生成 describe.json
   ├─ drymount.mts     # 用框架判据跑 dry-mount
   └─ smoke.mjs        # 真放一段短音
```

## 启用之后

- 跟桌宠提一句它现在有 `audio_play` 了：`tts_speak` 之后把回执里的文件路径，或那行
  `[blob log:…]` 里的句柄交给它即可。
- 第一次用建议先跑一次 `node tools/smoke.mjs`，确认这台机器的扬声器和播放后端正常。
- 如果它以前习惯用别的办法“外放”，让它改走 `audio_play`：不用打开外部播放器，
  也不会多一个窗口。

## 已知限制

- **只在本机出声**：不往 QQ / 其他渠道发送，也不产生新的对话附件；要发语音条，把 TTS 的句柄交给渠道工具。
- **成功不回报，失败才回报**：`audio_play` 开始播放后立刻返回，成功后没有后续回执；失败发 `audio-play.failed` 事件。超时（默认 120 秒）会停掉播放器并按失败处理。
- **格式看播放器**：`auto` 在 Windows 上用 WPF，对 WAV / MP3 / WMA 最稳；OGG / OPUS / M4A 这类是否成功取决于系统解码器。换成 `ffplay` / `mpv` / `vlc` 或能用这些格式的自定义播放器即可。
- **自定义播放器要等播放结束**：`custom` 只能看到播放器进程退出。会立刻把音频交给后台再自己退出的播放器（不少图形界面播放器默认如此），扩展会把它当成功，实际可能还在放；选一个能等播完再退出的命令或参数。
- **Linux 的音量**：`paplay` / `aplay` 不支持音量参数，音量由系统混音器决定。
- **句柄要能解析**：`log:` 附件被清掉（比如清空媒体库）后再播放会失败；`mem:` 句柄来自工作区，删了源文件也一样。
- 没有自定义 WebUI 面板；要在页面上管理音频，用 TTS / 听觉自己的「作品」页。

## 致谢

目录结构、扩展骨架与文案组织参考了
[cortico-world-tts](https://github.com/AqualCross/cortico-world-tts)（MIT）。
播放后端调用系统或 PATH 里的播放器命令，没有引入第三方库。

## 许可

MIT，见 [LICENSE](LICENSE)。
