# 音频播放 · cortico-world-audio-play

给 Coopanion 桌宠补上一件小事：**把一段音频从本机扬声器放出来**。它只接一个 agent 工具——
传一个本地音频路径，或 `log:` / `mem:` 句柄（`tts_speak` 回执里的路径和附件句柄都能直接用），
播放完回一句成功或失败。

这是一个 `cortico` 的 **World 扩展**（`kind: world`，`api: 6`），只补一个 `audio-play` 世界，
不合成、不发送、不保存音频，也没有 npm 运行时依赖。

> 典型接力：`tts_speak` 把文字合成成音频并交回附件句柄 → 把路径或 `log:` 句柄交给
> `audio_play` → 本机扬声器出声。TTS 负责“做出来”，这里负责“放出来”，谁也不用改谁。
>
> MIT 许可，见 [LICENSE](LICENSE)。非官方扩展：与 Coopanion / cortico 的作者无关。

## 它做了什么

装好并启用之后，桌宠会多出一个工具：

| 工具 | 标签 | 作用 |
| --- | --- | --- |
| `audio_play` | `act` | 播放一个本地音频文件或 `log:` / `mem:` 句柄；等它放完，只回成功/失败 |

参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `audio` | 是 | 音频文件路径（绝对路径；相对路径按 bot 的 workspace → bot 目录 → 插件数据目录找），或 `log:` / `mem:` 句柄 |
| `volume` | 否 | 本次播放音量 0–100；省略时用 `worlds.audio-play.volume` |

回执只给最基本的信息，例如：

```text
播放完了：voice-20261018-140322.wav（48.0 KB · 音量 80）
播放完了：log:xxxxxxxxxxxxxxxx.wav（48.0 KB · 音量 60 · 句柄）
```

失败时是：

```text
[audio_play 失败] 找不到音频文件：nope.wav（相对路径先按 bot 目录的 workspace/、再按 bot 目录、最后按插件数据目录找）
```

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

**装完必须重启 Coopanion**：扩展是 ESM 模块，进程内不会重新加载。重启后在
`config.json` 的 `worlds.audio-play.enabled` 上打开（控制台里也有这个开关），
`audio_play` 才会挂给桌宠。

### 一份能用的 `worlds.audio-play` 长什么样

`<安装目录>\data\home\<bot 目录>\config.json` 里：

```json
{
  "worlds": {
    "audio-play": {
      "enabled": true,
      "volume": 80,
      "timeoutMs": 120000
    }
  }
}
```

改之前建议先备份 `config.json`（例如存成 `config.json.bak-audio-play-<时间戳>`）。
`enabled` 之外的两项都可以在控制台「音频播放」页热改，不用重启。

## 配置

都在 `worlds.audio-play` 段：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否把 `audio_play` 挂给桌宠 |
| `volume` | `80` | 默认音量 0–100；工具参数 `volume` 可临时覆盖 |
| `timeoutMs` | `120000` | 单次播放的等待上限；超过就停掉播放器并报失败 |

不需要密钥，也没有 `.env` 配置。

## 它怎么出声

播放走系统自带的播放器，扩展本身不装音频库：

| 平台 | 后端 | 说明 |
| --- | --- | --- |
| Windows | PowerShell + WPF `MediaPlayer` | 用 `powershell.exe -STA` 跑包里的 `src/play.ps1`；系统自带，不额外装东西。WAV / MP3 / WMA 以及系统解码器支持的格式都能放。WPF 打不开时，如果 PATH 里有 `ffplay`，会自动再试一次（OGG / OPUS 常常靠它）。 |
| macOS | `afplay` | 系统自带，支持常见格式；音量用 `-v` 传。 |
| Linux | `ffplay` / `mpv` / `paplay` / `aplay` | 按顺序找第一个能用的；`paplay` / `aplay` 只有 WAV，且不支持音量参数。 |

Windows 的 PowerShell 脚本退出码会翻成中文提示：

| 退出码 | 含义 |
| --- | --- |
| `0` | 放完了 |
| `2` | 格式 / 编码 / 解码器问题（`MediaFailed`） |
| `3` | 超时 |
| `4` | 文件不存在或打不开 |
| `5` | 播放流程没有正常结束 |

**同一时间只放一段**：后到的 `audio_play` 会排队，等前一段结束再开始，避免两段声音叠在一起。
播放期间工具调用会一直等到结束；桌宠要接着干别的，可以先把任务说完再播。

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

## 控制台页

没有自定义面板（这个扩展刻意只做一个工具）。控制台左栏会多出「音频播放」：
状态灯显示当前平台的播放后端，徽标显示默认音量，「配置」页可以改是否启用、音量与超时。
所有配置都在 `worlds.audio-play` 段，热改就地生效。

## 自检

离线检查（不联网、不出声、不碰安装目录）：

```powershell
node tools/check.mjs
```

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
├─ package.json        # cortico: { kind: world, api: 6, describe: describe.json }
├─ describe.json       # 自描述：工具与事件（pnpm describe:extension 生成）
├─ CHANGELOG.md
├─ README.md
├─ src/
│  ├─ index.js         # 入口：default 导出 WorldDefinition
│  ├─ definition.js    # id/label/defaults/preflight/create/describe
│  ├─ config.js        # worlds.audio-play 默认值、中英文案、配置组 schema
│  ├─ world.js         # AudioPlayWorld：参数解析、句柄落临时文件、工具与生命周期
│  ├─ player.js        # 平台分派：WPF / afplay / ffplay / mpv / paplay / aplay
│  └─ play.ps1         # Windows 的 WPF MediaPlayer 播放脚本（纯 ASCII）
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
- **要等播放结束**：`audio_play` 是阻塞式工具。很长的音频会占住一轮对话；超时（默认 120 秒）会停掉播放器并报失败。
- **格式看系统解码器**：Windows 的 WPF 对 WAV / MP3 / WMA 最稳；OGG / OPUS / M4A 这类是否成功取决于系统装的解码器，装了 `ffplay` 会好很多。
- **Linux 的音量**：回退到 `paplay` / `aplay` 时音量参数不起作用，音量由系统混音器决定。
- **句柄要能解析**：`log:` 附件被清掉（比如清空媒体库）后再播放会失败；`mem:` 句柄来自工作区，删了源文件也一样。
- 没有自定义 WebUI 面板；要在页面上管理音频，用 TTS / 听觉自己的「作品」页。

## 致谢

目录结构、扩展骨架与文案组织参考了
[cortico-world-tts](https://github.com/AqualCross/cortico-world-tts)（MIT）。
播放后端全部使用系统自带命令，没有引入第三方库。

## 许可

MIT，见 [LICENSE](LICENSE)。
