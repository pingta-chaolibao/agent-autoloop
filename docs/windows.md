# Windows 原生安装与维护

Windows 版本使用本机 Node.js、Windows PowerShell 和 .NET Framework，Agent 直接运行本机已登录的 CLI。需要 Node.js 24 或更新、Git、Windows PowerShell 5.1，以及已经安装并登录的 Codex。这里不需要 WSL。

## 从已提交的代码安装

在 Windows 适配分支的 Git 工作目录运行 `install.ps1`。安装器用 `git archive HEAD` 发布已提交的代码；未提交的文件不会成为运行版本。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 `
  -Repo D:\work\autoloop\worktrees\windows `
  -Root D:\work\autoloop `
  -DataDirectory D:\work\autoloop\data `
  -Agent codex
```

`Repo` 是可信的本地 Git 工作目录；没有填写时沿用 `AGENT_AUTOLOOP_REPO`，再默认使用安装脚本所在目录。`DataDirectory` 没有填写时沿用 `AGENT_AUTOLOOP_HOME`，再默认使用 `Root\data`。重复安装保留已有规则和密钥，只发布指定 HEAD 的程序。

| 位置 | 内容 |
|---|---|
| `Root\releases\<提交>` | 固定版本的运行程序 |
| `Root\active.json` | 命令入口当前使用的版本 |
| `Root\active.previous.json` | 上一次的版本指向 |
| `Root\bin` | PowerShell、cmd 和 Node 命令入口 |
| `DataDirectory` | `config.json`、规则、密钥、SQLite、执行输出与本机辅助程序缓存 |

安装器打印完整的命令路径，不覆盖 PATH 上的其他同名程序，也不修改用户的 PowerShell 配置。以下命令都使用同一个资料目录：

```powershell
& D:\work\autoloop\bin\agent-autoloop.ps1 --version
& D:\work\autoloop\bin\agent-autoloop.ps1 doctor
& D:\work\autoloop\bin\agent-autoloop.ps1 try
```

`try` 会使用自己的模型额度。非交互终端打印问题后退出等待；安装验证可以选择第二项绿色，再查看结果：

```powershell
& D:\work\autoloop\bin\agent-autoloop.ps1 answer <卡片编号> 2
& D:\work\autoloop\bin\agent-autoloop.ps1 status
```

看到“你选了绿色，试跑通过”，才算问答和续办接通。它只证明这个流程；网页任务还要按 [浏览器接入](plugins.md#浏览器接入)核实实际页面与原会话续办。

## 登录后常驻

默认安装会注册当前用户登录时启动的计划任务，并立即启动。任务以普通权限运行；不保存 Windows 密码。系统策略如果禁止注册计划任务，安装会明确报错，不会声称已经常驻。

任务名默认为 `agent-autoloop`；自定义资料目录使用带路径哈希的名字，避免碰到其他安装。任务描述也绑定资料目录，只修改属于本安装的任务。启动窗口隐藏，输出写到 `DataDirectory\logs\up.log`。

```powershell
& D:\work\autoloop\bin\agent-autoloop.ps1 service install
& D:\work\autoloop\bin\agent-autoloop.ps1 service remove
```

当前用户未登录、Windows 休眠或关机时不保证接活。无需常驻、没有任务注册权限或临时验收时，安装加 `-NoService`，然后在终端运行 `up`。临时验收不安装真实服务，不发真实通知。

## 执行与停止

Windows 接单程序使用系统 Job Object 管理一轮的进程树。Agent 在挂起状态加入 Job 后才开始运行；父进程先退出，仍在运行的子进程也算在这一轮里。停止时终止整个 Job，确认进程树结束并保存退出记录后才报告。

接单程序重启后从磁盘恢复任务、进程身份与尚未提交的结果。进程身份包含创建时间，PID 被其他程序复用时不会误停。Windows 没有 POSIX 的 SIGTERM 宽限语义，取消会终止本轮 Job，Skill 里的副作用仍须先核实当前状态。

系统内置 .NET 辅助程序从随版本发布的 `worker/windows-job.cs` 编译到资料目录，以源文件哈希命名；不下载第三方运行时包。资料目录的 Windows ACL 只授予当前用户、SYSTEM 与管理员访问，普通访问密钥仍只在数据库中存哈希。

`command` 应填写可执行文件或 Node 脚本的参数数组。标准 npm `.cmd` 入口会解析成其 Node 入口，提示词不经过 cmd 的变量展开。任意批处理不自动转换为 shell 代码；确实要运行 shell 时，由可信配置明确选择 shell 及其参数。

Codex 使用现有登录和本机原生沙箱，权限档位保持原约定；不会为了安装改成 `full`。本轮资料目录作为附加目录交给 Codex。后台 `codex exec` 的浏览器工具仍须单独确认。

Windows 默认桌面通道在交互会话中显示通知，通过命令行回答；无交互桌面时安静跳过。文字通过 JSON 标准输入送给通知程序，不拼接到 PowerShell 代码中。飞书继续使用已经配置的 CLI；不要给同一个应用额外启动第二个监听。

## 规则与更新

`cwd` 接受 `D:\projects\app`、`D:/projects/app`、UNC 绝对路径及 `~/`。`D:relative` 和单个反斜杠开头的相对目录不接受。规则热更新、回答、回执和 HTTP 协议沿用现有约定。

Windows 的 `agent-autoloop update` 发布安装记录中本地 Git 工作目录的已提交 HEAD。上游更新先在 `sync/*` 分支合并到 `windows`，确认后再更新本机；不会在运行目录直接拉取上游。每日自动同步不包含在安装里。

```powershell
& D:\work\autoloop\bin\agent-autoloop.ps1 update
```

保留以前的发布目录用于回退。程序回退与数据库恢复分开处理；涉及格式变化时先确认兼容性，备份同时保留 `hub.db` 和 `master.key`。运行中的 SQLite 使用一致性备份方式。

## 卸载

```powershell
& D:\work\autoloop\bin\agent-autoloop.ps1 uninstall
```

终端确认后才卸载，非交互终端可加 `--yes`。只停止本安装、删除带有本安装身份的入口与发布副本，始终保留资料目录、源码工作目录和其他文件。

## 开发检查

`npm test`、`npm run test:quick`、`npm run typecheck`、`npm run format:check` 都可从 Windows 工作目录运行。测试入口按平台选择：POSIX Shell 安装和进程场景保留在 Linux/macOS，Windows 使用 `tests/windows*.test.ts` 覆盖原生进程、问答、热更新、安装及卸载；通用内核和协议规格照常执行。`test:quick` 仅省略模拟与穷举。

README 中的性能数字与预算来自作者的 Apple M5 Pro。Windows 使用相同的正确性约定，性能需在自己的机器上测量。
