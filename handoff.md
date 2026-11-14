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
   - 保持 `depth` 条 `transferIn` 同时在飞（默认 32，单次请求 256 KiB；Chromium/Linux 实测每次完成约 230–256 KiB，32 条约 8 MiB 请求窗口。16 KiB 是 UHSIF 块粒度，不是完成长度）。
   - 完成回调**先补发**下一条读，再交给消费者；按提交序号严格排序消费。
   - 达到 `deviceSampleLimit` 立即 `onEnd`，不等被 Stop 的读队列排空。
   - 首块校验：`div / mask / mode / capturing` 与配置不符直接报 `device.headerMismatch`（ACK 不参与）。
   - 首块看门狗：START 后 1 s 内没有 data block 报 `device.noData`；`stop()` 会唤醒停在等待里的循环。
   - `stop()` 对“已交付 sample budget”的有限采集立即返回（STOP 后的 pending 读不会完成，等满 750 ms 没有意义）；手动 Stop 仍保留 750 ms settle 收集尾部。
   - START 前排空：`?vllogic-drain=<ms>`（默认 20）；空闲窗口内完成的数据丢弃，窗口后挂起的读作为采集的第 0 条读（预 arm）。实测能把上一轮 STOP 后残留的 ~128 KiB 尾部清掉。
   - 设备身份：接受 bcdDevice `0x0802` 或 `0x0820`，拒绝 Sniffer2 的 `0x0602`。
   - `drop_flag` 边沿通过 dropout sink 上报；`seq` 跳变、`partialSnapshots` 写入 parser stats。
   - 每次采集有 `captureEpoch`，旧 readLoop 不会污染新采集。
4. `vllogicProtocol.ts` parser：CRC 失败重同步、跨块半 word/半 snapshot 保留、按 payload 批量回调；mask 不符的 payload 整块丢弃。
5. `planarStore`：把每通道 words 直接写进位平面，并更新 pyramid。
6. `channelMajorCoalescer`：把 per-payload 的 commit 合并到 **120 Hz**（8.33 ms，样本数按 32 对齐），采集结束/手动 Stop 时 flush 尾批。
7. UI：`liveDrawDue` 按上一帧成本节流绘制；显示层本来就是 ~120 Hz 更新。

### 已修的关键 bug（不要再退回去）

- **`payload_len` 单位**：曾是 `4092` 被当字节、每 word 减 4，导致每块只消费 1023/4092 words，**采样率只有标称的 1/4**（20 MHz → 4.9 MSa/s，160 MHz → 40 MSa/s，1 s 数据要 4 s）。修复为 dwords，并加了 4092-word / 204-snapshot 自检。
- **stop 不唤醒读循环**：`readLoop` 停在 `await new Promise(...)` 等完成回调，`stop()` 只置 `running=false`，设备不再出数时循环永不醒来（`stop()` 靠 750 ms race 假装返回）。现在 `stop()` 调 `wakeLoop`，`loopCompleted` 可观测；旧代循环仍由 `captureEpoch` 隔离。
- **首块无看门狗**：START 后设备被卡住（命令都 ACK、bulk 不出数）时 UI 会一直 Capturing。现在 1 s 内没有 data block 就报 `device.noData`（`?vllogic-firstblock=<ms>` 可调，20..60000）。
- **首块校验误报**：`acceptBatch` 只对 data block 的 header 做校验；START 的 ACK 不更新 `lastHeader`，不会触发 `device.headerMismatch`。
- **mask 不符仍消费 payload**：parser 现在整块丢弃 mask 与配置不符的 payload（`discardPayload`），避免旧 lane 顺序混进采集；`maskMismatch` 仍计数。
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
- 原生 libsigrok 的 URB 以 16 KiB 短包完成；但 Chromium/Linux 的 WebUSB `transferIn(256 KiB)` 实测每次完成约 230–256 KiB（278 次读 ~64 MB），所以 `depth × 256 KiB` 才是请求窗口，`depth` 提供的是主机侧缓冲时间（32 × 256 KiB ≈ 25 ms @ 320 MB/s）。
- Chrome 的 bcdDevice 拆分与 Windows 显示不一致，不要只按 `0x0820` 拒绝。
- WebUSB 的 `transferIn` 无法取消：用空闲探测 + 预 arm 排空（`?vllogic-drain`，默认 20 ms）；只靠 STOP+FLUSH 不够，停止时仍有尾部在飞。
- 高带宽（16CH@160MHz）主机落后时，STOP 后设备仍会完成已排队的尾部数据（实测约 128 KiB，`capturing=1`）。这是**本次采集的尾巴**，不是旧数据；readLoop 会在 750 ms settle 内消费，`captureEpoch` 防止旧循环越代写入。
- 设备 `drop_flag` 不会在数据里插标记；丢样后时间轴会压缩，必须靠 drop/seq 统计告警。
- `drop_flag` 是设备侧 latch（`uhsif_rx.c:823-832` 按 0→1 边沿计数）。2026-11-14 pyusb 实测：上一轮溢出后，下一轮的 START **ACK** 仍带 `drop=1`，但第一个 **data block** 已经回到 0。所以上一轮的 drop 不会污染本轮数据统计；parser 也忽略 ACK 的 drop。
- 本轮 `drop=1` 有两种来源：采集中途真实丢样，或**收尾溢出**（达到 target 后主机停读、设备在 STOP 生效前继续采样把 FIFO 灌满）。`stats.firstDataDrop`（首块 drop）和 `stats.dropAtSnapshots`（边沿出现时已交付的快照数）可以区分；若 `dropAt` 接近 `target/32`，就是收尾溢出。transport 现在在预算达成后继续读 20 ms（`TAIL_DRAIN_MS`）并丢弃，专门消除这种误报。

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

### START 前排空验证页（2026-11 新增）

```bash
npm run dev:lan   # HTTPS，局域网访问 https://<lan-ip>:5174/src/device/bench/drain.html
```

- 可调采样率/通道/drain 空闲窗口/合并提交/depth/read KiB/轮数；每轮记录排空读、preArm、首块延迟、ACK/CRC/mask/drop/seq 统计和 stop 耗时。
- 默认 `drain=20`（生产默认）；`drain=0` 可对照。`合并提交` 用 `ChannelMajorCoalescer`，默认 8.33 ms，和 app 生产路径一致。
- 连续多轮同时验证 stop 唤醒：卡住的循环会表现为 stop≈750 ms 且后续轮次异常。

### pyusb 协议复现（无需浏览器）

```bash
python3 src/device/tools/vllogic_drain_probe.py --mode web --cycles 3 \
  --rate 20000000 --channels 4 --duration-ms 200 --json /tmp/drain-web.json
```

- `--mode web|drain|c-driver` 分别模拟浏览器现状、空闲探测、libsigrok 的逐条 ACK + `sync_drain(32×5ms)`。
- `--stall-ms 1500` 模拟页面卡住（设备 FIFO 溢出、drop latch），用来看 STOP 后是否留下旧数据块。
- 结论（2026-11-14，固件 `0x0820`）：配置 ACK 不会无限堆积；STOP+FLUSH 后没有旧数据块；START 后首块是 ACK。因此 drain 默认关闭。

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

1. **用真实硬件复测修复后的采集**（已完成 2026-11-14，16CH@160MHz）
   - 合并提交 8.33 ms 时 18 轮均为 320–346 MB/s、effMSa≈160；`crcFail/maskMismatch/seqJumps` 全 0，`stopMs < 6 ms`。
   - 偶发 `drop=1` 都出现在采集中段（`dropAtSnapshots` 为预算的 24%–54%，`firstDataDrop=false`），是页面线程短暂失去调度导致设备 FIFO 溢出；depth 8 为 3/6 轮、16 为 2/6、32 为 0/6。默认 depth 因此提到 **32**（512 KiB 在飞）。
   - 收尾 drain（`TAIL_DRAIN_MS=20`）仍保留，专门防“预算达成后停止读”造成的尾部溢出。
   - pyusb 侧 20 MHz×4CH×1 s 得到 2,553,408 words ≈ 20.4 MSa/s、10.22 MB，确认没有 4 倍问题。
   - 剩余：20CH@160MHz（400 MB/s）和 100 MHz 默认场景待复测。
2. ~~START 前 drain IN 端点~~ **已完成（2026-11-14）**
   - pyusb 实测：配置 ACK 不堆积、STOP+FLUSH 后无旧数据块、START 后首块是 ACK；详见 `docs/PROTOCOL-VLLOGIC-LOGIC20.md`。
   - 已实现 `?vllogic-drain=<ms>`（空闲探测 + 预 arm 交接），**默认 20**：页面实测上一轮 STOP 后端点仍有 ~128 KiB 尾部，不开会在下一轮被当成新数据。
3. ~~stop 唤醒 readLoop + 首块超时~~ **已完成（2026-11-14）**
   - `stop()` 调 `wakeLoop`，`loopCompleted` 可观测；`device.noData` 看门狗 1 s（`?vllogic-firstblock=<ms>`）。
4. **Worker 迁移评估**
   - 当前页面线程处理约占 7–10%（16CH@160MHz），并发+depth 已够；
   - 只有在重 UI 负载下仍掉速，或 20CH 满速需要更大缓冲时，再上 Worker（复用 `usbWorker`/`workerTransport`）。

### P2

- `acceptBatch` 的 target 截断用 `Math.ceil`，`remaining` 非 32 倍数时最多超 31 样本；改为向下对齐或在启动前对齐 `deviceSampleLimit`。
- 补测试：drop/seq/partial 上报、首块 `capturing=0`、`onEnd` 晚于 `startChannelMajor` 返回、手动 Stop 尾批 flush、coalescer 单批大于 batchSamples、20CH/160MHz 真实批次大小。
- `device.recommendedSamplerateHz` 与 `profiles.ts` 的 `recommendedSamplerateHzFor()` 两套推荐值不一致；统一。
- 评估页 `terminate()` 是 fire-and-forget + 700 ms 等待；改成可等待的 release/close。
- `vllogicProtocol.ts` 的 CRC 失败重同步目前逐字节左移；可照 `uhsif_rx.c` 的 replay 实现，减少 `crcFail` 噪声。
- ~~`maskMismatch` 后仍继续消费 payload~~ **已修（2026-11-14）**：整块丢弃，不再混入。
- 文档/注释里再全局搜一次 “4092-byte”“51 snapshots”“multiple of four”，确保都改成 dwords 语义（`vllogicProtocol.ts` 里的一处已改）。
- `reportReadStats`/bench 的统计口径继续与 app 实际路径保持一致。
- `stop()` 的 750 ms settle 仍是上限：无法取消的 `transferIn` 会拖住收尾；若要更快，只能把传输放进 Worker 后 terminate worker。

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
