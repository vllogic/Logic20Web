# Logic20Web 维护交接（handoff）

本文给接手维护者：项目要点、已完成的 Logic20 支持、关键坑、测试方式和 TODO。
最后更新：2026-11-14，对应 `main` 的 `c20a354` 之后。

---

## 1. 项目是什么

`Logic20Web`（对外显示名 `logic20web`）是一个纯浏览器的逻辑分析仪 / 混合信号查看器：

- 通过 **WebUSB** 连接 VLLogic Logic20（20 lane，UHSIF v2.2，channel-major）。
- 保留对 Sipeed SLogic16/32 U3 的支持（interleaved，走 Worker 传输）。
- 采集、存储、波形绘制、协议解码全部在本地浏览器里完成，无账号、无云端。
- 支持打开/保存 `.sr`（sigrok/PulseView）与 `.lwcap`；支持 sigrok 解码器（Pyodide）。
- 是一个 PWA：Service Worker 预缓存 shell，支持离线；升级需要用户点击（不自动 `skipWaiting`）。

远端仓库：`git@github.com:vllogic/Logic20Web.git`（分支 `main`）。
上游来源：Sipeed 的 slogicweb / tralamazza 的 logicweb。

---

## 2. 目录与关键文件

```
src/device/vllogic.ts            Logic20 WebUSB 传输、并发读取泵、首块校验、drop/seq 上报
src/device/vllogicProtocol.ts    UHSIF v2.2：CRC、LUT、通道映射、parser、div/阈值
src/device/profiles.ts           Logic20 / SLogic profile、速率上限
src/device/vllogicSelftest.ts    Logic20 离线自检（16 项）
src/device/bench/                真实硬件评估页（不参与生产构建）
src/data/planarStore.ts          channel-major 位平面存储 + min/max pyramid
src/data/bitplane.ts             BitPlane（writeWords 快路径）
src/data/channelMajorCoalescer.ts 120 Hz 合并提交
src/data/channelMajorCoalescerSelftest.ts
src/ui/app.ts                    采集主流程；startChannelMajor 接入、captureCoalescer
src/ui/pwaUpdate.ts              SW 注册、升级图标、升级提示卡（3 s 自动收起）
src/ui/locales/{en,zh-CN,fr,ru}.ts 四语言文案
src/diagnostics.ts               诊断 code 列表（UI 文案在 diagnostic.device.*）
docs/PROTOCOL-VLLOGIC-LOGIC20.md 协议说明（注意单位：payload_len 是 dwords）
```

参考实现（C，务必对照）：

```
/home/llp/logic20/libsigrok/src/hardware/vllogic-logic/
  protocol.c/.h      UHSIF 命令/帧、CRC、LUT、通道映射、速率表
  uhsif_rx.c         接收 parser、批处理、drop/seq/partial 统计
  vllogic_usb.c      URB 并发（16 × 256 KiB）、重提交、停止/取消
  api.c              配置序列、带宽准入、启动/停止
```

原生接收环：`VLLOGIC_URB_COUNT 16`、`VLLOGIC_URB_SIZE 256 KiB`、双缓冲（`vllogic.h:34-35`）。

---

## 3. Logic20 数据通路（当前实现）

1. 设备：20 lane，每 lane 每 word 32 samples；一个 snapshot = `nchan` words = 32 个采样时刻。
2. UHSIF 块：16 B 头 + `payload_len` 个 **32-bit 字**（不是字节！范围 120..4092），总线上一块 16 KiB。
3. `vllogic.ts`：
   - 保持 `depth` 条 `transferIn` 同时在飞（默认 8，单次请求 256 KiB；设备实际每 16 KiB 完成一次短读，所以真实缓冲是 `depth × 16 KiB`）。
   - 完成回调**先补发**下一条读，再交给消费者；按提交序号严格排序消费。
   - 达到 `deviceSampleLimit` 立即 `onEnd`，不等被 Stop 的读队列排空。
   - 首块校验：`div / mask / mode / capturing` 与配置不符直接报 `device.headerMismatch`。
   - 设备身份：接受 bcdDevice `0x0802` 或 `0x0820`，拒绝 Sniffer2 的 `0x0602`。
   - `drop_flag` 边沿通过 dropout sink 上报；`seq` 跳变、`partialSnapshots` 写入 parser stats。
   - 每次采集有 `captureEpoch`，旧 readLoop 不会污染新采集。
4. `vllogicProtocol.ts` parser：CRC 失败重同步、跨块半 word/半 snapshot 保留、按 payload 批量回调。
5. `planarStore`：把每通道 words 直接写进位平面，并更新 pyramid。
6. `channelMajorCoalescer`：把 per-payload 的 commit 合并到 **120 Hz**（8.33 ms，样本数按 32 对齐），采集结束/手动 Stop 时 flush 尾批。
7. UI：`liveDrawDue` 按上一帧成本节流绘制；显示层本来就是 ~120 Hz 更新。

### 已修的关键 bug（不要再退回去）

- **`payload_len` 单位**：曾是 `4092` 被当字节、每 word 减 4，导致每块只消费 1023/4092 words，**采样率只有标称的 1/4**（20 MHz → 4.9 MSa/s，160 MHz → 40 MSa/s，1 s 数据要 4 s）。修复为 dwords，并加了 4092-word / 204-snapshot 自检。
- **coalescer 尾批**：`startChannelMajor()` 在 START 完成后就返回；曾在这里把 coalescer 引用置空，导致 `onEnd`/手动 Stop 无法 flush 最后一批。现在 coalescer 保持到 `finishCapture`，`onEnd` 和 `finishCapture` 都 flush。
- **升级提示卡**：不再永久占用右上角；显示 3 秒自动收起，升级图标保持 ready。
- **bcdDevice**：真实 Logic20 在 Windows 显示 `REV_0820`，Chrome 的 `deviceVersionMajor/Minor` 组合出来是 `0x0802`；两种都接受。

---

## 4. 硬件与协议要点

| 项 | 值 |
|---|---|
| VID / PID | `0x1209` / `0x6688` |
| bcdDevice | `0x0802`（Chrome 组合）/ `0x0820`（Windows REV） |
| 端点 | OUT `0x01`，IN `0x81`（WebUSB 传端点号 1） |
| 时钟 | 2.4 GHz / div |
| 速率表 | 20/40/80/100/160/200/400/800/1200 MHz（div 120/60/30/24/15/12/6/3/2） |
| 通道上限 | >800 MHz:2；>400:4；>200:8；>160:16；≤160:20 |
| 持续带宽上限 | 约 400 MB/s（原生实测） |
| 接口 | Interface 0；Interface 1 是 DLDO，勿碰 |
| 触发/Loop | Web 端 VLLogic 目前不支持 loop / 软件触发 |

关键坑：

- **`payload_len` 是 dwords**，不是字节。见 `uhsif_rx.c:767/841/928-933`、`uhsif.v`。
- 设备每 16 KiB 完成一次读；请求 256 KiB 不会真的攒满 256 KiB。`depth × 16 KiB` 才是实际在飞窗口。
- Chrome 的 bcdDevice 拆分与 Windows 显示不一致，不要只按 `0x0820` 拒绝。
- WebUSB 的 `transferIn` 无法取消：START 前 drain 端点要非常小心，当前未做（见 TODO）。
- 设备 `drop_flag` 不会在数据里插标记；丢样后时间轴会压缩，必须靠 drop/seq 统计告警。

---

## 5. 运行与测试

```bash
cd /home/llp/logic20/Logic20Web
npm install
npm run dev        # 浏览器打开 http://localhost:5173/
npm run test       # 113 个离线套件（无硬件）
npm run build      # tsc --noEmit + vite build
```

- 类型检查：`./node_modules/.bin/tsc --noEmit`
- 单个设备自检（快）：
  ```bash
  ./node_modules/.bin/esbuild src/device/vllogicSelftest.ts --bundle \
    --format=esm --platform=node --outfile=/tmp/vllogic.mjs && node /tmp/vllogic.mjs
  ```
- `src/ui/tools/repeat-display-selftest.ts` 偶发挂起（与本项目改动无关）；单独重跑可通过。

### 真实硬件评估页

```bash
npm run dev
# 打开 http://localhost:5173/src/device/bench/index.html
```

- 默认 16 CH @ 160 MHz × 0.25 s（约 320 MB/s）。
- 可改采样率、通道、时长、depth 列表、read KiB、合并提交（0 / 8.33 / 16.67 ms）。
- 结果 JSON 包含：采集/配置耗时、总线 MB/s、有效 MSa/s、transfers、平均/最大 transfer、短包、峰值在飞、commits、sink 写入耗时、解析器 stats。
- 修复 `payload_len` 后，20 MHz×4CH×1s 应约 1 s、`bytes`≈10 MB、`effMSa`≈20；16CH@160MHz×0.25s 应约 0.25 s、`bytes`≈80 MB、`effMSa`≈160。
- 注意：headless Chromium 里的 WebUSB/页面导航不可靠，必须用真实浏览器。

---

## 6. 升级 / PWA 机制

- `src/pwa/sw.js`：shell 预缓存；新 worker 安装后 `waiting`，**不自动激活**。
- `src/ui/pwaUpdate.ts`：
  - 检测到 waiting worker → `state='ready'`；
  - 右上角升级图标从灰色变为品牌色 + 收敛环；
  - 升级提示卡显示 **3 秒后自动收起**，图标仍可点；
  - 点图标/卡片“升级” → `SKIP_WAITING` + reload；
  - 激活时 `rotate()` 删除旧 `shell-<version>` 缓存，旧版本空间释放。
- 状态：`off`（无 SW）/`idle`（当前）/`ready`（有等待版本）。
- 改升级逻辑时同步 `src/ui/tools/pwa-selftest.ts`。

---

## 7. 编码约定 / 容易踩的测试

- 文案：四语言 `en/fr/ru/zh-CN` 必须同时补齐；`index.html` 的静态 fallback 文本也要与英文 catalog 一致（`file-guards-selftest` 会查）。
- 诊断：新 code 加到 `src/diagnostics.ts` 的 `DiagnosticCode`，并在四语言里加 `diagnostic.<code>`。
- 动效：`motion-selftest` 有严格白名单（keyframes 数量/内容、animation 规则、easing 配对、reduced-motion 块）。新增动画必须同步更新它。
- 工具栏：`toolbar-selftest` 固定按钮顺序/anatomy/label key；加按钮要同步。
- 版权：保留原 Sipeed / VLLogic 声明，新增 `Copyright (C) 2026 vllogic.com`，不要移除来源。
- 提交：英文 conventional commit；`main` 直接 push；优先按主题拆分提交。

---

## 8. TODO（按优先级）

### P1（建议下一轮）

1. **用真实硬件复测修复后的采集**
   - 20 MHz×4CH×1s、16CH@160MHz×0.25s 是否回到标称时长/样本率；
   - 20CH@160MHz（400 MB/s）下 depth 曲线，确认 `depth×16 KiB` 是否足够；必要时把默认 depth 提到 16/32。
2. **START 前 drain IN 端点**（P1-3）
   - WebUSB 无法取消 `transferIn`，直接 drain 有风险；可考虑 Worker 内做、或等待 FLUSH ACK、或用首块 `seq`/`capturing` 规则丢弃残留。当前依赖 FLUSH + 首块校验。
3. **stop 唤醒 readLoop + 首字节/首块超时**
   - `stop()` 现在最多等 750 ms；等待 `wake` 的循环不会被立即唤醒；
   - 设备 Start 后不出数时 UI 会一直显示 Capturing，需要 1 s 级看门狗。
4. **Worker 迁移评估**
   - 当前页面线程处理约占 7–10%（16CH@160MHz），并发+depth 已够；
   - 只有在重 UI 负载下仍掉速，或 20CH 满速需要更大缓冲时，再上 Worker（复用 `usbWorker`/`workerTransport`）。

### P2

- `acceptBatch` 的 target 截断用 `Math.ceil`，`remaining` 非 32 倍数时最多超 31 样本；改为向下对齐或在启动前对齐 `deviceSampleLimit`。
- 补测试：drop/seq/partial 上报、首块 `capturing=0`、`onEnd` 晚于 `startChannelMajor` 返回、手动 Stop 尾批 flush、coalescer 单批大于 batchSamples、20CH/160MHz 真实批次大小。
- `device.recommendedSamplerateHz` 与 `profiles.ts` 的 `recommendedSamplerateHzFor()` 两套推荐值不一致；统一。
- 评估页 `terminate()` 是 fire-and-forget + 700 ms 等待；改成可等待的 release/close。
- `vllogicProtocol.ts` 的 CRC 失败重同步目前逐字节左移；可照 `uhsif_rx.c` 的 replay 实现，减少 `crcFail` 噪声。
- `maskMismatch` 后仍继续消费 payload；考虑直接丢弃到下一个头。
- 文档/注释里再全局搜一次 “4092-byte”“51 snapshots”“multiple of four”，确保都改成 dwords 语义。
- `reportReadStats`/bench 的统计口径继续与 app 实际路径保持一致。

---

## 9. 近期提交（截至交接）

```
c20a354  fix(device): accept the Logic20 bcdDevice 0x0802
41308b2  fix(ui): auto-hide the update card after 3 s
4975bcc  feat(device): show parser counters and in-flight bytes in the bench
         fix(data): reject undeclared channels in the coalescer
         fix(device): validate the Logic20 identity and first block, surface drops
34d0e4d  fix(ui): flush the channel-major coalescer at the real capture end
ff2ef11  fix(device): UHSIF payload_len is dwords, not bytes
cf757d7  perf(ui): publish channel-major captures in 120 Hz batches
60d06e6  feat(device): bench at 320 MB/s and separate capture from config time
e7e52c0  fix(device): end the capture as soon as the sample limit is reached
c24adac  feat(device): add a Logic20 read/commit bench page
f141300  feat(device): pipeline VLLogic reads instead of one transfer at a time
```

---

## 10. 接手建议

先按下面顺序做，能在半天内建立完整心智模型：

1. 读 `docs/PROTOCOL-VLLOGIC-LOGIC20.md` + `src/device/vllogicProtocol.ts`，确认 `payload_len` 单位和 word/snapshot 定义。
2. 读 `src/device/vllogic.ts` 的 `readLoop()` 和 `vllogic_usb.c` 的 `in_cb` 对照，理解 depth/补发/顺序。
3. 跑 `npm test` 和两个设备自检。
4. 接真实 Logic20，跑一次 `src/device/bench/index.html`，确认 20MHz/160MHz 的时间与有效 MSa/s。
5. 再决定是否做 TODO 里的 drain、看门狗、Worker。

有硬件相关的疑问，优先对照 `libsigrok/src/hardware/vllogic-logic/`，而不是只看 Web 端注释——之前的 4 倍问题就是注释写错了单位。
