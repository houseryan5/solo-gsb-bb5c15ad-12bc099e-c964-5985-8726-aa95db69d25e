# 地震台站到时拾取审阅台

FastAPI + SQLite + 原生 TypeScript（Canvas）构建的单页应用，用于审阅多台站波形上的 **P/S 到时拾取**：
导入带时间戳的波形采样 JSON，按台站绘制可缩放波形；在波形上添加带 ±不确定窗的 P/S 到时；
系统按**区间重叠规则**自动识别冲突，并给出每组事件的**加权共识到时**；可逐条接受 / 拒绝 / 撤销，
最终导出完整审阅结果。

## 一键启动（Docker Compose）

```bash
docker compose up --build
```

打开 <http://localhost:8000>，点击 **「载入演示数据」** 即可体验（内置 4 台站 × 3 道、
含 3 名分析者的 P/S 拾取及刻意构造的冲突）。

SQLite 数据库保存在命名卷 `seismic-data` 中，容器重建后数据保留。
停止服务：`docker compose down`（加 `-v` 同时删除数据卷）。

## 本地开发（无 Docker）

```bash
# 后端
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# 前端（另开终端，esbuild 监听构建到 backend/static/app.js）
cd frontend
npm install
npm run watch
```

## 导入数据格式

顶栏 **「导入 JSON」** 上传文件，或直接使用 `examples/sample-waves.json`。

### 扁平结构

```json
{
  "name": "event 1",
  "traces": [
    {
      "network": "NET",
      "station": "STA01",
      "channel": "HHZ",
      "start_time": "2026-09-22T00:00:00Z",
      "sample_rate": 100.0,
      "samples": [0.01, 0.02, "..."]
    }
  ],
  "picks": [
    {"station": "STA01", "phase": "P", "time": "2026-09-22T00:00:02.000Z",
     "uncertainty": 50, "weight": 1.0, "source": "analyst-a"}
  ]
}
```

### 嵌套结构（按台站分组）

```json
{
  "name": "event 2",
  "stations": [
    {"network": "NET", "station": "STA01",
     "traces": [{"channel": "HHZ", "start_time": "...", "sample_rate": 100,
                 "samples": []}],
     "picks": [{"phase": "P", "time": "...", "uncertainty": 50}]}
  ]
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `start_time` / `time` | ISO-8601（支持 `Z` 与 `+08:00` 偏移）或 **epoch 毫秒**数字 |
| `sample_rate` | 采样率 Hz，必须 > 0；道结束时间 = `start + (n-1)/sr` |
| `samples` | 非空数值数组（微秒级波形振幅，顺序即采样顺序） |
| `phase` | `P` 或 `S`（小写也可） |
| `uncertainty` | 对称不确定窗半宽，**毫秒** |
| `weight` | 可选，拾取权重，默认 1.0（须 > 0） |
| `source` | 可选，分析者 / 检测器名称 |

## 审阅规则

对每个 **(台站, 震相)** 分组，将候选拾取表示为区间 `[t−u, t+u]`：

1. **重叠规则**：`|t₁−t₂| ≤ u₁+u₂` 的两个拾取一致；一致性经传递闭包形成簇
   （A≈B、B≈C 则 A、B、C 同簇，即使 A 与 C 的窗口不直接接触）。
2. **冲突**：同组出现多个簇即为冲突；离群簇在波形和审阅面板中标为黄色，
   所有**跨簇且不重叠**的拾取对在导出结果中逐条列出。
3. **加权共识**：簇内每条拾取的复合权重为 `cᵢ = weightᵢ / (uᵢ + 1ms)`
   （窗口越窄、权重越高贡献越大）。共识到时为加权均值，
   不确定度为加权标准差除以有效样本量平方根（单条簇直接采用其窗口）。
4. 被**拒绝**的拾取不参与聚类与共识，在界面上灰显且可随时恢复。

## 交互说明

| 操作 | 效果 |
| --- | --- |
| 鼠标滚轮 | 以光标位置为锚点缩放波形 |
| 右键拖拽 / Shift+拖拽 / 中键拖拽 | 平移时间窗 |
| 左键点击波形空白处 | 在该时刻添加当前震相（P/S）的拾取 |
| 左键拖拽标记 | 调整到时（防抖自动保存） |
| 双击标记 | 删除该拾取（需确认） |
| 点击标记 / 面板条目 | 选中并在底部编辑到时、±窗口、权重 |
| 「接受」/「接受共识」 | 生成已审阅到时（手动 / consensus 两种来源） |
| 「撤销」 | 删除已接受记录，候选拾取仍保留 |
| 「拒绝」/「恢复」 | 排除或重新纳入某条候选拾取 |
| 「导出审阅结果」 | 下载 JSON（见下） |

## 导出内容

`GET /api/datasets/{id}/export` 返回：

- `accepted_arrivals`：已接受到时（逐条手动 + 共识，含 `method`、绝对/相对窗口、来源 pick/cluster）；
- `candidate_picks`：全部候选拾取（含所属簇、是否离群）；
- `rejected_picks`：被拒绝的拾取；
- `conflict_groups` / `conflict_pairs`：仍存在多簇的分组与全部跨簇不重叠对。

## REST API 速览

```
GET    /api/datasets                         数据集列表
POST   /api/datasets/import                  导入波形 JSON（body 即文件内容）
POST   /api/datasets/demo                    生成内置演示数据
GET    /api/datasets/{id}                    元数据 + 波形采样 + 拾取 + 已接受
GET    /api/datasets/{id}/analysis           聚类 / 冲突 / 加权共识
GET    /api/datasets/{id}/export             导出审阅 JSON
DELETE /api/datasets/{id}                    删除数据集
POST   /api/datasets/{id}/picks              新增拾取
PATCH  /api/datasets/{id}/picks/{pid}        修改时间/窗口/权重/震相
POST   /api/datasets/{id}/picks/{pid}/reject
POST   /api/datasets/{id}/picks/{pid}/restore
DELETE /api/datasets/{id}/picks/{pid}
POST   /api/datasets/{id}/reviews            接受（manual / consensus）
DELETE /api/datasets/{id}/reviews/{rid}      撤销接受
```

## 项目结构

```
├── Dockerfile                # 多阶段构建：node 构建前端 → python:3.12-slim 运行
├── docker-compose.yml        # 一条命令启动（:8000，SQLite 持久化卷）
├── backend/
│   ├── app/
│   │   ├── main.py           # FastAPI 路由
│   │   ├── consensus.py      # 区间重叠聚类 + 加权共识
│   │   ├── importer.py       # 两种 JSON 形态导入与校验
│   │   ├── database.py       # SQLite schema / 连接管理
│   │   ├── crud.py           # 数据持久化
│   │   ├── demo.py           # 合成演示事件
│   │   ├── time_utils.py     # epoch ms / ISO-8601 互转
│   │   └── config.py
│   ├── static/               # index.html / styles.css / app.js(构建产物)
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── main.ts           # 状态编排与控件绑定
│   │   ├── waveform.ts       # Canvas 波形渲染、缩放、拾取标记与拖拽
│   │   ├── panel.ts          # 审阅面板（簇、共识、接受/撤销）
│   │   ├── api.ts / types.ts / time.ts
│   ├── esbuild (package.json) └─ tsconfig.json
└── examples/sample-waves.json
```

## 技术说明与边界

- 所有时间内部统一存储为 **epoch 毫秒**，接口/导出附 ISO-8601（UTC）字符串。
- 波形按像素桶做 **min/max 抽稀**，3000 样点/道也能流畅缩放；30 s 演示段直接全量保留。
- 前端无框架、无 UI 库，构建仅用 esbuild 打包（产物 24 KB）。
- 应用定位为单机 / 内网审阅工具，未内置鉴权；如需公网部署请置于反向代理之后。
