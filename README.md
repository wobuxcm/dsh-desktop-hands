# dsh-desktop-hands

> **非官方插件。** 本项目由社区独立开发，与 Vercel Labs 无隶属关系，也未获其背书。
> 它调用 [agent-desktop](https://github.com/vercel-labs/agent-desktop)（Apache-2.0）的**未修改**二进制，
> 以独立进程方式运行；“agent-desktop” 仅为描述所依赖作品的名称，不表示任何官方关联。

把 [agent-desktop](https://github.com/vercel-labs/agent-desktop) 的桌面操作能力接进 DeepSeek Harness。
六个工具，一条链路：**诊断 → 快照 → 拿 ref → 操作 → 再快照校验**。

本插件只做“接线”，真正的桌面操作由 agent-desktop 的本地二进制完成，两者以独立进程调用，互不侵入。

## 它做什么

| 工具 | 干什么 | 什么时候用 |
|---|---|---|
| `desktop_status` | 平台、权限状态（辅助功能/屏幕录制/自动化）、CLI 版本、本机支持的 surface、状态根 | **首次使用，或动作莫名失败时先跑它** |
| `desktop_app` | 列应用/窗口，启动、关闭、聚焦、缩放、最小化 | 还不知道目标应用叫什么时先问它 |
| `desktop_snapshot` | 把应用的无障碍树读成 JSON，每个可操作元素带 `@ref` | 每次操作前；默认骨架模式省 token |
| `desktop_find` | 按角色/名称/文本搜元素，直接拿 ref | 已知要找什么，比全量快照便宜 |
| `desktop_read` | 读某个 ref 的属性或状态 | 校验结果，不改 UI |
| `desktop_act` | 点击、输入、按键、设值、选择、滚动、勾选…… | 真正动手的那一步 |

## 三条铁律（工具描述里也写了，模型会读）

1. **ref 会过期。** 界面一变就失效，返回 `STALE_REF` / `AMBIGUOUS_TARGET` 时**重新快照**，不要重复同一个调用。
2. **快照先骨架。** 默认 `skeleton=true`，看全貌后再用 `root=<ref>` 展开某一个区域。
3. **能语义就别物理。** 默认 headless，不动鼠标、不抢焦点；只有 `headed=true` 才走真实键鼠（`double-click`、`hover`、坐标类操作必须开）。

## 安装（第一次装这个插件的人看这段）

### 前提

| 需要 | 版本 | 说明 |
|---|---|---|
| DeepSeek Harness | 能加载 `link:` 本地插件即可 | 在 DSH 0.1.5 一代验证过 |
| Node.js | ≥ 18 | 跑 CLI 与插件宿主侧都够用 |
| agent-desktop | 任意 1.x | 由 `dependencies` 自动装；也可自行 `npm i -g` 后用 `AGENT_DESKTOP_BIN` 指过去 |

### 方式 A（推荐）：一条命令

```sh
dsh plugin --profile <profile> add github:wobuxcm/dsh-desktop-hands
```

DSH 会自己克隆、装依赖、挂到 profile。重启 DSH 后新会话里应能看到六个工具。

> 首次安装会拉约 30 MB 依赖（agent-desktop 含各平台二进制）。
> 若 pnpm 提示 `allowBuilds` 阻止构建，**可以忽略**：本插件直接调用平台 exe，
> 不依赖 agent-desktop 的 install 脚本产物，功能不受影响。

### 方式 B：手工挂载（离线，或要改源码时）

```bash
# 1. 放好目录（路径随意，别放进 DSH 的 profiles 里面）
cd <插件目录>

# 2. 装出那只“手”（约 30 MB，含各平台二进制）
npm install --omit=dev

# 3. 挂到 profile，两处改动：
#    a) <DSH_HOME>/profiles/<profile>/package.json 的 dependencies 里加
#       "@local/dsh-desktop-hands": "link:<插件目录绝对路径>"
#    b) 同文件 dsh.profile.bundles 数组里加 "@local/dsh-desktop-hands"
#    c) 在 <profile>/node_modules/@local/ 下建立指向插件目录的目录联接
#       Windows:      mklink /J "<profile>\node_modules\@local\dsh-desktop-hands" "<插件目录>"
#       macOS/Linux:  ln -s "<插件目录>" "<profile>/node_modules/@local/dsh-desktop-hands"
```

重启 DSH，新会话里问「你有哪些 desktop 开头的工具」，应看到六个。

> 也可以先试 `dsh plugin --profile <名字> add <插件目录>` 让 DSH 自己接；这条路径**未验证**，失败就退回上面的手工三步。

### 装在哪、占多少

| 东西 | 位置 |
|---|---|
| 插件本体 | `<插件目录>`（自身代码约 40 KB） |
| CLI 二进制 | `<插件目录>/node_modules/agent-desktop/bin/`（约 30 MB，含全部平台） |
| 运行状态 | `<DSH_HOME>/agent-desktop-state`，用 `AGENT_DESKTOP_STATE_ROOT` 可改 |

不写注册表、不改 PATH、不装全局包。只留 Windows x64 那一份可再省约 23 MB：

```bash
# 仅 Windows x64：保留 *win32-x64.exe，删掉其余平台二进制
rm <插件目录>/node_modules/agent-desktop/bin/agent-desktop-{darwin,linux}*
rm <插件目录>/node_modules/agent-desktop/bin/*win32-arm64*
rm <插件目录>/node_modules/agent-desktop/bin/*macos-helper*
rm <插件目录>/node_modules/agent-desktop/bin/*linux-clipboard-owner*
```

## 配置

| 环境变量 | 作用 |
|---|---|
| `AGENT_DESKTOP_BIN` | 指定 CLI 路径（默认用包内二进制） |
| `AGENT_DESKTOP_STATE_ROOT` | 状态根目录（默认 `<DSH_HOME>/agent-desktop-state`） |
| `AGENT_DESKTOP_SESSION` | 会话命名空间；不设就是默认命名空间 |
| `DSH_HOME` | 沿用 DSH 自己的 |

## 卸载

1. 删 `profiles/<profile>/package.json` 里 `@local/dsh-desktop-hands` 那一项，以及 `dsh.profile.bundles` 里对应的一行；
2. 删 `profiles/<profile>/node_modules/@local/dsh-desktop-hands`（目录联接，删联接不动本体）；
3. 想彻底清，再删插件目录与 `<DSH_HOME>/agent-desktop-state`。

只想去掉工具、保留文件：把 `cordis.patch.yml` 里 `agent-desktop` 那两行整段删掉即可。

## 已知限制

- **只能操作暴露无障碍信息的应用。** 完全不暴露 UIA 的老软件会得到空树或 `PLATFORM_NOT_SUPPORTED`，这不是插件的问题。
- **`launch` 在应用已运行时可能挂住。** 先 `desktop_app action=list-apps` 看看，在跑就别 launch。
- **Windows 某些控件不接受语义输入**（例如新版记事本的编辑区），`type` 会返回 `POLICY_DENIED`，此时加 `headed=true`。
- **快照体积有上限。** 超过 16 万字符会丢掉树、只回摘要，避免一次调用吃掉上下文。
- **插件能操作整台桌面。** 装上它就等于给宿主进程一份“能点任何窗口”的权限；分享给别人时，给的是同等权力。

## 平台差异

| 平台 | 需要什么 | 关键注意 |
|---|---|---|
| **Windows** | Win10 1809+ / Server 2019+，必须是当前登录用户的交互式桌面会话 | `type`、`right-click`、`double-click`、`triple-click`、`focus` **必须带 `headed=true`**（走 SendInput / 需要焦点），严格 headless 会返回 `POLICY_DENIED`。最小化的窗口所有元素都报 `offscreen`，先 `desktop_app action=restore` 再快照。**没有权限弹窗**，`permissions` 报 `automation: not_required`；提权窗口（UIPI）会拒绝输入。System32 / Windows 目录下的程序可直接用名字 `launch`，其他位置要绝对路径 |
| **macOS** | 13+ | 需要在「系统设置 → 隐私与安全性 → 辅助功能」里授权终端 / DSH。用 `permissions --guide` 查看状态。另外需要屏幕录制权限才用得上截图类能力 |
| **Linux** | Ubuntu 24.04+，需要图形会话 + AT-SPI | 无图形会话时只能拿到 `PLATFORM_NOT_SUPPORTED`。能力面比另两个平台窄 |

另有一条与平台无关的：**Chromium / Electron 应用的树要“等它稳定”**，刚打开时读出来很浅。遇到空树先加大 `timeoutMs`，别急着判定没有元素。

## 许可

- 本插件代码：MIT，见 `LICENSE`。
- 依赖的 agent-desktop：Apache-2.0，全文见 `LICENSES/Apache-2.0.txt`，归属见 `THIRD-PARTY-NOTICES.md`。分发时两份都要带上。
