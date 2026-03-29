# Codex 助手插件分发包

这是一个可直接分发给别人的 Obsidian 插件包。

## 包内内容

- `codex-agent/`
  Obsidian 插件目录，可直接复制到 vault
- `install_plugin.ps1`
  Windows 一键安装脚本
- `README.md`
  当前说明文件

## 对方电脑的使用前提

这个插件默认走本地 `Codex CLI`，所以对方电脑还需要：

1. 安装 `Obsidian Desktop`
2. 安装 `Codex CLI`
3. 在本机完成 `codex login`

也就是说：

- 插件本身可以直接发给别人
- 但如果对方电脑没有安装并登录 `Codex CLI`，插件不能真正运行

## 安装方法

### 方法 1：运行安装脚本

在 PowerShell 里进入当前分发包目录，执行：

```powershell
.\install_plugin.ps1 -VaultPath "D:\你的Obsidian库"
```

### 方法 2：手动复制

把 `codex-agent` 文件夹复制到：

```text
<你的Vault>\.obsidian\plugins\
```

最终目录应为：

```text
<你的Vault>\.obsidian\plugins\codex-agent
```

## 在 Obsidian 中启用

1. 打开 Obsidian
2. 进入 `设置 -> 第三方插件`
3. 点击 `重新加载插件`
4. 启用 `Codex 助手`

## 推荐设置

进入：

```text
设置 -> Codex 助手
```

推荐：

- `运行模式`：`直接 CLI`
- `Codex CLI 路径`：留空，先尝试自动检测

如果自动检测失败，在 Windows 上可手动填写：

```text
C:\Users\<你的用户名>\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js
```

## 验证 Codex CLI 是否可用

在终端里运行：

```powershell
cmd /c codex.cmd exec --skip-git-repo-check "Reply with exactly OK."
```

如果这条命令不能正常返回，就先修好本机 `Codex CLI` 的安装或登录状态。
