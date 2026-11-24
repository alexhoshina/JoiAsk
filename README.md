<p align="center">
  <img src="docs/public/favicon.png" alt="JoiAsk logo" width="128" height="128" />
</p>

<h1 align="center">JoiAsk 提问箱</h1>

<p align="center">
  可自行部署的开源提问箱，方便收集和展示观众提问。<br />
  支持话题分类、图文投稿、内容审核与卡片归档。
</p>

<p align="center">
  <a href="docs/content/guide/quick-start.mdx">Workers 安装指南</a> ·
  <a href="https://ask.vjoi.cn/">在线示例</a>
</p>

> [!IMPORTANT]
> **JoiAsk 属于 PowerLive 项目组。**
>
> 欢迎访问 **[PowerLive 官网 →](https://powerlive.io/)**，了解更多项目。

## 界面预览

<p align="center">
  <img src="docs/public/screenshot.png" alt="JoiAsk 提问箱界面预览" width="960" />
</p>

## Cloudflare 部署

这个分支从空数据库部署 JoiAsk。一个 Worker 提供提问箱、管理后台和文档，D1 保存业务数据，R2 保存图片，Durable Objects 负责实时互动，Queues 负责异步审核。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fpowerlive-io%2FJoiAsk%2Ftree%2Fcodex%2Fcloudflare-workers)

按钮从公开的 `codex/cloudflare-workers` 分支读取模板。选择自己的 Cloudflare 账户，启用 R2，分别为 `SESSION_SECRET` 和 `SETTINGS_KEY` 提供独立随机密钥，每个至少 32 字节。模板会申请 D1、R2、Queue 和 Durable Object。部署完成后，通过下面的 CLI 创建首个超级管理员。

### 命令行部署

使用 Node.js 24，在仓库根目录安装依赖。首次部署先生成本地私密文件并确认 Wrangler 登录的是目标 Cloudflare 账户。保管好密钥，后续部署沿用相同值。

```sh
npm ci
npx wrangler login
node -e "const {randomBytes}=require('node:crypto'); const key=()=>randomBytes(32).toString('hex'); require('node:fs').writeFileSync('.dev.vars.production', 'SESSION_SECRET='+key()+'\nSETTINGS_KEY='+key()+'\n', {flag:'wx',mode:0o600})"
npm run deploy -- --secrets-file .dev.vars.production
```

管理员密码从标准输入读取。安装仓库和远程 Worker 要使用相同的 D1 绑定配置。在 PowerShell 7 中执行：

```powershell
Read-Host -MaskInput '管理员密码' | node scripts/admin.mjs --remote create operator
```

在 Bash 中执行：

```sh
read -rs -p "管理员密码: " pass
printf '%s\n' "$pass" | node scripts/admin.mjs --remote create operator
unset pass
```

打开站点的 `/`、`/admin/` 和 `/docs/`。在后台按需启用通用 SMTP、配置兼容 Chat Completions 的模型服务。会员通过 B 站公开个性签名验证 UID，验证成功即可恢复原签名。

默认从 B 站原生名片接口读取资料。使用自建反代时，超级管理员在后台「设置」填入完整接口地址（例如 `https://bili.example.com/card`），Worker 会自动附上 `mid` 查询参数。[配置说明](./docs/content/guide/configuration.mdx)

同一个 Cloudflare 账号安装多个站点时，为每个实例选择独立的 Worker 名称。例如在部署命令中加入 `--name my-ask`，管理命令也使用 `--remote --name my-ask`。通过按钮定制了资源名称的站点，请在按钮创建的仓库副本中执行运维命令，以便读取该站点的绑定。

### 本地开发

```sh
npm ci
npm run dev
```

本地运行使用独立资源。将管理员命令中的 `--remote` 换成 `--local` 即可初始化开发账号。测试、构建和运维命令见[开发指南](CONTRIBUTING.md)和[管理员指南](docs/content/guide/administrators.mdx)。

## 参与开发

- [开发环境与贡献指南](CONTRIBUTING.md)
- [开发指南](docs/content/development.mdx)
- [提交问题或建议](https://github.com/powerlive-io/JoiAsk/issues)

## 许可证

[MIT](LICENSE)
