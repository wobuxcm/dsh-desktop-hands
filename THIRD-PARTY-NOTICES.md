# 第三方组件声明

本插件自身代码与第三方组件分开授权，别混。

**本插件为社区独立项目，与 Vercel Labs 无隶属、合作或背书关系。** 不使用其名称、标识作推广用途。

## agent-desktop

- **来源**：Vercel Labs — https://github.com/vercel-labs/agent-desktop
- **许可**：Apache License 2.0（全文见 `LICENSES/Apache-2.0.txt`）
- **使用方式**：**未修改**，以独立进程调用（`child_process.spawn`），不链接、不静态嵌入、不打包进 JS。
- **随附版本**：`package.json` 的 `dependencies` 中声明的版本即实际使用版本（当前 1.2.0）。
- **上游包内没有 LICENSE 文件**，仅 `package.json` 声明 `"license": "Apache-2.0"`。本仓库因此自行附上许可证全文，以满足 Apache-2.0 第 4 条（分发时须随附许可证副本）。

若分发时选择了“随包附带二进制”的方式（把 `agent-desktop.exe` 放进 `bin/`），上述许可证副本**必须**一并保留。

## 本插件自身代码

`index.js`、`lib/cli.js`、`cordis.patch.yml`、`README.md` 采用 MIT 许可，见根目录 `LICENSE`。
如需改为其他许可，改 `package.json` 的 `license` 字段并替换 `LICENSE` 文件即可，与本声明无关。
