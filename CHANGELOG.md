# 更新日志 · cortico-world-audio-play

每个版本一节 `## <版本号>`；扩展市场按节显示更新说明。

## 0.2.0

- 新增 `worlds.audio-play.backend`：选择播放后端。`auto` 保持平台默认，也可以指定 `wpf` / `ffplay` / `mpv` / `vlc` / `afplay` / `paplay` / `aplay`，或用 `custom`。
- 新增 `worlds.audio-play.command`：后端为 `custom` 时执行自定义命令，`{file}` 与 `{volume}` 是占位符；命令不经过 shell。
- `audio_watch` 的 `set` 可以更换播放后端，`status` 会显示当前后端与自定义命令。
- `audio_play` 改为非阻塞：开始播放（或排队）后立刻返回，不再等播放结束。
- 成功不发事件；播放失败发 `audio-play.failed` 事件，正文带音频来源、音量与原因，默认投递到对话事件流。取消和 World 停止不算失败。
- 自动播放失败也发同一条事件；连续失败时 30 秒内最多通知一次，避免事件潮。
- 回执从「播放完了」改为「开始播放 / 已排队」；播放器和自动播放仍然共用一条串行队列。
- 新增空的「提示词」页（`src/ENV_PROMPT.md`）；默认不往系统前缀加内容，部署者可以补充播放约定。
- Windows 的 WPF 打不开格式时，错误提示会建议换一个后端。

## 0.1.1

- 新增 `worlds.audio-play.autoPlay` 与 `watchEvents`：监听事件库里的指定事件（默认 `tts.voice`），把带音频附件的新事件播放出来；只播打开监听之后的事件，重启不补。
- 新增 `audio_watch` 工具：桌宠可以 `start` / `stop` / `set` 监听类型 / `status`，改动写入配置。
- 事件里的音频优先取附件句柄，其次取事件 meta 里的文件路径；与 `audio_play` 共用同一条播放队列。

## 0.1.0

- 首个版本：`audio_play` 工具，接受本地音频路径或 `log:` / `mem:` 句柄（比如 `tts_speak` 回执里的路径与附件句柄），在本机扬声器播放并等待结束，只回成功或失败。
- Windows 用系统自带的 PowerShell + WPF MediaPlayer，macOS 用 `afplay`，Linux 依次尝试 `ffplay` / `mpv` / `paplay` / `aplay`；没有 npm 运行时依赖。
- 配置 `worlds.audio-play`：`enabled`、`volume`、`timeoutMs`；不需要密钥。
- 句柄先落成临时文件，播放结束即删；同一时间只放一段，后到的调用排队。
