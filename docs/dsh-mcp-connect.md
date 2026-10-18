# 把内核接进 DSH：MCP 连接配方

时间 2026-10-18。回答「这个项目是工作台还是插件」。

**是独立的 Python 项目，不是 DSH 插件。** DSH 通过 MCP stdio 调用它，连接由一个
**配置型 bundle** 声明——没有 JavaScript 运行时，只有 patch、locale、icon 三样东西。

---

## 一、装什么

本机 bundle 在 `bundle-typhoeus-mcp/`，**已 gitignore**（原因见第四节）。

| 文件 | 作用 |
|---|---|
| `package.json` | 声明 `dsh.bundle.patch`，无 Host/Client 入口 |
| `cordis.patch.yml` | 插入 `@deepseek-ai/dsh-mcp-client` 一行 |
| `locale/{en,zh}.json` | 插件管理器里显示的标题与描述 |
| `icon.svg` | 条目图标 |

## 二、patch 长这样（换机器只改三个路径）

```yaml
- insert:
    - id: mcp-typhoeus
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: typhoeus
        transport: stdio
        command: typhoeus-mcp            # pip/pipx 装好本包后在 PATH 上
        args: []
        env:
          TYPHOEUS_HOME: '<放 data/ 与 out/ 的目录>'   # 不设则回落 ~/.typhoeus
          PYTHONUTF8: '1'
          PYTHONIOENCODING: 'utf-8'
        failOnStartupError: true
        toolCallTimeoutMs: 120000
```

`env` 的编码两行不是装饰：Windows 下子进程 stdout 走管道默认用 ANSI 代码页，
中文读数会变成 mojibake。

**patch 里不再出现任何绝对解释器/仓库路径**：换机器只要
`pipx install typhoeus`，再把 `TYPHOEUS_HOME` 指向放数据与产物的目录。

## 三、装与验

```bash
# 在 DSH 会话里
plugin_manager action=install_bundle target=<bundle 绝对目录>
```

三个验收动作：

1. 工具表出现 9 个 `mcp__typhoeus__*`（8 个一份产物一个工具 + `get_point_depth`）
2. `mcp__typhoeus__get_health_report` 返回 `config_hash` 与 caveat
3. `mcp__typhoeus__get_point_depth(lon=121.15, lat=30.03)` 返回 `[R1] … 处理办法：改问域内点位`

停用或移除：`plugin_manager action=set_bundle enabled=false`，或 `remove_bundle`。

## 四、为什么 bundle 不入库

它绑本机路径：python 解释器、仓库绝对位置、输出物目录。入库等于把一台机器的
路径写进提交物，换台机器就装不上。入库的是这份配方，bundle 本身按第二节重建。

改内核代码不会自动生效——MCP server 是独立进程，改完要重启连接
（`set_bundle` 关再开，或重启 DSH）。
