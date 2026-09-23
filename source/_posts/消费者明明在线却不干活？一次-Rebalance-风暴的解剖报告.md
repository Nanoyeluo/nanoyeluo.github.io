---
title: 消费者明明在线却不干活？一次 Rebalance 风暴的解剖报告
tags: [ Kafka ]
categories: [ 消息队列 ]

---

> Kafka 消费积压排查系列 · 第 3 篇。上一篇我们学会了三分钟分诊法：三个问题分清「生产突增」和「消费变慢」（没看过的建议先读：[《Lag 报警了先别重启：三分钟分清「生产突增」还是「消费变慢」》](https://nanoyeluo.github.io/2026/09/22/Lag-%E6%8A%A5%E8%AD%A6%E4%BA%86%E5%85%88%E5%88%AB%E9%87%8D%E5%90%AF%EF%BC%9A%E4%B8%89%E5%88%86%E9%92%9F%E5%88%86%E6%B8%85%E3%80%8C%E7%94%9F%E4%BA%A7%E7%AA%81%E5%A2%9E%E3%80%8D%E8%BF%98%E6%98%AF%E3%80%8C%E6%B6%88%E8%B4%B9%E5%8F%98%E6%85%A2%E3%80%8D/)）。分诊如果是"消费变慢、全分区均匀"，第一个要解剖的嫌疑人不在下游，而在消费组内部——这篇把 Rebalance 送上解剖台。
<!-- more -->

# 前言：最诡异的积压形态

还是那个订单同步服务。周五晚上九点，Lag 告警又响了。你现在已经很熟练了：生产速率 49 msg/s 平稳如常，消费速率却跌到接近零，12 个分区均匀积压——决策树指向"消费整体变慢"。

但接下来的检查让人摸不着头脑：消费者 Pod 的 CPU 空闲在 5%，下游 MySQL 的慢查询日志空空如也，应用日志连一条 ERROR 都没有。再看 Lag 曲线，呈诡异的**锯齿状**：涨一段、平一段、再涨一段。

```javascript
    消费者进程活着，为什么不干活？
    什么是 Rebalance？为什么它一来全组都停工？
    不看监控面板，怎么从日志确认 Rebalance 正在发生？
```

这是五步流程的第三步——**解剖**。分诊只给方向，定罪要靠解剖：

```mermaid
flowchart TD
    A[告警：数据延迟] --> B[发现：看懂 Lag 与积压真相]
    B --> C[定位：生产突增 or 消费变慢]
    C --> D[解剖：Rebalance / 下游慢 / 参数不当]
    D --> E[解决：调参、扩容、分流止血]
    E --> F[预防：监控告警 + K8s 自愈]
```

本文的目标很实际：**读完之后，你能说清 Rebalance 的机制与代价、亲手引爆一次 Rebalance 风暴、并用三行日志在线上确认它**。

`环境说明：沿用第 1 篇的实验环境（kafka 容器、order-event topic、consumer.py）和第 2 篇的两次采样脚本，命令规范同前两篇。`

# 解剖对象：Rebalance 到底是什么

先回收第 1 篇埋下的铁律：**一个分区，同一时刻只能被消费组内的一个消费者持有**。12 个分区 3 个消费者，就是每人 4 个，井水不犯河水。

问题来了：如果现在加进来第 4 个消费者，谁把分区让出来？让几个？这个"重新分地"的过程，就是 **Rebalance**——当消费组的成员或订阅关系发生变化时，分区所有权需要在成员之间重新分配。

然后是全篇最重要的一句话，请加粗记在脑子里：

**Rebalance 期间，整个消费组停工（stop-the-world）。**

默认协议下，所有成员先把手里的分区全部交出来，再由分配者重新发牌——交牌到发完牌之间，**没有任何人在消费**。积压的直接成因，就是这个"停工窗口"。偶尔一次 Rebalance 只停几秒，无伤大雅；但如果 Rebalance 反复发生、连绵不绝，消费组就陷入了"停工-复工-又停工"的死循环——这就是 **Rebalance 风暴**，前言里那条锯齿状 Lag 曲线的成因。

谁会触发 Rebalance？一张表说全：

| 触发源 | 典型场景 |
| --- | --- |
| 新成员加入 | 扩容消费者、K8s 滚动发布新 Pod 起来 |
| 成员主动离开 | 缩容、优雅停机 |
| 成员"死了" | 心跳超时（`session.timeout.ms`），如 Full GC 卡顿、网络中断 |
| 成员"卡死了" | 两次 poll 间隔超限（`max.poll.interval.ms`），消费逻辑处理太慢 |
| 订阅/分区变化 | topic 扩分区、订阅的 topic 列表变更 |

机制上还有两个角色，知道名字即可：broker 端的 **GroupCoordinator** 主持分配大局，消费者端的 **GroupLeader** 负责计算具体的分配方案。排障用不上它们的细节。

最后预告一个第 5 篇的伏笔：默认的分配协议叫 **eager**——"全量回收再分配"，就是上面说的全组停工；Kafka 2.4 引入了 **cooperative** 协议——"增量分配，只动该动的分区"，其他人照常消费。先记住这两个名字。

# 实验：亲手引爆一次 Rebalance 风暴

## 引爆原理

触发 Rebalance 最经典的生产事故，藏在 `max.poll.interval.ms` 这个参数里。它规定**两次拉取消息的最大间隔**（默认 5 分钟）——消费者一次拉一批消息回来处理，如果处理完这批再回来拉下一批的时间超过了这个上限，协调者就判定"这家伙卡死了"，把它踢出消费组，触发 Rebalance。

灾难剧本是这样的：`max.poll.records=500`（默认一次拉 500 条）× 每条处理 1 秒 = 一批要 500 秒 > 300 秒上限 → 被踢 → 触发 Rebalance → 它重新加入 → 又分到分区、又拉 500 条 → 又超时 → 又被踢……**循环往复，风暴成型**。

为了在一分钟内看到风暴，我们把参数调小一点。打开 `consumer.py`，改成这样：

```python
from kafka import KafkaConsumer
import time

consumer = KafkaConsumer(
    'order-event',
    bootstrap_servers='localhost:29092',
    group_id='order-consumer',
    auto_offset_reset='earliest',
    enable_auto_commit=True,
    max_poll_records=50,        # 每批拉 50 条
    max_poll_interval_ms=30000, # 两批间隔上限 30 秒
)

for msg in consumer:
    time.sleep(1)  # 每条处理 1 秒，一批 50 条要 50 秒 > 30 秒上限
```

Spring Kafka 对应的参数是 `max.poll.records` 和 `max.poll.interval.ms`（写在 consumer properties 里），效果完全一样。

先灌点消息垫底（throughput 100 即可），然后启动这个消费者，静观其变。

## 观察点 1：日志在循环滚动

大概 30 秒后，日志里开始反复滚动这样的内容（不同客户端措辞略有差异，关键词一致）：

```plain
Revoking previously assigned partitions order-event-0, order-event-1, ...
(Re-)joining group
Successfully joined group with generation 12
... 50 秒后 ...
Revoking previously assigned partitions order-event-0, order-event-1, ...
(Re-)joining group
Successfully joined group with generation 13
```

翻译一下这个循环：**分区被回收 → 重新入组 → 分到分区 → 处理超时 → 又被回收**。generation 号每循环一次就加一——它是消费组"换届"的届数，线上看到 generation 飙到几百上千，就是风暴的铁证。

## 观察点 2：消费组状态在抽搐

另开一个终端，反复执行：

```bash
docker exec kafka /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --describe --group order-consumer --state
```

你会看到状态在 `PreparingRebalance` / `CompletingRebalance` / `Stable` 之间来回跳，而不是安稳地停在 `Stable`。再看 `--describe` 的输出，CONSUMER-ID 里的 UUID 每隔一会儿就变一次——每次 Rebalance 重入组，成员都换一个新身份。

## 观察点 3：Lag 呈锯齿状

跑第 2 篇的两次采样脚本，多跑几次，你会看到 consume rate 在跳舞：

```plain
# 第一次采样
produce rate: 99 msg/s
consume rate: 0 msg/s     ← 正在 Rebalance，全组停工
backlog rate: +99 msg/s

# 半分钟后再采
produce rate: 100 msg/s
consume rate: 45 msg/s    ← 短暂复工，追了一点
backlog rate: +55 msg/s

# 再半分钟
produce rate: 99 msg/s
consume rate: 0 msg/s     ← 又被踢了
backlog rate: +99 msg/s
```

消费速率在 0 和正常值之间反复横跳，Lag 曲线一截平、一截涨——这就是前言里那条锯齿线的来历。

{% asset_img lag_sawtooth.png Rebalance 风暴下的锯齿状 Lag 曲线截图 %}

## 风暴的隐藏代价：重复消费

风暴还有个更阴的副作用。消费者被踢出组时，**已处理但还没来得及提交的位点全部作废**，重新入组后从上次的提交位点重读。假设一批 50 条处理了 40 条就被踢——这 40 条全部重来一遍。

也就是说，风暴期间你的下游（MySQL、ES）在被**反复写入同样的数据**。这就是为什么 at-least-once 语义下，下游必须幂等——重复消费不是异常，是协议的固有行为。记住这一点，坑 2 还会回来算账。

# 日志识别：三行日志确认 Rebalance

实验环境里风暴一目了然，线上可没这么直观。核心技能是：**从日志里快速确认 Rebalance 正在发生**。直接 grep 这几个关键词（以 Spring Kafka / Java 客户端为准，其他客户端措辞略有差异）：

| 日志关键词 | 含义 |
| --- | --- |
| `Revoking previously assigned partitions` | 分区被回收，Rebalance 开始 |
| `(Re)joining group` | 消费者正在（重新）入组 |
| `Successfully joined group` / `Assignment received` | 分配完成，恢复消费 |
| `Commit cannot be completed since the consumer has already rejoined the group` | 提交失败——重复消费正在发生 |

重点在**频率**：偶尔一次 Rebalance 是正常运维事件（扩缩容、发版都会触发），不用紧张；分钟级反复出现才是风暴。一条命令统计频率：

```bash
grep -c "Revoking previously assigned partitions" app.log
# 再结合日志时间范围算一算：每小时几次是正常，每分钟几次是风暴
```

有监控体系的话，还可以直接看客户端指标 `consumer-coordinator-metrics` 里的 `rebalance-rate-per-hour`——怎么把这个指标接进告警，第 6 篇展开。

# 参数三角：timeout 三兄弟

风暴的引信是参数，灭火的钥匙也是参数。三个 timeout 各管一摊，**方向调反了越修越糟**：

| 参数 | 默认值 | 管什么 | 判定什么"死" |
| --- | --- | --- | --- |
| `session.timeout.ms` | 45s | 心跳超时上限 | 消费者进程死了（GC 卡顿、网络断） |
| `heartbeat.interval.ms` | 3s | 心跳间隔 | 必须远小于 session.timeout |
| `max.poll.interval.ms` | 5min | 两次 poll 的最大间隔 | 消费逻辑卡死了（处理太慢） |

一句话记忆：**session 管"死活"，poll 管"卡死"**。进程还在但处理慢，是 poll 的事；进程心跳都没了，是 session 的事。

调整规则也就清楚了：

- **处理慢**（我们实验里的剧本）→ 调大 `max.poll.interval.ms`，或者减小 `max.poll.records`——每批少拉点，处理完再来。治本永远是让处理变快，调参只是给处理争取时间；
- **网络抖动 / GC 卡顿** → 调大 `session.timeout.ms`，别一卡就判死刑。

注意一个反直觉的代价：`max.poll.interval.ms` 调太大，风暴是止住了，但消费者**真卡死**的时候，也要等同样长的时间才被发现——参数把故障掩盖了，而不是修复了。坑 1 详谈。

# K8s 场景：滚动发布与静态成员

如果你的消费服务跑在 K8s 里，有一个场景天然高发 Rebalance：**滚动发布**。

算一笔账：10 个实例的消费组发一次版，滚动策略逐个重建 Pod——每杀掉一个旧 Pod（成员离开）触发一次 Rebalance，每拉起一个新 Pod（成员加入）又触发一次。10 个实例发一次版 ≈ **20 次全组停工**。发布期间消费几乎停滞，发布后 Lag 已经积了一座小山。

三件套把伤害降到最低：

1. **优雅退出**：`terminationGracePeriodSeconds` 给足（至少覆盖一次 Rebalance 时间），preStop 钩子里等待，消费者在 shutdown hook 里主动 `close()` 离组——主动告别比"心跳超时被发现"快得多，停工窗口从 45 秒缩到秒级；
2. **静态成员 `group.instance.id`**：给每个实例一个固定身份。Pod 重建后带着同一个身份回来，协调者认出"是熟人回来了"，在 session 超时内归队不触发重分配——K8s 消费组的标配；
3. **配合 cooperative 协议**：增量分配，只回收需要易手的分区，其他分区照常消费。和静态成员是黄金搭档，完整配置第 5 篇给。

最后回收第 2 篇坑 1 的伏笔，现在可以拼出完整的事故链了：**消费变慢 → 探针判定不健康 → 杀 Pod → 新 Pod 入组触发 Rebalance → 全组停工更慢 → 更多 Pod 被判不健康**——"重启让积压雪上加霜"的完整链条，每一环都是机制，没有一环是玄学。

# 三个必踩的坑

## 坑 1：把 max.poll.interval.ms 当万能药调大

出了风暴，很多人的第一反应是把 `max.poll.interval.ms` 从 5 分钟调到 30 分钟。风暴确实止住了——但代价是：消费者**真卡死**的时候，也要 30 分钟才被发现。参数没有修复故障，只是把故障的发现时间推迟了。正确的顺序永远是：**先查为什么慢（第 4 篇的主场），再决定调不调参**。

## 坑 2：忽视风暴期的重复消费

实验里我们已经看到：被踢出组时未提交的位点作废，消息整批重读。如果下游是"insert 一条订单记录"这种非幂等操作，风暴过后数据库里就是一片重复数据。at-least-once 语义下，**重复消费不是 bug，是特性**——下游写库写 ES 必须幂等（唯一键、去重表、业务主键 upsert），这是消费端代码的及格线。

## 坑 3：消费者比分区多

Lag 压不住了，扩容！12 个分区的 topic，消费者从 3 个扩到 20 个——然后发现 Lag 纹丝不动。回收第 1 篇的铁律：一个分区只能被一个消费者持有，12 个分区最多喂饱 12 个消费者，**多出来的 8 个永远空闲**，白占资源不提速。分区数是消费并发的硬上限——这就是为什么第 1 篇建 topic 时我们特意强调分区数，第 5 篇会把它展开成完整的扩容方法论。

## 小结

到目前为止，我们解剖完了"消费变慢"的第一个嫌疑人：

```javascript
Rebalance = 全组停工重分配；风暴 = 踢出 → 重入 → 再踢出的死循环
识别：Revoking / (Re)joining / Commit cannot be completed 三行日志，看频率
参数：session 管死活，poll 管卡死，方向别调反
代价：停工窗口积压 + 未提交位点作废的重复消费
```

但如果你的现场是这样的：日志干净、Rebalance 频率正常、参数也没动过——消费还是慢。那凶手就不在消费组内部，而在消费者**之外**：它调用的下游依赖。下一篇《一条慢 SQL 拖垮整个消费组：下游依赖的连锁反应解剖》，我们去消费链路的末端揪出真凶。
