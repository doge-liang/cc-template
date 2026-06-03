# cc-template 配置同步设计（Config Sync Design）

- 日期：2026-06-03
- 状态：已批准（设计阶段）
- 范围：把 cc-template 从「单个 statusline 组件仓」升级为「多设备 Claude Code 配置模板仓」，提供单项同步 + diff 决策的双向同步工具。

---

## 1. 背景与目标

cc-template 目前只有一个实质组件（Context Usage Bar 状态栏）。目标是让它成为作者**多设备分发自己 Claude Code 配置**的模板仓：

- **单项同步**：每个组件/配置可单独同步，而非一键全量覆盖。
- **diff 决策合并**：同步某项时先展示 repo 版 vs 本地版差异，由用户决定是否覆盖。
- **公开仓安全**：仓库公开，作者真实 `settings.json` 含真密钥（如 `ZOTERO_API_KEY`），真密钥**永不进 repo**。

### 纳管范围（item 类别）

1. statusLine 脚本（`statusline.js`）
2. `settings.json` 配置（脱敏模板）
3. 自定义 skills（每个一子目录）
4. hooks / keybindings / MCP 注册（其中用户级 MCP 注册随 `settings.json` 的 `enabledMcpjsonServers` 一起走）

---

## 2. 核心决策（已确认）

| 维度 | 决策 |
|------|------|
| 密钥策略 | **模板占位**：repo 只存脱敏模板（密钥=占位串），安装脚本提醒用户填哪些键、去哪取；真值仅存本地。 |
| 同步方向 | **双向**：`apply`（repo→设备，带 diff，保留本地真密钥）+ `capture`（设备→repo，剥离真密钥成占位）。 |
| 工具形态 | **单文件 Node CLI**（`sync.js`），零外部依赖、跨平台、子命令式。 |
| settings 合并 | **键级合并 + 逐项 diff**；密钥路径保留本地真值；本地独有键不删除。 |
| 架构 | **方案 A（manifest 驱动注册表）为骨架 + 方案 C（capture 安全扫描）作兜底防护网**。 |

---

## 3. 目录结构

```
cc-template/
├── manifest.json                      # 同步注册表（单一事实源）
├── sync.js                            # CLI 入口（薄）
├── lib/                               # 可独立测试的内部模块（仍零外部依赖）
│   ├── manifest.js                    #   读取/校验 manifest
│   ├── paths.js                       #   ~ / %USERPROFILE% / $HOME 展开
│   ├── jsonmerge.js                   #   键级合并 + 密钥路径保留
│   ├── secrets.js                     #   capture 脱敏 + 疑似密钥安全扫描
│   ├── diff.js                        #   文件 diff + JSON 语义 diff
│   └── fsutil.js                      #   原子写 + .bak 备份
├── test/
│   └── sync.test.js                   # node:test 内置测试，零依赖
├── configs/
│   ├── settings.template.json         # 脱敏 settings（密钥=占位）
│   ├── keybindings.template.json      # （可选）keybindings 模板
│   └── README.md
├── statuslines/context-usage-bar/
│   ├── statusline.js
│   └── README.md                      # 新增「数据来源/运行依赖」章节
├── skills/<name>/...                  # 自定义 skill（每个一子目录）
├── hooks/                             # 预留：hook 脚本 + 片段
└── README.md                          # 新增「配置同步」总章
```

> 设计说明：`sync.js` 是开发工具，**可测试性优先于单文件**，故拆 `lib/`。"零依赖"指不引入外部 npm 包；本地 `require('./lib/..')` 多文件不违反此原则。

---

## 4. manifest.json schema

```jsonc
{
  "version": 1,
  "items": [
    {
      "id": "statusline",
      "type": "file",                                   // file | dir | json-merge
      "repo": "statuslines/context-usage-bar/statusline.js",
      "target": "~/.claude/statusline.js",
      "description": "上下文+套餐进度条状态栏"
    },
    {
      "id": "settings",
      "type": "json-merge",
      "repo": "configs/settings.template.json",
      "target": "~/.claude/settings.json",
      "secrets": [
        { "path": "env.ZOTERO_API_KEY",  "placeholder": "<填你的 Zotero API Key>",
          "hint": "https://www.zotero.org/settings/keys → New Private Key" },
        { "path": "env.ZOTERO_USER_ID",  "placeholder": "<你的 Zotero numeric userID>",
          "hint": "同页 'Your userID for use in API calls'" }
      ]
    },
    {
      "id": "skill:thesis-zh-delivery",
      "type": "dir",
      "repo": "skills/thesis-zh-delivery",
      "target": "~/.claude/skills/thesis-zh-delivery"
    },
    {
      "id": "keybindings",
      "type": "file",
      "repo": "configs/keybindings.template.json",
      "target": "~/.claude/keybindings.json"
    }
  ]
}
```

字段：
- `id`：唯一标识（skill 用 `skill:<name>` 约定）。
- `type`：`file`（整文件）/ `dir`（整目录）/ `json-merge`（结构合并）。
- `repo`：相对仓库根的源路径。
- `target`：本地目标路径，支持 `~`、`%USERPROFILE%`、`$HOME` 展开。
- `secrets[]`（仅 json-merge）：`path`（点路径）、`placeholder`（repo 存的占位串）、`hint`（去哪取）。

---

## 5. CLI 子命令

| 命令 | 作用 |
|------|------|
| `node sync.js list` | 列出所有项 + 状态：`✓ in-sync` / `≠ differs` / `local-missing` / `repo-missing` |
| `node sync.js diff [id...]` | 只看差异，不改文件（dry-run）；无 id = 全部 |
| `node sync.js apply [id...]` | repo → 本地。展示 diff → 确认（y/N）→ 写入。`--yes` 跳过确认，`--dry-run` 等于 diff |
| `node sync.js capture [id...]` | 本地 → repo。脱敏后写回模板；写前跑安全扫描 |

交互用 Node 内置 `readline`；非交互场景用 `--yes`。

---

## 6. 数据流

### 6.1 apply（repo → 本地，保密钥）

```
读 manifest 项 → 读 repo 模板 + 本地现有文件
  ├ file/dir : 计算 diff → 展示 → 确认 → 备份 target→target.bak → 原子写
  └ json-merge:
       逐 key 计算动作：Added / Changed / Local-only(保留) / Secret(保留本地真值)
       逐项（或整批）diff 展示 → 确认 → 合并写回
       末尾打印「待填密钥」清单：凡本地该密钥路径为空/仍是占位 → 列出 placeholder+hint
```

### 6.2 capture（本地 → repo，剥密钥）

```
读本地文件 → (json-merge: 把每个 secret.path 的真值替换回 placeholder)
  → 【安全扫描】扫描即将写入 repo 的内容里"未声明的疑似密钥"
       命中规则：key 名 ~ /(_KEY|_TOKEN|_SECRET|PASSWORD|CREDENTIAL)/i
                 或 env.* 下高熵长串（len≥20）且不等于任何已知 placeholder
       命中 → 中止，列出路径，要求加进 manifest.secrets 或显式 --force-allow-unredacted
  → 通过 → diff 展示 → 确认 → 写入 repo 模板路径
```

> 不对称要点：**apply 时密钥向本地让步（保留本地真值），capture 时密钥向占位让步（写回占位）**。两个方向都让真值留本地、占位留 repo——这是「模板占位」策略的精确含义。
>
> `--force-allow-unredacted` 故意取长难看的名字，靠人因摩擦防"明知有真密钥还提交"的误操作。

---

## 7. diff 展示

- **file/dir**：优先 `git --no-pager diff --no-index --color <local> <repo>`，失败则退回内置极简行 diff（与 statusline.js「git 优先、失败降级」模式一致）。
- **json-merge**：语义化逐键输出，例如：

  ```
  settings.json (repo→本地):
    + permissions.allow[+2]      新增 2 条规则
    ~ verbose                    false → true
    = env.ZOTERO_API_KEY         [密钥·保留本地]
    · agentPushNotifEnabled      [本地独有·保留]
  ```

---

## 8. 错误处理与安全

- 写入前 `target` → `target.bak`，再**原子写**（临时文件 + rename），中断不留半截文件。
- JSON 解析失败：中止该项并明确报错，绝不写出损坏文件。
- **绝不删除**本地独有的键/文件。
- `capture` 安全扫描默认开启，未通过不写盘。
- 路径展开同时支持 `~`、`%USERPROFILE%`、`$HOME`。

---

## 9. 测试（`node --test`）

零依赖，用 Node 内置 `node:test` + `assert`，临时目录验证：

1. json-merge 保留本地密钥真值、保留本地独有键、采纳 repo 新增键；
2. capture 把声明的密钥剥离回占位；
3. 安全扫描能拦下"未声明的疑似密钥"；
4. diff 状态判定（in-sync / differs / missing）正确；
5. 原子写失败时 `.bak` 可回滚。

---

## 10. README 更新

### 10a. statusline README 新增「数据来源 / 运行依赖」

逐字段说明 statusLine 经 stdin 收到的 JSON 来源：

| 显示项 | 来源字段 | 由谁提供 |
|--------|------|------|
| 模型名 | `model.display_name` | 当前会话选定模型 |
| 目录 | `workspace.current_dir` / `cwd` | 会话工作区 |
| 上下文占用 | `context_window.used_percentage` / `total_input_tokens` / `context_window_size` | Claude Code token 计量（来自 API usage） |
| 本次花费 | `cost.total_cost_usd` | 会话成本（API token×定价） |
| 套餐 5h/7d | `rate_limits.five_hour\|seven_day.{used_percentage,resets_at}` | **仅 Claude.ai Pro/Max 订阅**，来自 API 限流响应头，**首次 API 响应后**才有；API-key/Console 计费用户无此字段 |
| git 分支/dirty | —— 不来自 Claude Code | 脚本自跑 `git status` / 读 `.git/HEAD` |

并明确**安装条件**：① Node.js 在 PATH；② `settings.json` 注册了 `statusLine`；③ 数据靠 Claude Code 的 statusLine stdin 契约（附官方文档链接）；④ 第 3 行出现条件（订阅 + 已有 API 响应）。

### 10b. 顶层 README 新增「配置同步」总章

讲 `sync.js` + manifest + 模板占位密钥模型 + 多设备工作流：

- 新机：clone → `node sync.js apply` → 按提示填密钥。
- 改完：`node sync.js capture` → 提交。

---

## 11. 当前 statusline.js 视觉基线（实现时随设计带入 repo）

本次会话已在本地 `~/.claude/statusline.js` 迭代出新视觉，实现时应把它带入 repo 模板：

- **配色**：黑底高对比——内容文字用亮色系（亮青/亮蓝/亮品红/亮白/亮绿），仅分隔点 `·`、进度条框 `[ ]`、空槽 `░` 用深灰当背景轨道。进度条按占用亮绿/亮黄/亮红。
- **图标**：统一 emoji 族 🤖 模型 · 📁 目录 · 🌿 分支 / 🧠 Context · 💰 花费 / 📊 Usage · ⏳ 倒计时。
- **文案**：`Ctx` → `Context:`；套餐行加前缀 `Usage:`。
- **目录**：显示完整 `cwd` 路径（不再取 basename）。

---

## 12. 不做（YAGNI）

- 不做行级三方合并（合并即"整项覆盖 / 键级取舍"，由 diff 决策）。
- 不做自动定时同步 / 后台守护。
- 不做密钥加密存储（密钥根本不进 repo，无需加密）。
- 不引入任何外部 npm 依赖。
