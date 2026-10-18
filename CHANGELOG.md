# 更新日志 · cortico-world-audio-play

每个版本一节 `## <版本号>`；扩展市场按节显示更新说明。

## 0.1.0

- 首个版本：`audio_play` 工具，接受本地音频路径或 `log:` / `mem:` 句柄（比如 `tts_speak` 回执里的路径与附件句柄），在本机扬声器播放并等待结束，只回成功或失败。
- Windows 用系统自带的 PowerShell + WPF MediaPlayer，macOS 用 `afplay`，Linux 依次尝试 `ffplay` / `mpv` / `paplay` / `aplay`；没有 npm 运行时依赖。
- 配置 `worlds.audio-play`：`enabled`、`volume`、`timeoutMs`；不需要密钥。
- 句柄先落成临时文件，播放结束即删；同一时间只放一段，后到的调用排队。
