# cc-template

> 一套自用的 **Claude Code** 增强模板集合 —— 状态栏（statusLine）小组件、补强脚本、Skills 与配置模板，开箱即用、零外部依赖、离线可用。

这个仓库用来沉淀我日常给 [Claude Code](https://code.claude.com) 做的各种「补强」。所有东西都尽量做到**自包含**：不依赖 `npx` 联网下载、不依赖 `jq` 等额外命令行工具，拷过去改改路径就能用。

---

## 📦 仓库内容

| 目录 | 说明 | 状态 |
|------|------|------|
| [`statuslines/`](./statuslines) | 底部状态栏小组件 | ✅ 已有 1 个 |
| [`configs/`](./configs) | `settings.json` 等配置模板（已脱敏） | ✅ |
| [`skills/`](./skills) | 自定义 Skills | 🚧 规划中 |

---

## ⭐ 当前组件

### 1. Context Usage Bar —— 上下文占用 + 套餐用量进度条

📁 [`statuslines/context-usage-bar/`](./statuslines/context-usage-bar)

一个用 Node.js 写的状态栏脚本，在 Claude Code 底部实时显示三行信息：

```
◆ Opus 4.8 · 📁 myproj · ⎇ main* +1 ~2 ?1 ↑1
🧠 Ctx [████░░░░░░] 42% 84k/200k   💰 $0.34
📊 5h [██░░░░░░] 28% ↺2h13m   7d [███████░] 83% ↺3d11h
```

- **第 1 行**：模型 · 当前目录 · git 分支与 **dirty 状态**（`*` 脏标记、`+`暂存 / `~`已改 / `?`未跟踪 计数、`↑↓` 领先/落后；干净时显示 `✓`）
- **第 2 行**：**上下文窗口占用**进度条 + token 数 + 本次会话花费
- **第 3 行**：**套餐用量**进度条 —— 5 小时窗口 / 7 天窗口的用量及距重置倒计时（仅 Pro/Max 订阅且有过 API 响应后出现）

进度条按占用自动变色：🟢 `<50%` ／ 🟡 `<80%` ／ 🔴 `≥80%`。

👉 详细安装说明见 [组件 README](./statuslines/context-usage-bar/README.md)。

---

## 🚀 快速开始

以「Context Usage Bar」为例（其它组件思路类似）：

1. **拿到脚本**。克隆本仓库，或直接下载单个文件：

   ```bash
   git clone https://github.com/doge-liang/cc-template.git
   ```

2. **放到一个固定位置**。推荐放进 Claude Code 的配置目录，例如：

   - Windows：`C:\Users\<你>\.claude\statusline.js`
   - macOS / Linux：`~/.claude/statusline.js`

3. **在 `settings.json` 里注册**（`~/.claude/settings.json`），加上 `statusLine` 字段：

   ```jsonc
   {
     "statusLine": {
       "type": "command",
       "command": "node \"C:\\Users\\<你>\\.claude\\statusline.js\"",
       "padding": 0
     }
   }
   ```

   > macOS / Linux 把 `command` 换成 `node ~/.claude/statusline.js` 即可。

4. **生效**。新开一个 Claude Code 会话即可在底部看到状态栏。

完整可参考的配置见 [`configs/settings.example.json`](./configs/settings.example.json)。

---

## 🧩 设计原则

- **零外部依赖**：只用运行时自带能力（Node.js / 原生 shell），不联网拉包。
- **永不报错**：状态栏脚本对任何异常（JSON 解析失败、字段缺失、非 git 目录）都静默降级，绝不污染 Claude Code 界面。
- **可读优先**：每个脚本顶部都有注释说明输入字段与用途，方便自行魔改。
- **隐私安全**：仓库内的配置模板均已脱敏，不含任何真实密钥。

---

## 🗺️ 规划

- [ ] 单行紧凑版状态栏（适合窄终端）
- [x] git dirty 状态标记（`*` / staged / modified 计数）
- [ ] 常用 Skills 模板
- [ ] `hooks` 配置模板（格式化、提交前检查等）

---

## 📄 License

[MIT](./LICENSE)
