# cc-template

> 一套自用的 **Claude Code** 增强模板集合 —— 状态栏（statusLine）小组件、配置模板、自定义 Skills，外加一个零依赖的**多设备配置同步 CLI**。开箱即用、不联网拉包、离线可用。

这个仓库用来沉淀我日常给 [Claude Code](https://code.claude.com) 做的各种「补强」，并在多台设备间**分发我自己的 Claude Code 配置**。所有东西都尽量做到**自包含**：不依赖 `npx` 联网下载、不依赖 `jq` 等额外命令行工具；同步工具只用 Node.js 自带能力。

真实密钥**永不进仓**——配置模板一律脱敏，`capture` 写回前还有一道安全扫描兜底。

---

## 📦 仓库内容

| 路径 | 说明 |
|------|------|
| [`sync.js`](./sync.js) | 多设备配置同步 CLI（零依赖） |
| [`manifest.json`](./manifest.json) | 同步注册表：声明哪些项、装到哪、哪些字段是密钥/机器特定 |
| [`lib/`](./lib) | sync.js 的内部模块（路径展开、原子写、键级合并、密钥脱敏与扫描、diff） |
| [`statuslines/`](./statuslines) | 底部状态栏小组件 |
| [`configs/`](./configs) | `settings.json` 等配置模板（已脱敏） |
| [`skills/`](./skills) | 自定义 Skills（🚧 规划中） |
| [`test/`](./test) | `node --test` 测试 |

---

## 🔄 配置同步（多设备）

用 `sync.js`（纯 Node、零依赖）在多设备间分发本仓配置。以 [`manifest.json`](./manifest.json) 为单一事实源，密钥走**模板占位**——真密钥永不进仓。

### 命令

```bash
node sync.js list                # 列出所有项及各自同步状态（in-sync / differs / 缺失）
node sync.js diff [id...]        # 只看差异，不改任何文件
node sync.js apply [id...]       # repo → 本地（带 diff 确认；保留本地真密钥）
node sync.js capture [id...]     # 本地 → repo（自动把真密钥剥离成占位；写前安全扫描）
```

常用标志：`--yes`/`-y` 跳过确认；`--dry-run` 只看不写；`--force-allow-unredacted`（极少用）强行允许未声明的疑似密钥写入。
不带 `id` 表示对所有项操作。

### 当前纳管的项

| id | 类型 | 目标 | 说明 |
|----|------|------|------|
| `statusline` | file | `~/.claude/statusline.js` | 状态栏脚本（整文件同步） |
| `settings` | json-merge | `~/.claude/settings.json` | 设置（键级合并，仅同步白名单内的键） |

### 工作流

- **新机部署**：`git clone` → `node sync.js apply` → 按提示填入各密钥（脚本会列出去哪取）。
- **回灌改动**：改完本地配置 → `node sync.js capture` → `git commit && git push`。

### 三条安全/正确性保证

1. **模板占位**：`manifest.json` 里声明的密钥路径（如 `env.ZOTERO_API_KEY`），`apply` 时保留你本地真值（本地没有则写占位并提示去哪取），`capture` 时自动换回占位。真值只在本地。
2. **字段白名单**：`settings` 项只同步 `manifest.keys` 列出的键——`env`（密钥脱敏）、`permissions`、`enabledPlugins`、`enabledMcpjsonServers`、`statusLine`、`verbose`、`agentPushNotifEnabled`。**刻意排除** `skipDangerousModePermissionPrompt` / `skipAutoPermissionPrompt` 等安全敏感、机器特定的键，它们不会进公开仓、`apply` 也不碰它们。
3. **安全扫描兜底**：`capture` 写回前扫描"未声明的疑似密钥"（key 名像 `*_KEY/*_TOKEN/*_SECRET` 或高熵长串），命中即中止，避免真值漏进公开仓。

> **机器特定路径（如 `statusLine.command`）**：模板里存为可移植的 `node "~/.claude/statusline.js"`。`apply` 会自动把 `~` 展开成本机 home（Windows 也安全，无需手动改绝对路径），`capture` 再收缩回 `~` 并归一斜杠。`manifest.json` 的 `pathFields` 声明哪些字段走这套处理。

---

## ⭐ 当前组件

### 1. Context Usage Bar —— 上下文占用 + 套餐用量进度条

📁 [`statuslines/context-usage-bar/`](./statuslines/context-usage-bar)

一个用 Node.js 写的状态栏脚本，在 Claude Code 底部实时显示信息：

```
🤖 Opus 4.8  ·  📁 C:\Users\you\proj  ·  🌿 main ✓
🧠 Context: [████░░░░░░] 42% 84k/200k  ·  💰 $0.34
📊 Usage: 5h [██░░░░░░] 28% ⏳ 2h13m   7d [███████░] 83% ⏳ 3d11h
```

- **第 1 行**：模型 · 当前完整目录 · git 分支与 **dirty 状态**（`*` 脏标记、`+`暂存 / `~`已改 / `?`未跟踪 计数、`↑↓` 领先/落后；干净时显示 `✓`）
- **第 2 行**：**上下文窗口占用**进度条 + token 数 + 本次会话花费
- **第 3 行**：**套餐用量**进度条 —— 5 小时窗口 / 7 天窗口的用量及距重置倒计时 `⏳`（仅 Pro/Max 订阅、且本次会话有过 API 响应后出现）

配色为黑底高对比：内容文字用亮色，进度条按占用变色 🟢 `<50%` ／ 🟡 `<80%` ／ 🔴 `≥80%`。图标统一为 emoji，不依赖特殊字体。

👉 字段来源与详细安装见 [组件 README](./statuslines/context-usage-bar/README.md)。

---

## 🚀 快速开始

**推荐（用 sync.js）**：

```bash
git clone https://github.com/doge-liang/cc-template.git
cd cc-template
node sync.js apply          # 把 statusline + settings 应用到 ~/.claude（带 diff 确认）
# 按脚本末尾提示，填入各密钥（如 Zotero API Key）
```

新开一个 Claude Code 会话即可在底部看到状态栏。

**手动（只装状态栏）**：把 `statuslines/context-usage-bar/statusline.js` 拷到 `~/.claude/statusline.js`，在 `~/.claude/settings.json` 加：

```jsonc
{
  "statusLine": {
    "type": "command",
    "command": "node \"~/.claude/statusline.js\"",
    "padding": 0
  }
}
```

> Windows 上若手动填写，`~` 不会被 cmd 展开，请改成绝对路径 `node "C:\\Users\\<你>\\.claude\\statusline.js"`；用 `node sync.js apply` 则会自动处理。

完整可参考的配置见 [`configs/settings.template.json`](./configs/settings.template.json)。

---

## 🧩 设计原则

- **零外部依赖**：只用运行时自带能力（Node.js / 原生 shell），不联网拉包；子进程一律 `execFileSync(数组参数)`，不经 shell。
- **永不报错**：状态栏脚本对任何异常（JSON 解析失败、字段缺失、非 git 目录）都静默降级，绝不污染 Claude Code 界面。
- **隐私安全 / 永不泄密**：模板均已脱敏；同步用模板占位 + 字段白名单 + capture 安全扫描三重保证，真密钥与机器特定/安全敏感字段不进公开仓。
- **写入安全**：`apply`/`capture` 写入前备份 `.bak`、用临时文件 + rename 原子写，绝不删除本地独有的键。
- **可读优先**：每个脚本顶部都有注释说明输入字段与用途，方便自行魔改。

---

## 🗺️ 规划

- [x] git dirty 状态标记（`*` / staged / modified 计数）
- [x] 黑底高对比配色 + 统一 emoji 图标 + 完整路径
- [x] 多设备配置同步 CLI（apply / capture / diff，模板占位 + 白名单 + 安全扫描）
- [ ] 把更多项纳入 manifest（skills / hooks / keybindings）
- [ ] 单行紧凑版状态栏（适合窄终端）

---

## 📄 License

[MIT](./LICENSE)
