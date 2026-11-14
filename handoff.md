# Logic20Web 维护交接（handoff）

本文给接手维护者：项目要点、已完成的 Logic20 支持、关键坑、测试方式和 TODO。
最后更新：2026-11-14，对应 `main` 的 `dbbd34f`（Worker、host-loop、新速率表/抽稀、1.6 V 阈值、预算对齐、CRC 重同步、任意 lane 选择）。

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
src/device/vllogicWorker.ts      Worker 内读泵 + parser + 120 Hz 聚合（生产默认路径）
src/device/workerVllogicDevice.ts 页面侧 Worker 包装（store 写入、stats、回退）
src/device/vllogicWorkerProtocol.ts Worker 消息协议 + buffer 池回传
src/device/vllogicProtocol.ts    UHSIF v2.2：CRC、LUT、通道映射、parser、div/阈值
src/device/profiles.ts           Logic20 / SLogic profile、速率上限
src/device/vllogicSelftest.ts    Logic20 离线自检（24 项）
src/device/bench/                真实硬件评估页（不参与生产构建；index.html / drain.html）
src/data/planarStore.ts          channel-major 位平面存储 + min/max pyramid
src/data/bitplane.ts             BitPlane（writeWords 快路径）
src/data/channelMajorCoalescer.ts 120 Hz 合并提交（loop 下用 target.length 作帧起点）
src/ui/thresholdOptions.ts        阈值预设拆分（数值 + 右对齐的 CMOS 标注）
src/data/channelMajorCoalescerSelftest.ts
src/ui/app.ts                    采集主流程；startChannelMajor 接入、captureCoalescer
src/ui/pwaUpdate.ts              SW 注册、升级图标、升级提示卡（3 s 自动收起）
src/ui/locales/{en,zh-CN,fr,ru}.ts 四语言文案
src/diagnostics.ts               诊断 code 列表（UI 文案在 diagnostic.device.*）
src/device/tools/vllogic_drain_probe.py  pyusb 探针（无需浏览器）
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

1. 设备：20 lane，每 lane 每 word 32 samples；一个 snapshot = `nchan` words = 32 个采样时刻。`nchan` 是本次**选中**的 lane 数，不要求连续，也不要求是 2 的幂。
   - UI 固定三行 D0–D7 / D8–D15 / D16–D19；每行右侧“全选/全不选”，不再有 2CH/4CH/… 和 A0 模拟按钮（A0 只保留给 32U3）。
   - 选中顺序记时间戳；`selected × samplerate > 4500 Mbps` 时按“未引用优先、最早选定优先、同时间通道号大优先”强制关闭，至少保留 1 路；被关闭通道的触发/总线/解码器引用会被清理并提示。
   - 4500 Mbps 是硬限制；>2560 Mbps 只显示“可能超出 USB 链路带宽（WebUSB综合限制）”。
   - 存储按选中通道稀疏分配（`PlanarSampleStore.setActiveChannels`），未选通道不分配平面，内存不再按 20 路膨胀。
2. UHSIF 块：16 B 头 + `payload_len` 个 **32-bit 字**（不是字节！范围 120..4092），总线上一块 16 KiB。
2b. 生产路径在 Dedicated Worker 里跑读泵 + parser；每 8.33 ms 一批（16CH@160MHz 约 2.66 MB）transfer 给页面，buffer 池 8 个 + ack 回传复用。`?vllogic-worker=0` 回退页面线程。Worker 的 batch 缓冲按选中 lane 数分配。
3. `vllogic.ts`：
   - 保持 `depth` 条 `transferIn` 同时在飞（默认 64，单次请求 256 KiB；Chromium/Linux 实测每次完成约 230–256 KiB，64 条约 16 MiB 请求窗口；Linux 需要 `usbfs_memory_mb >= 16`。16 KiB 是 UHSIF 块粒度，不是完成长度）。
   - 完成回调**先补发**下一条读，再交给消费者；按提交序号严格排序消费。
   - 达到 `deviceSampleLimit` 立即 `onEnd`，不等被 Stop 的读队列排空。
   - 首块校验：`div / mask / mode / capturing` 与配置不符直接报 `device.headerMismatch`（ACK 不参与）。
   - 首块看门狗：START 后 1 s 内没有 data block 报 `device.noData`；`stop()` 会唤醒停在等待里的循环。
   - `stop()` 对“已交付 sample budget”的有限采集立即返回（STOP 后的 pending 读不会完成，等满 750 ms 没有意义）；手动 Stop 仍保留 750 ms settle 收集尾部。
   - START 前排空：`?vllogic-drain=<ms>`（默认 20）；空闲窗口内完成的数据丢弃，窗口后挂起的读作为采集的第 0 条读（预 arm）。实测能把上一轮 STOP 后残留的 ~128 KiB 尾部清掉。
   - 设备身份：接受 bcdDevice `0x0802` 或 `0x0820`，拒绝 Sniffer2 的 `0x0602`。
   - `drop_flag` 边沿通过 dropout sink 上报；`seq` 跳变、`partialSnapshots` 写入 parser stats。
   - Loop：设备无限流，app 在每次 120 Hz commit 后按 `loopRetentionLen` 丢弃前端（大块、512 对齐），`ChannelMajorCoalescer` 用 `store.length` 作为每帧起点；手动 Stop 不等 750 ms。
   - 抽稀：10/5/2.5 MHz 设备仍按 20 MHz 流，`VllogicDecimator` 在 host 端每 2/4/8 个样本取一个，跨批保留余数，提交仍是 32 对齐。有限采集的 `deviceSampleLimit` 在 START 时向下对齐到 32；尾批按 `decimateFactor` 把“剩余输出快照”换算成输入快照，避免抽稀时为了凑数跳过成块输入、破坏尾部连续性。
   - 每次采集有 `captureEpoch`，旧 readLoop 不会污染新采集。
   - `release()` 是可等待的 stop + releaseInterface + close；`terminate()` 只是 `void release()`。评估页用 `await release()`，不再 sleep 固定 700 ms。
4. `vllogicProtocol.ts` parser：CRC 失败重同步、跨块半 word/半 snapshot 保留、按 payload 批量回调；mask 不符的 payload 整块丢弃。CRC 失败照 `uhsif_rx.c` 的 replay 实现：丢弃当前未完成快照（计入 `partialSnapshots`），把坏头 magic 之后的 15 B 放回 SCAN，一个坏块只记 1 次 `crcFail`，不会按字节左移刷噪声。
5. `planarStore`：把每通道 words 直接写进位平面，并更新 pyramid。
6. `channelMajorCoalescer`：把 per-payload 的 commit 合并到 **120 Hz**（8.33 ms，样本数按 32 对齐），采集结束/手动 Stop 时 flush 尾批。
7. UI：`liveDrawDue` 按上一帧成本节流绘制；显示层本来就是 ~120 Hz 更新。

### 已修的关键 bug（不要再退回去）

- **`payload_len` 单位**：曾是 `4092` 被当字节、每 word 减 4，导致每块只消费 1023/4092 words，**采样率只有标称的 1/4**（20 MHz → 4.9 MSa/s，160 MHz → 40 MSa/s，1 s 数据要 4 s）。修复为 dwords，并加了 4092-word / 204-snapshot 自检。
- **stop 不唤醒读循环**：`readLoop` 停在 `await new Promise(...)` 等完成回调，`stop()` 只置 `running=false`，设备不再出数时循环永不醒来（`stop()` 靠 750 ms race 假装返回）。现在 `stop()` 调 `wakeLoop`，`loopCompleted` 可观测；旧代循环仍由 `captureEpoch` 隔离。
- **首块无看门狗**：START 后设备被卡住（命令都 ACK、bulk 不出数）时 UI 会一直 Capturing。现在 1 s 内没有 data block 就报 `device.noData`（`?vllogic-firstblock=<ms>` 可调，20..60000）。
- **首块校验误报**：`acceptBatch` 只对 data block 的 header 做校验；START 的 ACK 不更新 `lastHeader`，不会触发 `device.headerMismatch`。
- **mask 不符仍消费 payload**：parser 现在整块丢弃 mask 与配置不符的 payload（`discardPayload`），避免旧 lane 顺序混进采集；`maskMismatch` 仍计数。
- **默认采样率必须是 80 MS/s**：页面打开/连接 Logic20 后就要选中它（20 lane × 80 MHz = 1600 Mbps，低于 2560 提示线）。旧 workspace 里非 explicit 的 16 MS/s 会被覆盖；显式选择保持，但必须 snap 到 Logic20 的速率表。不要改回只靠 `recommendedSamplerateHz`，否则某些 workspace 会显示 16 或空白。
- **旧的 2.4 Gbit/s 通道档位作废**：不要再按 `vllogicMaxChannels()` 的 2/4/8/16/20 档（那是旧的每行 2.4Gbit 规则）限制 UI。现行规则是任意 lane 子集 + 4500 Mbps 总带宽硬限制；`vllogicMaxChannels()` 只作为总带宽换算的辅助。
- **通道芯片不再只是显示开关**：Logic20 上 `enabled` 决定本次采集的 lane 子集，`CaptureConfig.selectedChannels` 交给 transport；未选 lane 在 store 中没有平面。不要改回“采集前 N 路、芯片只隐藏行”。
- **内存不能按 20 路固定分配**：`PlanarSampleStore` 的稀疏活跃集合是硬要求；未选通道不能 `extendTo()`/建 pyramid，否则选 1 路会膨胀 20 倍。
- **CRC 重同步逐字节左移**：不要把移位后的 15 B 当新头继续验 CRC（会刷 `crcFail`，还可能吞掉紧随其后的真头）。现在照 `uhsif_rx.c` 把它们回放给 SCAN，一次坏块只记一次；已攒的完整快照必须先 flush，半快照计入 `partialSnapshots`。
- **target 用 `Math.ceil` 截断**：整快照提交不可能精确命中任意样本数，`Math.ceil` 会超预算最多 31 样本。现在 START 时向下对齐到 32，抽稀尾批再按 `decimateFactor` 换算；不要改回向上取整或按输出快照数截输入。
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
| 速率表 | 1200/600/300/150/120/80/40/20 MHz（div 2/4/8/16/20/30/60/120）+ 10/5/2.5 MHz（div 120，上位机 2/4/8 抽一） |
| 默认采样率 | 80 MS/s（页面打开即选中；Logic20 20 lane = 1600 Mbps） |
| 通道选择 | 任意 0..19 子集（CHANNEL_MASK + LUT 环），不限“前 N 路” |
| 内部 FIFO | 理论 4800 Mbps；上位机硬限制 4500 Mbps（选中数 × 采样率） |
| USB / 上位机 | 实测约 2560 Mbps；超过只提示，不强制 |
| 持续带宽上限 | 约 400 MB/s（原生实测） |
| 接口 | Interface 0；Interface 1 是 DLDO，勿碰 |
| 触发/Loop | 支持无触发 Loop（host 端保留最新窗口并 `dropFront`）；软件触发仍不支持 |
| 阈值预设 | -2.5 / -1.5 / 0 / 0.6（1.2 V CMOS）/ 0.9（1.8 V）/ 1.6（3.3 V，默认）/ 2.5（5.0 V CMOS）/ 5 V + 自定义 |
| 测试模式 | Logic20 只有正常模式；采集面板对该设备隐藏测试模式行 |
| OTA | 固件更新链接 `https://logic20.vllogic.com/ota/`（页面暂未发布，入口保留） |

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
npm run test       # 114 个离线套件（无硬件）
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

- 默认参数以当前速率表为准：常用 16 CH @ 150 MHz × 0.25 s（约 300 MB/s）或 20 CH @ 120 MHz。
- 可改采样率、通道、时长、depth 列表、read KiB、合并提交（0 / 8.33 / 16.67 ms）。
- 结果 JSON 包含：采集/配置耗时、总线 MB/s、有效 MSa/s、transfers、平均/最大 transfer、短包、峰值在飞、commits、sink 写入耗时、解析器 stats。
- 修复 `payload_len` 后，20 MHz×4CH×1s 应约 1 s、`bytes`≈10 MB、`effMSa`≈20；16CH@150MHz×0.25s 应约 0.25 s、`bytes`≈75 MB、`effMSa`≈150。
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
- 结论（2026-11-14，固件 `0x0820`）：配置 ACK 不会无限堆积；STOP+FLUSH 后没有旧数据块；START 后首块是 ACK。生产默认仍保留 20 ms 排空，因为高负载下上一轮 STOP 后的尾部会残留在端点。

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
   - 偶发 `drop=1` 都出现在采集中段（`dropAtSnapshots` 为预算的 24%–72%，`firstDataDrop=false`），是页面线程短暂失去调度导致设备 FIFO 溢出；depth 8 为 3/6 轮、16 为 2/6、32 为 0/6（0.2 s 组）。
   - 0.5 s × 20 轮压测仍有 20%–30% 轮次中段 drop；`longtask` 全 0（阈值 50 ms），但 rAF 帧间隔显示 drop 轮 `frameMax≈33 ms`、`frameSlow(>20 ms)` 为 7–16，非 drop 轮 0–4。**主线程 20–33 ms 停顿是根因**。
   - `PlanarSampleStore.reserveSamples()` 可在 START 前预分配 base/pyramid（base 每通道每块 2 MiB，采集期间增长会触发 GC）；测试页已默认勾选“预分配 store”。
   - 预分配实测把 0.5 s × 20 轮的 drop 从 6/20 降到 2/20；剩余停顿与“每轮新建 160 MB store、由 GC 在下一轮回收”相关。`PlanarSampleStore.reset()` 保留块数组只清 bookkeeping，测试页在同一几何下复用 store（不再每轮新建）。
   - **最终配置**：depth **64**（64 × 256 KiB ≈ 16 MiB 请求窗口，Linux 需 `usbfs_memory_mb >= 16`）+ 预分配 + 复用 store，0.5 s × 20 轮 **0/20 drop**；慢帧仍有（`frameMax` 最大 49.8 ms、`frameSlow` 0–15），但被缓冲吸收；`runMs` 500–582 ms（停顿会拉长采集时间，不丢样）。
   - 收尾 drain（`TAIL_DRAIN_MS=20`）仍保留，专门防“预算达成后停止读”造成的尾部溢出。
   - pyusb 侧 20 MHz×4CH×1 s 得到 2,553,408 words ≈ 20.4 MSa/s、10.22 MB，确认没有 4 倍问题。
   - 剩余：任意 lane 子集/新带宽规则（见下一条）、10/5/2.5 MHz 抽稀、无触发 Loop 待真实硬件实测。旧的 20CH@120MHz 档位不再是上限。
2. ~~START 前 drain IN 端点~~ **已完成（2026-11-14）**
   - pyusb 实测：配置 ACK 不堆积、STOP+FLUSH 后无旧数据块、START 后首块是 ACK；详见 `docs/PROTOCOL-VLLOGIC-LOGIC20.md`。
   - 已实现 `?vllogic-drain=<ms>`（空闲探测 + 预 arm 交接），**默认 20**：页面实测上一轮 STOP 后端点仍有 ~128 KiB 尾部，不开会在下一轮被当成新数据。
3. ~~stop 唤醒 readLoop + 首块超时~~ **已完成（2026-11-14）**
   - `stop()` 调 `wakeLoop`，`loopCompleted` 可观测；`device.noData` 看门狗 1 s（`?vllogic-firstblock=<ms>`）。
4. **任意 lane 子集的真机验证（待硬件）**
   - UI 已改成 D0–D19 三行 + 行全选，`CaptureConfig.selectedChannels` 交给 transport；稀疏 store 只分配选中平面。
   - 真机要覆盖：非连续子集（如 D0/D3/D19）、20 路时分批关闭、4500 硬限制触发、2560 提示、LUT 环与 payload 物理顺序映射。
   - 关注 `maskMismatch=0`、`drop=0`，以及选中通道的波形是否落在正确 D 编号上。
5. ~~Worker 迁移~~ **已实现（2026-11-14）**
   - 生产 app 页面线程实测每轮 `drop=1`、avg 53–56 ms；Worker 后 **约 30 轮 0 drop**、296–318 MB/s。
   - `vllogicWorker.ts`：Worker 内读泵 + parser + 120 Hz 聚合；`workerVllogicDevice.ts`：页面包装，主线程只写 store。
   - 每 8.33 ms 一批约 2.66 MB（16CH@160MHz）；**buffer 池 8 个 + 页面 ack 回传**，稳态零分配，避免 Worker GC 与读泵抢事件循环。
   - `?vllogic-worker=0` 强制回退页面线程；Worker 不可用时自动回退。
   - 统计注意：`stop` 后仍挂在 Worker 里的 pending 读会拉高 `avg/max`（甚至几十秒），不代表采集问题；看 `drop` 和 `lineMBs`。

### P2

- ~~`acceptBatch` 的 target 截断用 `Math.ceil`~~ **已修（2026-11-14）**：START 时把 `deviceSampleLimit` 向下对齐到 32 的倍数（小于 32 时至少一批）；抽稀时尾批按 `decimateFactor` 换算输入快照，样本正好落在预算上且尾部连续。回归：`vllogicSelftest` 的非对齐预算、10 MHz 抽稀尾批逐位比对。
- ~~CRC 失败重同步逐字节左移~~ **已修（2026-11-14）**：按 `uhsif_rx.c` 的 replay 实现，坏头后 15 B 回 SCAN；一个坏块 1 次 `crcFail`，已攒的完整快照保留，半快照计入 `partialSnapshots`。
- ~~评估页 `terminate()` + 700 ms 等待~~ **已修（2026-11-14）**：`VllogicDevice.release()` 可等待，`drain.html` / `vllogic-read.html` 直接 `await`。
- ~~`device.recommendedSamplerateHz` 与 `profiles.ts` 不一致~~ **已核对（2026-11-14）**：两处 20 lane 都是 80 MHz，`profiles.ts` 的注释也已从“160 MHz / 100 MHz 推荐”改成现行 120 MHz 上限 / 80 MHz 推荐。
- 补测试：drop / seq / partial 上报、首块 `capturing=0`、非对齐预算、抽稀尾批已覆盖；仍缺 `onEnd` 早于/晚于 `startChannelMajor` 返回的显式断言、手动 Stop 的尾批 flush（app 级）、20CH/120MHz 真实批次大小、host-loop 的 drop 与窗口同步。
- 文档/注释里再全局搜一次 “4092-byte”“51 snapshots”“multiple of four”，确保都改成 dwords 语义（`vllogicProtocol.ts` 里的一处已改；`PROTOCOL-VLLOGIC-LOGIC20.md` 的 “does not have to be a multiple of four” 是正确表述，勿误删）。
- `reportReadStats`/bench 的统计口径继续与 app 实际路径保持一致（drain 页已用 store 字节算线速，避免把 20 ms 收尾 drain 算进去）。
- 手动 Stop 仍保留 750 ms settle（停在端点里的读不会完成）；有限采集达到预算和 Loop 的 Stop 已改为立即返回。
- **TODO：`.lwcap` 紧凑导出**。当前 `.lwcap` 仍按 store.channelCount（20）写，未选通道会以零通道出现在文件里；`.sr`/`.vcd`/`.csv` 已只导出启用通道。后续给 `planLwcap` 加通道映射，或让 store 暴露“已存储通道列表”并压缩头部。
- **TODO：存储宽度真正压缩**。稀疏平面已消除 20 倍内存膨胀，但 store 的逻辑宽度仍是 20；若要进一步压缩 header/导出/`channelCount` 语义，需要 D 编号↔store 索引映射，工作量大，先不做。

---

## 9. 近期提交（截至交接）

```
dbbd34f  fix(ui): open on the Logic20 80 MS/s default
5f32e0a  feat(ui): select Logic20 lanes within the FIFO and link limits
360177a  feat(device): stream arbitrary Logic20 lane subsets
9b386f7  feat(data): store only the selected channel-major lanes
87f8ef6  fix(device): land the Logic20 budget exactly and resync corrupt headers
a6236cc  docs: refresh the handoff for worker, loop and the new scales
7e0e47b  docs: record loop support, the worker path and the new scales
ef21b2a  feat(device): support host-side loop captures on the Logic20
1f0b52b  fix(ui): render the 5 V CMOS family as 5.0 V
a92a16a  feat(ui): show 1.6 V as the 3.3 V CMOS preset and right-align notes
f4c2f46  chore(ui): point the firmware updater at logic20.vllogic.com
1adf3fc  feat(device): update the Logic20 rates, ceilings and host decimation
2fff243  feat(ui): warn when the device dropped samples during a capture
2e75c80  docs: record the worker transport as the final Logic20 path
4f9fc8f  perf(device): pool the worker batch buffers
246f5de  perf(device): send one worker batch buffer instead of sixteen
da8f4d6  feat(device): report the worker capture stats on the page
73afcac  feat(device): run the Logic20 transport in a worker
3a1125b  feat(ui): reserve the planar store before a channel-major capture
9e46767  docs: record the stable 160 MHz capture configuration
```

更早的提交（交接前的基线）：

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
3. 读 `src/ui/channelBandwidth.ts` + `src/ui/app.ts` 的 `enforceChannelBandwidth()`，理解 4500/2560 与强制关闭顺序；再看 `PlanarSampleStore.setActiveChannels()` 的稀疏存储。
4. 跑 `npm test` 和两个设备自检。
5. 接真实 Logic20，跑一次 `src/device/bench/index.html` 和 `drain.html`，确认任意 lane 子集、20/80/120 MHz 的时间与有效 MSa/s。
6. 采集走 Worker（`vllogicWorker.ts`）；先用 `?vllogic-worker=0` 跑一次页面路径对照，理解两者的差异。
7. 再看 P2 的剩余项；drain、看门狗、Worker、host-loop、预算对齐、CRC replay、通道选择与稀疏存储已完成，不要重复实现。

有硬件相关的疑问，优先对照 `libsigrok/src/hardware/vllogic-logic/`，而不是只看 Web 端注释——之前的 4 倍问题就是注释写错了单位。
