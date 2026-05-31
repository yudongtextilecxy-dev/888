# 美股投资三指标仪表盘 · Vercel 稳定部署版

这个版本把数据读取放到 Vercel 后端函数 `/api/market` 中完成，前端网页只请求同域接口，避免本地 HTML 直接访问 Yahoo / Stooq / FRED 时遇到跨域限制和公共代理不稳定。

## 文件结构

- `index.html`：前端仪表盘页面，已适配网页和 iPhone。
- `api/market.js`：Vercel Serverless Function，负责读取 VIX、FRED 利率、标普500日线并计算年内回撤。
- `package.json`：Vercel 项目基础配置。

## 部署方法

1. 新建一个 GitHub 仓库。
2. 把本文件夹里的全部文件上传到仓库根目录。
3. 打开 Vercel，选择 Add New Project。
4. 导入这个 GitHub 仓库。
5. Framework Preset 选择 Other 或默认即可。
6. Build Command 留空。
7. Output Directory 留空。
8. 点击 Deploy。

部署完成后，打开 Vercel 给你的网址即可使用。

## 为什么会更快

前端不再直接跨域访问外部数据源，而是访问同域 `/api/market`。Vercel 后端函数读取数据后会设置缓存：

- `s-maxage=300`
- `stale-while-revalidate=1800`

所以多次打开通常会比本地 HTML + 公共代理快很多。
