# Context Usage Bar

Claude Code 状态栏小组件：在底部显示**上下文窗口占用**和**套餐用量（5h / 7d）**进度条。

纯 Node.js 实现，**无需 `jq` / `npx` / 联网**，离线即用。

## 效果

```
◆ Opus 4.8 · 📁 myproj · ⎇ main* +1 ~2 ?1 ↑1
🧠 Ctx [████░░░░░░] 42% 84k/200k   💰 $0.34
📊 5h [██░░░░░░] 28% ↺2h13m   7d [███████░] 83% ↺3d11h
```

| 行 | 内容 |
|----|------|
| 1 | 模型名 · 当前目录 · git 分支 + dirty 状态（在 git 仓库中才显示；detached HEAD 显示短 hash） |
| 2 | 上下文占用进度条 · `已用 token / 窗口大小` · 本次会话花费（`$`） |
| 3 | 套餐用量进度条：5 小时窗口、7 天窗口的用量百分比与距重置倒计时（`↺`） |

进度条配色随占用变化：🟢 `<50%` ／ 🟡 `<80%` ／ 🔴 `≥80%`。

**git 状态标记**（第 1 行分支名后）：

| 标记 | 含义 | 颜色 |
|------|------|------|
| `*` | 工作区有未提交改动（dirty 标记） | 🟡 黄 |
| `+N` | 已暂存（staged）文件数 | 🟢 绿 |
| `~N` | 已修改未暂存（modified）文件数 | 🟡 黄 |
| `?N` | 未跟踪（untracked）文件数 | ⚪ 灰 |
| `↑N` / `↓N` | 相对上游分支领先 / 落后的提交数 | 🔵 青 |
| `✓` | 工作区干净，无任何改动 | 🟢 绿 |

> git 状态通过一次 `git status --porcelain -b` 获取（800ms 超时）；若 `git` 不可用，则退回只读 `.git/HEAD` 仅显示分支名，不报错。

> 第 3 行只在 Claude.ai 订阅用户（Pro / Max）且本次会话已有过 API 响应后出现；非订阅或会话刚开始时会自动省略。

## 依赖

- [Node.js](https://nodejs.org)（任何较新版本均可）。验证：`node --version`。

## 安装

1. 把 `statusline.js` 放到一个固定位置，推荐：
   - Windows：`C:\Users\<你>\.claude\statusline.js`
   - macOS / Linux：`~/.claude/statusline.js`

2. 编辑 `~/.claude/settings.json`，加入 `statusLine`：

   **Windows：**
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node \"C:\\Users\\<你>\\.claude\\statusline.js\"",
       "padding": 0
     }
   }
   ```

   **macOS / Linux：**
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node ~/.claude/statusline.js",
       "padding": 0
     }
   }
   ```

3. 新开一个 Claude Code 会话即可看到状态栏。

## 自定义

脚本顶部有完整注释。常见改动：

| 想要 | 怎么改 |
|------|--------|
| 进度条更长 / 更短 | 改 `bar(pct, 10)` 第二个参数（第 3 行的套餐条是 `bar(..., 8)`） |
| 改变色阈值 | 改 `pctColor()` 里的 `80` / `50` |
| 删掉某一行 | 在 `render()` 里删除对应的 `line1/line2/lines.push(...)` |
| 换图标 | 直接替换 `◆ 📁 🧠 📊 ↺ ⎇` 等字符 |

## 工作原理

Claude Code 每次刷新状态栏时，会把当前会话的 JSON（模型、上下文 token、花费、套餐用量等）通过 **stdin** 传给 `command`。本脚本读取并解析，渲染后打印到 **stdout**。

用到的主要字段：

- `context_window.used_percentage` / `context_window_size` / `total_input_tokens` —— 上下文占用
- `rate_limits.five_hour` / `rate_limits.seven_day`（`used_percentage` + `resets_at`）—— 套餐用量
- `cost.total_cost_usd` —— 会话花费
- `model.display_name`、`workspace.current_dir` —— 模型与目录

字段完整说明见 [Claude Code 官方文档](https://code.claude.com/docs/en/statusline)。

## 本地测试

不进 Claude Code 也能预览渲染效果，喂一段模拟 JSON 即可：

```bash
node -e 'process.stdout.write(JSON.stringify({model:{display_name:"Opus 4.8"},workspace:{current_dir:"/tmp/myproj"},cost:{total_cost_usd:0.34},context_window:{total_input_tokens:84000,context_window_size:200000,used_percentage:42},rate_limits:{five_hour:{used_percentage:28,resets_at:Math.floor(Date.now()/1000)+8000},seven_day:{used_percentage:83,resets_at:Math.floor(Date.now()/1000)+300000}}}))' | node statusline.js
```
