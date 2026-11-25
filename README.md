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

按钮从公开的 `codex/cloudflare-workers` 分支读取模板。选择自己的 Cloudflare 账户，启用 R2，分别为 `SESSION_SECRET` 和 `SETTINGS_KEY` 提供独立随机密钥，每个至少 32 字节。这两个 Worker 密钥需要长期保留。模板会申请 D1、R2、Queue 和 Durable Object。

### 在 Cloudflare 控制台设置首个管理员

1. 新站发布后，进入 **Workers & Pages → 站点对应的 Worker → Settings → Variables and Secrets**。
2. 点击 **Add**。添加 `JOIASK_INITIAL_ADMIN_USERNAME`，类型选 **Text**，填入自选管理员名。若希望在控制台隐藏用户名，也可选 **Secret**。再添加 `JOIASK_INITIAL_ADMIN_PASSWORD`，类型选 **Secret**，填入自选密码。点击 **Deploy**。
3. 打开站点的 `/admin/`，用上述用户名和密码登录。首次登录成功后，可从同一设置页移除这两项并再次点击 **Deploy**。以后继续使用已创建的账号登录。

这两项仅用于新站首次创建超级管理员。用户名选 Text 时，普通访客也无法从站点读取这个变量。已有站点可以通过[管理员 CLI](./docs/content/guide/administrators.mdx) 恢复账号。

### 命令行部署

**更新已有站点。** 在已安装依赖、已登录 Wrangler 的仓库根目录执行以下命令。将 `my-joiask` 换成部署时使用的 Worker 名称。

```sh
npm run deploy -- --name my-joiask
```

部署命令会完成构建和 D1 迁移。目标 Worker 已配置 `SESSION_SECRET` 和 `SETTINGS_KEY` 时，首次发布本项目和后续更新都可以沿用面板里的密钥。使用默认名称 `joiask` 的站点直接运行 `npm run deploy` 即可。

**首次部署新站。** 使用 Node.js 24，在仓库根目录执行 `npm ci`。交互式部署前，通过 `npx wrangler login` 登录目标账号。自行准备两个独立的随机密钥，每个至少 32 字节。在本地 `.dev.vars.production` 文件中分别填写 `SESSION_SECRET` 和 `SETTINGS_KEY`，然后发布。[密钥文件格式](./docs/content/guide/deployment.mdx)

```sh
npm run deploy -- --name my-joiask --secrets-file .dev.vars.production
```

发布成功后，按上面的控制台步骤设置首个管理员。提问箱位于 `/`，管理后台位于 `/admin/`，文档位于 `/docs/`。站长可在后台配置通用 SMTP 和兼容 Chat Completions 的审核服务。会员通过 B 站公开个性签名验证 UID，验证成功即可恢复原签名。

默认从 B 站原生名片接口读取资料。使用自建反代时，超级管理员在后台「设置」填入完整接口地址（例如 `https://bili.example.com/card`），Worker 会自动附上 `mid` 查询参数。[配置说明](./docs/content/guide/configuration.mdx)

同一个 Cloudflare 账号安装多个站点时，为每个实例选择独立的 Worker 名称。例如在部署命令中加入 `--name my-ask`，管理命令也使用 `--remote --name my-ask`。通过按钮定制了资源名称的站点，请在按钮创建的仓库副本中执行运维命令，以便读取该站点的绑定。

### 本地开发

```sh
npm ci
npm run dev
```

本地运行使用独立资源。要单独构建完整站点，在仓库根目录执行 `npm run build`。本地管理员的创建方式见[快速开始](docs/content/guide/quick-start.mdx)，测试命令见[开发指南](CONTRIBUTING.md)。

## 参与开发

- [开发环境与贡献指南](CONTRIBUTING.md)
- [开发指南](docs/content/development.mdx)
- [提交问题或建议](https://github.com/powerlive-io/JoiAsk/issues)

## 许可证

[MIT](LICENSE)
