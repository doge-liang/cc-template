# configs

Claude Code 配置模板（已脱敏，**不含任何真实密钥**）。

## `settings.example.json`

一份最小可用的 `~/.claude/settings.json` 示例，演示如何注册本仓库的状态栏脚本。

使用方法：

1. 复制其中的 `statusLine` 段到你自己的 `~/.claude/settings.json`。
2. 把 `command` 里的路径改成你放 `statusline.js` 的实际位置。
3. `env` 里的密钥请填**你自己的**值，切勿把真实密钥提交到任何公开仓库。

> ⚠️ 你的真实 `settings.json` 可能包含 API 密钥等敏感信息，请勿直接上传。本目录下的文件仅作模板参考。
