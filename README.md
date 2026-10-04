# 微博投票监测与网站

`vote_monitor.py` 从 HAR 文件中提取 `GET https://huodong.weibo.cn/vote/aj_index`，自动翻页读取全部候选人，并更新：

- `data/vote_history.csv`：每次采集一行，按候选人项目 ID 保存票数。
- `outputs/weibo_vote_monitor_20261004/weibo_vote_tracker.xlsx`：当前完整排名、前 20 名条形图和历史票数。
- `outputs/weibo_vote_monitor_20261004/current_top20.png`：当前前 20 名条形图。

手动采集一次：

```bash
/usr/bin/python3 vote_monitor.py --har /Users/rick/Downloads/api.weibo.cn_2026_10_04_17_17_11.har
```

Codex 中的“微博投票每半小时记录”自动化每 30 分钟执行一次。HAR 中含登录凭证，请勿公开分享；如果凭证过期，重新抓取 HAR 后更新自动化中的文件路径。

## 网站

`docs/` 是 GitHub Pages 静态看板，显示当前排名、30 分钟与 24 小时增量、每小时增长速度和候选人历史趋势。

线上地址：https://rick-png-del.github.io/weibo-vote-tracker/

GitHub Actions 工作流 `.github/workflows/update-and-deploy.yml` 在每小时第 17、47 分钟运行 `scripts/fetch_votes.py`，把新快照保存到 `docs/data/history.json` 后重新发布网站。网页本身是静态文件，历史数据会随每次工作流发布更新；浏览器每 5 分钟检查一次新版本。认证请求保存在 GitHub Actions Secret `WEIBO_REQUEST_JSON`，不会提交到仓库。

GitHub 的定时工作流最短间隔为 5 分钟，但高峰期可能延迟。这里选择 30 分钟，兼顾更新速度、提交数量和数据文件增长。公有仓库使用标准 GitHub 托管运行器不计 Actions 分钟费用。
