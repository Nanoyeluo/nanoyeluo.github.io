---
title: 慢日志太多看不过来？pt-query-digest 三步定位最值得修的 Top SQL
tags:
  - Mysql
categories:
  - 数据库
date: 2026-09-14 14:38:33
---

> 慢查询系列 · 第 2 篇。上一篇我们用 Docker 搭好环境、打开慢查询日志，抓到了第一条慢 SQL（没看过的建议先读：[《慢查询排查入门：Docker 搭环境 + 慢查询日志，10 分钟抓到第一条慢 SQL》](https://nanoyeluo.github.io/2026/09/11/%E6%85%A2%E6%9F%A5%E8%AF%A2%E6%8E%92%E6%9F%A5%E5%85%A5%E9%97%A8%EF%BC%9ADocker%20%E6%90%AD%E7%8E%AF%E5%A2%83%20+%20%E6%85%A2%E6%9F%A5%E8%AF%A2%E6%97%A5%E5%BF%97%EF%BC%8C10%20%E5%88%86%E9%92%9F%E6%8A%93%E5%88%B0%E7%AC%AC%E4%B8%80%E6%9D%A1%E6%85%A2%20SQL/)）。但真实生产的慢日志一天几千条，同一条 SQL 换个参数又是一条——肉眼根本看不过来。这篇请出两个日志分析工具，三步筛出「最值得修」的 Top SQL。
## 前言：从「抓到一条」到「一天三千条」

上篇结尾我们留了个问题：慢日志开了，`log_queries_not_using_indexes` 也顺手开了，第二天一看——日志 3000 多行。打开一看更崩溃：

- 同一条 SQL，手机号换一下就是一条新记录，翻来覆去出现；
- 有的 SQL 单次 8 秒，有的一天出现 300 次，**先修哪个**？
- 有的每次都慢，有的偶尔慢一次，性质一样吗？
<!--more-->
逐条翻日志是不现实的。好在这是个已经被解决得很成熟的问题——慢日志分析工具就干一件事：**把流水账聚合、排序，告诉你哪几条 SQL 吃掉了最多的数据库时间**。

本篇三步法：

```mermaid
flowchart LR
    A[几千条慢日志] --> B[第一步：聚合<br>按指纹归类]
    B --> C[第二步：排序<br>按总耗时出排行榜]
    C --> D[第三步：解读<br>三个数字定优先级]
    D --> E[Top SQL 修复清单]
```

读完这篇，拿到任何一份慢日志，你都能在 5 分钟内给出一份有依据的「修复优先级清单」。环境沿用上篇（Docker + MySQL 8.0.43，容器 `mysql8new`，库 `mydb`，`user` 表 1000 万行、`orders` 表 500 万行），所有命令可直接复制复现。
## 工具选型：mysqldumpslow vs pt-query-digest

两个都学，分工不同：

| 维度 | mysqldumpslow | pt-query-digest |
| --- | --- | --- |
| 来源 | MySQL 官方自带 | Percona Toolkit，需单独安装 |
| 安装成本 | 零 | 一行命令 |
| 归一化能力 | 参数替换为 `N` / `'S'` | 指纹（fingerprint），更彻底 |
| 报告详细度 | 每类 SQL 一行汇总 | 总览 + 排行榜 + 单查询详情 |
| 排序维度 | 次数 / 总耗时 / 行数 | 任意指标，默认总耗时 |
| 适合场景 | 30 秒快速扫一眼 | 正式排查、出报告 |

我的习惯：**先用 mysqldumpslow 建立直觉，再用 pt-query-digest 做主力分析**。下面按这个顺序来。

## 第 0 步：造一份「像生产的」慢日志

上篇的日志里只有一条 SQL，太干净，练不了手。真实生产的慢日志是几十种 SQL、成百上千条记录的混合体。写个脚本模拟「一天的流量」：

```bash
#!/bin/bash
# gen_slow_log.sh —— 往慢日志里灌"一天的量"
# 环境沿用上篇：容器 mysql8new，库 mydb

run() { docker exec mysql8new mysql -uroot -proot123 mydb -N -e "$1" 2>/dev/null; }

# A：等值查询缺索引（上篇那条），低频
for i in $(seq 1 20); do
  run "SELECT * FROM user WHERE phone = '13800001111';"
done

# B：LIKE 左模糊，中频 —— 本系列第三篇的主角，先让它上榜
for i in $(seq 1 30); do
  run "SELECT * FROM user WHERE name LIKE '%34567';"
done

# C：JOIN 缺索引，单次最慢但一天只跑几次 —— 第四篇的主角
for i in $(seq 1 5); do
  run "SELECT * FROM orders o JOIN user u ON o.user_id = u.id WHERE u.phone = '13800001111';"
done

# D：无索引 + LIMIT，单次很快、频率最高
#    不超阈值，能被记录全靠 log_queries_not_using_indexes=ON
for i in $(seq 1 300); do
  run "SELECT * FROM user WHERE city = '北京' LIMIT 100;"
done
```

跑一遍（A/B/C 都是全表扫描，大约 3~4 分钟，耐心等）：

```bash
chmod +x gen_slow_log.sh && ./gen_slow_log.sh
```
{% asset_img make_data.png 造数截图 %} 
看一眼日志量：

```bash
docker exec mysql8new sh -c 'grep -c "Query_time" /var/lib/mysql/*-slow.log'
# 309
```
{% asset_img data_result.png 结果截图 %} 

309 条记录——这就是我们要面对的「一天」。肉眼翻已经不现实了，上工具。

## 第一步：聚合 —— mysqldumpslow 30 秒扫全场

mysqldumpslow 是 MySQL 发行版自带的工具，本不用装任何东西。但先确认一下容器里有没有：

```bash
docker exec mysql8 which mysqldumpslow
# 没有输出 —— 官方 mysql:8.0 镜像装的是精简版 server 包，不带这个 Perl 脚本
```

没有也不用往容器里装东西。先建立一个关键认知：**mysqldumpslow 只是一个独立的 Perl 脚本，解析的是纯文本日志，和 MySQL 版本完全无关**——它不需要任何数据库环境，随便一个 perl 容器就能跑。

**下载官方脚本 + perl 容器（推荐，最轻量）**

```bash
# 1. 把慢日志从容器拷到宿主机当前目录
docker cp mysql8new:/var/lib/mysql/1f643cd1ebdc-slow.log ./slow.log

# 2. 从 MySQL 官方源码仓库下载脚本（8.0 分支），剥掉带构建占位符的第一行
curl -sL https://cdn.jsdelivr.net/gh/mysql/mysql-server@8.0/scripts/mysqldumpslow.pl.in | tail -n +2 > mysqldumpslow.pl

# 3. 任意 perl 容器跑：把当前目录挂进去，脚本和日志都在里面
docker run --rm -v "$(pwd):/work" -w //work perl:slim perl mysqldumpslow.pl -s c slow.log
```

> 源码里的 `mysqldumpslow.pl.in` 是构建模板，第一行 shebang 是 `@PERL_PATH@` 占位符，直接跑会报 `Can't exec @PERL_PATH@`，所以第 2 步用 `tail -n +2` 剥掉它——剩下的就是一个 213 行的纯 Perl 脚本。

**分析动作发生在临时容器里，`--rm` 用完即删，运行中的 MySQL 容器零侵入**——这和后面 pt-query-digest「远程取日志、本地分析」是同一个思路。

> 嫌麻烦也可以干脆跳过 mysqldumpslow：它的归一化、排序能力 pt-query-digest 全都有，本篇的主力工具本来就是后者。mysqldumpslow 的价值只在于「30 秒快速扫一眼」。

用方案一跑一下我们的日志（`-s c` 按出现次数排序）：

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/work" -w /work perl:slim perl mysqldumpslow.pl -s c slow.log
```

输出类似这样（行数、耗时以你的实际环境为准，重点看相对关系）：

```
Reading mysql slow query log from slow.log
Count: 254  Time=2.23s (566s)  Lock=0.00s (0s)  Rows=0.0 (0), root[root]@localhost
  SELECT * FROM user WHERE city = 'S' LIMIT N

Count: 30  Time=2.62s (78s)  Lock=0.00s (0s)  Rows=100.0 (3000), root[root]@localhost
  SELECT * FROM user WHERE name LIKE 'S'

Count: 20  Time=2.32s (46s)  Lock=0.00s (0s)  Rows=1.0 (20), root[root]@localhost
  SELECT * FROM user WHERE phone = 'S'

Count: 5  Time=22.63s (113s)  Lock=0.00s (0s)  Rows=0.0 (0), root[root]@localhost
  SELECT * FROM orders o JOIN user u ON o.user_id = u.id WHERE u.phone = 'S'
```

{% asset_img slowdump.png 结果截图 %} 

309 条日志，瞬间收敛成 4 行。注意看 SQL 部分：手机号变成了 `'S'`、数字变成了 `N`——这就是**归一化**：工具把具体参数抹掉，让「同一条 SQL 的不同参数」合并统计。这是所有慢日志分析工具的地基思想，记住它。

输出三列的含义：

- `Count`：这类 SQL 出现了多少次
- `Time=0.01s (3s)`：平均耗时（括号里是总耗时）
- `Rows=100.0 (30000)`：平均返回行数（总行数）

常用参数速查：

| 参数 | 作用 |
| --- | --- |
| `-s c` | 按出现次数排序 |
| `-s t` | 按总耗时排序（最常用） |
| `-s at` | 按平均耗时排序 |
| `-s r` | 按返回行数排序 |
| `-t N` | 只看前 N 条（N 超过实际种类数时打印完会报 `Died`，忽略即可） |
| `-g "user"` | 只显示匹配关键字的 |
| `-r` | 倒序 |

把 `-s c` 换成 `-s t`，排行榜立刻变脸：D（300 次）掉到榜外，单次 8 秒的 C 也只排第 3——**排序维度不同，「最值得修」的答案就不同**。那到底该按什么排？这是第二步要解决的。

## 第二步：排序 —— pt-query-digest 看总耗时

mysqldumpslow 每类 SQL 只给一行汇总，回答不了「该按什么排、每条 SQL 的耗时分布长什么样」。主力工具出场。

### 安装

```bash
# macOS
brew install percona-toolkit

# Ubuntu / Debian
sudo apt-get install -y percona-toolkit

# CentOS / RHEL
sudo yum install -y percona-toolkit
```

不想在本地装东西？纯 Docker 方案，管道把日志喂进去，零安装：

```bash
docker exec mysql8new sh -c 'cat /var/lib/mysql/*-slow.log' \
  | docker run --rm -i --entrypoint pt-query-digest percona/percona-toolkit
```

### 报告三段式

已把日志拷到本地的话，直接 `pt-query-digest slow.log > report.txt`。报告很长，但结构只有三段，逐段看。

**第一段：Overall 总览**

```javascript
# Overall: 309 total, 4 unique, 0.26 QPS, 0.67x concurrency ______________
# Time range: 2026-09-14T01:38:13 to 2026-09-14T01:58:22
# Attribute          total     min     max     avg     95%  stddev  median
# ============     ======= ======= ======= ======= ======= ======= =======
# Exec time           804s      2s     24s      3s      3s      3s      2s
# Rows sent          2.95k       0     100    9.77   97.36   28.81       0
# Rows examine       2.88G   9.06M   9.54M   9.53M   9.30M  57.21k   9.30M
```

第一个震撼时刻：**309 条日志，去重后只有 4 种 SQL**（4 unique）。总 Exec time 804 秒——13 分多钟，这就是今天被慢查询吃掉的数据库时间，后面所有「占比」都以它为分母。

**第二段：Profile 排行榜（全文重点）**

```javascript
# Profile
# Rank Query ID                            Response time  Calls R/Call  V/M   Item
# ==== =================================== ============== ===== ======= ===== ==============
#    1 0x4B68DD7E96F230792BFE9B964CA8A6A3  566.1985 70.4%   254  2.2291  0.00 SELECT user
#    2 0x44DC2EE7E786426F369AF7630343627D  113.1496 14.1%     5 22.6299  0.03 SELECT orders user
#    3 0x62AB604B68EFF994F6A2C7CF5282FC22   78.5482  9.8%    30  2.6183  0.01 SELECT user
#    4 0x883EB8B03DF5D50F266541A7BD36C1FE   46.3614  5.8%    20  2.3181  0.00 SELECT user
```
{% asset_img rs_time.png Profile 段截图 %} 

逐列拆解：

| 列 | 含义 |
| --- | --- |
| Rank | 排名 |
| Query ID | 指纹的校验和，每种 SQL 的唯一身份证 |
| Response time | **总耗时 + 占比**，默认按它降序——这就是「最值得修」排行榜 |
| Calls | 调用次数 |
| R/Call | 单次平均耗时 |
| V/M | 方差均值比，衡量耗时稳定性，第三步详解 |
| Item | 涉及的表 |

看这两个反差，这是全文最想让你记住的：

- **单次最慢的 C（22.6 秒）只排第 2**——一天就跑 5 次，总共吃掉 113 秒；
- **次数最多的 D（254 次）霸榜**——单次 2.2 秒看似平庸，254 × 2.23s = 566 秒，吃掉总耗时的 70.4%。

「总耗时第一」和「单次最慢」根本不是同一条。修好 D 这一条，等于把今天被慢查询吃掉的数据库时间砍掉七成；而如果按直觉去修单次最慢的 C，收益只有它的五分之一。**这就是为什么排序要看总耗时，而不是单次最慢。**

**第三段：单查询详情**

排行榜往下，每种 SQL 有一段详细指标。截取 Rank 1（D）的：

```javascript
# Query 1: 0.21 QPS, 0.47x concurrency, ID 0x4B68DD7E96F230792BFE9B964CA8A6A3 at byte 65315
# Attribute    pct   total     min     max     avg     95%  stddev  median
# ============ === ======= ======= ======= ======= ======= ======= =======
# Count         82     254
# Exec time     70    566s      2s      3s      2s      2s    90ms      2s
# Lock time     83   631us     1us    11us     2us     2us     1us     1us
# Rows sent      0       0       0       0       0       0       0       0
# Rows examine  82   2.37G   9.54M   9.54M   9.54M   9.54M       0   9.54M
# Query size    83  12.69k      50      53   51.16   51.63    1.20   49.17
# String:
# Databases    mydb
# Hosts        localhost
# Users        root
# Query_time distribution
#   1us
#  10us
# 100us
#    1ms
#   10ms
#  100ms
#     1s  ################################################################
#   10s+
SELECT * FROM user WHERE city = '北京' LIMIT 100
```
{% asset_img detail.png 单查询详情段截图 %} 

信息量很大，第三步专门解读。

### 常用进阶参数

| 参数 | 作用 | 示例 |
| --- | --- | --- |
| `--since` | 只分析某时刻之后的日志 | `--since "2026-09-14 10:00:00"` |
| `--until` | 只分析某时刻之前的日志 | 配合 since 切出告警前后 1 小时 |
| `--order-by` | 换排序指标（默认 `Query_time:sum`） | `--order-by=Rows_examined:sum` |
| `--limit` | 只看前 N 种 SQL | `--limit=10` |
| `--filter` | 按条件过滤 | `--filter '$event->{fingerprint} =~ m/^select/'` |

实战套路：线上告警 10:15 来的，`--since "10:00" --until "10:30"` 切出前后半小时的日志单独分析，比看全天的准得多。

## 第三步：解读 —— 三个数字定优先级

排行榜告诉你「修哪条」，单查询详情里的三个数字告诉你「急不急、往哪个方向修」。

### 数字 1：Rows_examined / Rows_sent

上篇说过的「判决书」，在这里升级成比值。拿详情段里的真实数字算一下：

- D：扫 9.54M 行，返回 **0** 行——比值无穷大。刚才留下的疑点揭晓：它一次都没匹配上
- A：扫 9.54M 行，返回 1 行，比值 ≈ **1000 万 : 1**
- B：扫 9.54M 行，返回 100 行，比值 ≈ **9.5 万 : 1**

经验法则：**比值超过 1000:1，基本就是缺索引或索引失效**，方向明确，不用犹豫。

D 还顺手戳破了一个常见幻觉：**LIMIT 不是缺索引的护身符**。`LIMIT 100` 只有在「扫到 100 个匹配行就能提前收工」时才成立；我们这份数据里它一行都没匹配上（Rows sent 恒为 0），LIMIT 永远凑不齐，于是每次都老老实实全表扫描 954 万行。无索引 + 高频 + 全表扫，三个条件凑齐——这就是它能以 254 次调用吃掉 70% 数据库时间的原因。

### 数字 2：95% 分位，而不是 avg

详情段里 avg 旁边永远站着 95%。我们这份日志里每条 SQL 的 avg 和 95% 几乎重合（都很稳定），但生产上 **avg 会撒谎**：一条 SQL 跑 100 次，95 次走缓存 10ms、5 次全表扫 3 秒，avg 只有 160ms，看起来人畜无害；但 95% 分位会告诉你「最慢的那 5% 请求等了 3 秒」——那才是用户的真实体感。定优化目标时，盯 95% 分位。

### 数字 3：V/M（方差均值比）

先看我们自己的数据：四条 SQL 的 V/M 全在 0.00~0.03——**清一色稳定慢，全是结构性问题**，方向统一指向缺索引，这正是本系列要解决的。

- V/M ≈ 0：每次都一样慢 → **结构性问题**，缺索引 / 索引失效，改 SQL 或加索引；
- V/M 很大（线上经常 >1）：同一条 SQL 忽快忽慢 → **偶发问题**，大概率是锁等待、IO 抖动、Buffer Pool 抖动。先去查 `Lock_time` 和当时的主机监控，别急着加索引。

### 优先级判断矩阵（建议收藏）

| 总耗时占比 | Rows_examined | V/M | 结论 |
| --- | --- | --- | --- |
| 高 | 高 | 小 | **立刻修**，方向：缺索引 / 索引失效 |
| 高 | 低 | 大 | 先查锁竞争、IO、资源争抢 |
| 低 | 高 | 小 | 是真问题但不急，排期修 |
| 低 | 低 | — | 噪音，忽略 |

套到我们的 4 条上：D 霸榜（占比 70.4% + 全表扫描 + V/M≈0），立刻修，方向明确；B、A 同样是「高扫描 + 稳定慢」，跟着修；C 单次 22.6 秒全场最吓人、占比 14.1% 也不低，但它是 JOIN 缺索引——第四篇的主角，到时候连 JOIN 的索引原理一起收拾。

## 三个必踩的坑

### 坑 1：盯着「单次最慢」修

新人的第一反应都是「哪条最慢修哪条」。看看我们的排行榜：单次 22.6 秒的 JOIN 一天跑 5 次，单次 2.2 秒的查询一天跑 254 次——后者总耗时是前者的 5 倍。**数据库时间才是钱，总耗时才是收益。** pt-query-digest 默认按 `Query_time:sum` 排序，就是把这个认知内置成了默认值。

### 坑 2：忘了慢日志是「抽样」，结论有偏差

慢日志只记录两种 SQL：超过 `long_query_time` 的，以及（开了开关的话）没走索引的。这意味着：

- 一条 0.9 秒、一天跑 10 万次的 SQL，在阈值 1 秒的日志里**一条都没有**——但它一天能吃掉 25 小时的数据库时间。慢日志的分析结论只代表「被记录的那部分流量」，别把它当成全部负载；
- 反过来，开了 `log_queries_not_using_indexes` 后，一堆「快但没走索引」的 SQL 也会进日志，看排行榜时注意：**Calls 高 ≠ 总耗时高**，别被调用次数带偏——这也正是要看 Profile 占比列的原因。

想看全量负载画像？那是 performance_schema 的活，慢日志管不了——这个系列收官篇的方法论总结里会再提。

### 坑 3：在生产机器上直接跑 pt-query-digest

几百 MB 的慢日志，pt-query-digest 跑起来要吃一波 CPU 和内存。生产机本来就慢，再压一下就是事故。**正确姿势：把日志拷到线下分析。**

```bash
scp 生产机:/var/lib/mysql/slow.log ./slow.log
pt-query-digest --since "2026-09-14 10:00:00" slow.log > report.txt
```

本文的管道命令（`docker exec ... cat | pt-query-digest`）天然就是这个姿势：远程取日志、本地分析。

另外一个小提醒：报告里的 SQL 是归一化后的指纹（`WHERE phone = ?`），想看真实参数值，去单查询详情段末尾的 sample query 找。

## 小结

慢日志分析三步法，一句话总结：

**先聚合**（指纹归类，309 条变 4 种）→ **再排序**（按总耗时出排行榜：单次 22.6 秒的只排第 2，2.2 秒 × 254 次的霸榜）→ **后解读**（Rows_examined 定方向、95% 分位定体感、V/M 定性质）。

到这里，我们手里已经有了一份优先级清单。但 pt-query-digest 只告诉我们「它们各扫了 900 多万行」，回答不了**为什么**——是没有索引？有索引但没走？还是优化器选错了执行计划？

下一篇，我们挑榜单上的 `name LIKE '%34567'` 做「解剖」：《读懂 EXPLAIN：一条慢 SQL 的解剖报告（附 type/key/Extra 速查表）》。