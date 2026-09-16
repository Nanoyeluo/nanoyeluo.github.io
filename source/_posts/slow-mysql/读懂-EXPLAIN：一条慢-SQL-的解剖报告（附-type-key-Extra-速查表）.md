---
title: 读懂 EXPLAIN：一条慢 SQL 的解剖报告（附 type/key/Extra 速查表）
tags:
  - Mysql
categories:
  - 数据库
date: 2026-09-15 00:00:00
---


> 慢查询系列 · 第 3 篇。上一篇我们用 pt-query-digest 从 309 条慢日志里筛出了修复优先级清单（没看过的建议先读：[《慢日志太多看不过来？pt-query-digest 三步定位最值得修的 Top SQL》](https://nanoyeluo.github.io/2026/09/13/%E6%85%A2%E6%97%A5%E5%BF%97%E5%A4%AA%E5%A4%9A%E7%9C%8B%E4%B8%8D%E8%BF%87%E6%9D%A5%EF%BC%9Fpt-query-digest-%E4%B8%89%E6%AD%A5%E5%AE%9A%E4%BD%8D%E6%9C%80%E5%80%BC%E5%BE%97%E4%BF%AE%E7%9A%84-Top-SQL/)）。但报告只告诉我们「它们各扫了 900 多万行」，回答不了**为什么**。这篇请出 MySQL 自带的解剖刀——EXPLAIN，把榜单上的慢 SQL 一条条剖开。
<!--more-->

## 前言：报告到手，该动刀了

上篇结尾，我们手里有了一份优先级清单：

| 排名 | SQL | 总耗时占比 | 单次耗时 | 调用次数 |
| --- | --- | --- | --- | --- |
| 1 | D：`city = '北京' LIMIT 100` | 70.4% | 2.2s | 254 |
| 2 | C：orders JOIN user | 14.1% | 22.6s | 5 |
| 3 | B：`name LIKE '%34567'` | 9.8% | 2.6s | 30 |
| 4 | A：`phone = '13800001111'` | 5.8% | 2.3s | 20 |

pt-query-digest 还告诉了我们一件事：这四条每条都扫了 900 多万行。但它的能力到此为止——**为什么扫这么多**？是没索引、有索引没走、还是优化器选错了？回答这个问题，要靠 MySQL 自带的解剖刀：**EXPLAIN**。

EXPLAIN 不执行 SQL，只告诉你优化器**打算怎么执行**它：访问哪张表、用哪个索引、大概扫多少行。MySQL 8.0 还带了 EXPLAIN ANALYZE，能真实执行并汇报实际耗时——一个看「计划」，一个看「实况」：

```mermaid
flowchart LR
    A[慢 SQL] --> B[EXPLAIN<br>看执行计划]
    B --> C[EXPLAIN ANALYZE<br>看真实执行]
    C --> D[加索引 / 改写 SQL]
    D --> E[重跑验证<br>回归榜单]
```

本篇解剖对象选 B（`name LIKE '%34567'`），不选榜首 D——因为 D 只是单纯缺索引，而 B 能讲出本系列最重要的一个原理：**有索引，也可能用不上**。讲完 B，顺手把 D 和 A 也修了，给上篇的榜单收个尾。

环境沿用前两篇（Docker + MySQL 8.0.43，容器 `mysql8`，库 `mydb`，`user` 表 1000 万行），所有命令可直接复制复现。

## 第 0 步：拿到解剖对象

上篇说过，pt-query-digest 报告里的 SQL 是归一化后的指纹，真实参数要去单查询详情段末尾的 sample query 找。B 的样本是：

```sql
SELECT * FROM user WHERE name LIKE '%34567';
```

这就是今天的解剖台。

## EXPLAIN 初体验：逐字段拆解

解剖刀用法极简：SQL 前面加 `EXPLAIN`（结尾用 `\G` 竖排显示，字段多时看得清）：

```sql
EXPLAIN SELECT * FROM user WHERE name LIKE '%34567'\G
```

输出（rows 是估算值，你的环境数字会不同，重点看 type 和 key）：

```javascript
*************************** 1. row ***************************
           id: 1
  select_type: SIMPLE
        table: user
   partitions: NULL
         type: ALL
possible_keys: NULL
          key: NULL
      key_len: NULL
          ref: NULL
         rows: 9866126
     filtered: 11.11
        Extra: Using where
```

{% asset_img explain.png explain结果截图 %} 

12 个字段，先给一句话「验尸报告」：**全表扫描（type=ALL），没有任何索引可用（possible_keys=NULL），估算要扫约 986 万行（rows），过滤后预计只剩 11%（filtered）**——和上篇 pt-query-digest 报的「扫 954 万行」完全对得上。上篇的 Rows_examined 是「验尸结果」，这里的 rows 是「生前预告」。

逐字段过一遍，详略分明：
| 字段 | 含义 |
|---|---|
| **id** | 查询的执行序号。单表查询永远是 1；多表 / 子查询时，序号大的先执行，相同则从上往下。|
| **select_type** |  查询类型。SIMPLE（无子查询 / UNION）、PRIMARY、SUBQUERY、DERIVED（派生表）、UNION 等，日常 90% 是 SIMPLE。|
| **table** |这一行在访问哪张表。JOIN 时会有多行，一张表一行。|
| **partitions** |命中的分区，没分区就是 NULL。|
| **type（重点）** |访问类型，EXPLAIN 里最重要的字段，直接回答「怎么扫的」。本次是 ALL——全表扫描，1000 万行一行一行过。从好到坏的完整梯队见[速查表 1](#速查表-1：type-从好到坏)。|
| **possible_keys / key（重点）** |「能用哪些索引」和「实际用了哪个」。本次两个都是 NULL：name 列上压根没有索引，想用都没得用。组合判读见[速查表 2](#速查表-2：possible-keys-key-组合判读)。|
| **key_len** |实际用到的索引长度（字节），可以判断联合索引用到了前几列——联合索引是下篇的内容，这里先记住它能「量长度」。|
| **ref** |索引被拿来和什么比较：const（常量）、某个字段、func 等。|
| **rows（重点）** |优化器**估算**要扫描的行数。注意是估算——基于统计信息，可能偏（[坑 1](#坑-1：rows-是估算值，不是真实值) 细说）|
| **filtered** | 按 WHERE 条件过滤后，预计剩下百分之多少的行。11.11 意味着优化器认为扫 996 万行后还剩约 110 万行（实际只返回 100 行——估算又偏了，[坑 1](#坑-1：rows-是估算值，不是真实值) 见）。|
| **Extra（重点）** |优化器的「备注栏」。本次 Using where：存储引擎把行读出来后，Server 层再按 WHERE 过滤——言下之意，过滤动作没能在索引里完成。常见值见[速查表 3](#速查表-3：Extra-高频值)。|
### 速查表 1：type 从好到坏

| type | 含义 | 典型场景 |
| --- | --- | --- |
| system | 表里只有一行 | 系统表 |
| const | 主键 / 唯一索引等值查询，一次命中 | `WHERE id = 1` |
| eq_ref | JOIN 时驱动表每行在被驱动表唯一命中 | 主键 / 唯一索引 JOIN |
| ref | 非唯一索引等值查询 | `WHERE city = '北京'`（有索引时） |
| range | 索引范围扫描 | `BETWEEN`、`>`、`IN`、`LIKE '前缀%'` |
| index | **全索引扫描**——扫遍整个索引，只是比全表扫省点 IO | 覆盖索引但没有可用的查找条件 |
| ALL | 全表扫描 | 本文案发现场 |

记忆法：const / ref / range 是「索引在干活」，index / ALL 是「在扫大街」。看到 ALL 要警觉；看到 index 别被名字迷惑——它也不是好消息（[坑 2](#坑-2：key-有值-≠-快) 细说）。

### 速查表 2：possible_keys / key 组合判读

| possible_keys | key | 判读 |
| --- | --- | --- |
| NULL | NULL | 没有索引可用——要么没建，要么建了用不上（本文的左模糊） |
| 有值 | NULL | 有索引但优化器没用——代价算不过账，或索引失效（下篇主题） |
| 有值 | 有值 | 正常走了索引，再看 type 确认走得好不好 |

### 速查表 3：Extra 高频值

| Extra | 含义 | 信号 |
| --- | --- | --- |
| Using where | 存储引擎读出行后，Server 层再过滤 | 中性，配合 type / rows 看 |
| Using index | 覆盖索引：查询列都在索引里，不用回表 | ✅ 好消息 |
| Using index condition | 索引下推（ICP）：过滤条件下推到引擎层 | ✅ 还不错 |
| Using filesort | 排序没走索引，额外排序 | ⚠️ 警报 |
| Using temporary | 用了临时表（常见于 GROUP BY） | ⚠️ 警报 |
| Using join buffer | JOIN 没索引，用缓冲区凑合 | ⚠️ 下篇见 |

## 核心原理：为什么索引救不了左模糊

不信邪，给 name 加上索引再试：

```sql
ALTER TABLE user ADD INDEX idx_name(name);
EXPLAIN SELECT * FROM user WHERE name LIKE '%34567'\G
```

```javascript
possible_keys: NULL
          key: NULL
         type: ALL
```
{% asset_img left_explain.png 模糊查询索引失败截图 %} 
索引加了，EXPLAIN 纹丝不动——possible_keys 依然是 NULL，优化器连考虑都不考虑它。

根子在 B+Tree 的**有序性**。索引本质是一本按 key 排好序的电话簿：

- 查「张%」：翻目录，张字部 → 张三、张四……一次定位；
- 查「%伟」：名字里带「伟」的人散落在整本书的每个角落，目录完全失效，只能从头翻到尾。

`LIKE '用户34567%'` 是前者，`LIKE '%34567'` 是后者。**索引的最左匹配原则就长在这棵树上**：能用索引的条件，必须能从索引的最左边开始连续匹配。左模糊一上来就是通配符，最左匹配无从谈起。

对照实验，把左模糊改成右模糊：

```sql
EXPLAIN SELECT * FROM user WHERE name LIKE '用户34567%'\G
```

```javascript
         type: range
possible_keys: idx_name
          key: idx_name
      key_len: 202
         rows: 1
        Extra: Using index condition
```

{% asset_img r-explain.png 模糊查询索引失败截图 %} 

同一张表、同一个索引，一个 `%` 的位置不同：type 从 ALL 变 range，rows 从 986 万变 1。`key_len=202` 顺便验证一下：name 是 varchar(50) utf8mb4，50 × 4 字节 + 2 字节长度前缀 = 202，说明整个 name 列都参与了索引查找。

（埋一个给下篇的细节：如果只查 `SELECT name` 而不是 `SELECT *`，左模糊也可能显示 key=idx_name、type=index——那是「全索引扫描」，1000 万个索引条目照扫，只是不回表。type=index 不是救星，[坑 2](#坑-2：key-有值-≠-快) 会说。）

## EXPLAIN ANALYZE：从「预估」到「实况」

EXPLAIN 的 rows 是估算，想看真刀真枪的执行数据，上 EXPLAIN ANALYZE（MySQL 8.0.18+）——它会**真的执行**这条 SQL，然后汇报：

```sql
EXPLAIN ANALYZE SELECT * FROM user WHERE name LIKE '%34567'\G
```

```javascript
EXPLAIN: -> Filter: (`user`.`name` like '%34567')  (cost=1.05e+6 rows=1.1e+6) (actual time=1367..2945 rows=100 loops=1)
    -> Table scan on user  (cost=1.05e+6 rows=9.87e+6) (actual time=2.28..2259 rows=10e+6 loops=1)
```

{% asset_img explain-analgy.png EXPLAIN ANALYZE 输出截图 %} 

输出是一棵执行树，从下往上读：

- 底层 `Table scan on user`：全表扫描，actual time=2.28..2259ms，**实际扫出 1000 万行（rows=10e+6），循环 1 次（loops=1）**；
- 上层 `Filter`：对扫出来的每行做 LIKE 过滤，总耗时到 1367ms，最终只吐出 100 行。

对比括号里的估算（rows=9866126）和实际（rows=10000000）：这次估算不算离谱，但上一节 filtered 推出的「剩 110 万行」和实际 100 行差了四个数量级——再次提醒，估算只是估算。

三个数字的读法：

- `actual time=a..b`：a = 返回第一行用了多少毫秒，b = 返回所有行用了多少毫秒；
- `rows`：**实际**行数，不是估算；
- `loops`：这个节点被执行了几遍——JOIN 时被驱动表会被 loop 多次，下篇有大用。

**使用边界**：EXPLAIN ANALYZE 会真实执行，SELECT 无所谓，UPDATE / DELETE 千万别在生产上随手 ANALYZE——它真的改数据。

## 优化落地：左模糊的方案矩阵 + 顺手修掉榜首

先泼冷水：**左模糊是 B+Tree 的无解区，加普通索引没救**。能做的是这些：

| 方案 | 思路 | 代价 | 适用场景 |
| --- | --- | --- | --- |
| 改写成右模糊 | `LIKE '前缀%'`，成本为零 | 语义变了，要业务认可 | 单号、编码类固定前缀查询 |
| 冗余反存列 | 加一列存 `REVERSE(name)` 并建索引，反着查 | 多一列 + 双写维护 | 后缀匹配（邮箱域名、文件扩展名） |
| FULLTEXT + ngram | 全文索引粗筛，LIKE 精筛 | 索引体积大；**低选择性查询词会候选爆炸** | 高选择性的中文关键词搜索 |
| ES / 搜索引擎 | 专业的事交给专业的系统 | 架构复杂度 | 高频、多字段复杂搜索 |

### 实测翻车：FULLTEXT 组合拳在本案例上更慢

网上很多文章会给这个「标准写法」：

```sql
ALTER TABLE user ADD FULLTEXT INDEX ft_name(name) WITH PARSER ngram;
-- ngram 把 '34567' 切成二元组分词粗筛候选，再用 LIKE 精确过滤
SELECT * FROM user WHERE MATCH(name) AGAINST('34567') AND name LIKE '%34567';
```

我照着实测了一遍，**翻车了：40 秒**——比直接全表扫描的 2 秒慢了 20 倍。

{% asset_img match.png FULLTEXT截图 %} 
{% asset_img like.png LIKE截图 %} 

拆开看原因，这个组合拳的成立有一个隐含前提：**查询词的选择性要高**。ngram 把 `'34567'` 切成 `34`、`45`、`56`、`67` 四个二元分词，命中其中**任意一个**都算候选。而我们的 name 是随机数字串，每个二元分词平均命中约 7% 的行，四个合并起来候选集接近 250 万行——「粗筛」筛完还剩四分之一张表，然后对这 250 万行逐行回表 + LIKE 精筛，随机 IO 比顺序扫一遍全表贵得多，不慢才怪。

还有个细节很讽刺：`EXPLAIN` 这条组合拳，type 显示 `fulltext`、rows 显示 1——看起来美极了。全文索引的 rows 估算基本等于没有估算，这也是坑 1 说的「估算会骗人」的极端版本。

所以修正结论：**FULLTEXT 适合高选择性关键词**（比如「北京烤鸭」这种分词候选很少的中文词）；对高频数字串、单字这类低选择性查询词，候选集爆炸，反而更慢。我们这条 SQL 的真正出路只剩两条：业务能接受就改写右模糊（成本为零）；不能接受又高频，就老老实实上 ES。


### 顺手把榜首修了

解剖完 B，回头看榜单：D 和 A 都是「列上没索引」的单纯病例，一行 ALTER 一个：

```sql
ALTER TABLE user ADD INDEX idx_city(city);    -- 修 D
ALTER TABLE user ADD INDEX idx_phone(phone);  -- 修 A（第一篇的老朋友）
```

D 修复前后对比：

```javascript
-- 修复前：type=ALL, key=NULL, rows=9940287, 单次 2.2 秒
-- 修复后：
         type: ref
possible_keys: idx_city
          key: idx_city
      key_len: 202
          ref: const
         rows: 4080400
```

type 从 ALL 变 ref，扫描方式从「全表 1000 万行翻一遍」变成「索引直接定位到 city='北京' 的条目」。按上篇的账算：D 昨天 254 次 × 2.23s = 566 秒，占慢查询总耗时的 70.4%——**这一条索引，把昨天七成的数据库时间省回来了**。A 同理，从 2.3 秒到毫秒级。

{% asset_img d-not-explain.png 修复前截图 %} 

{% asset_img d-use-expalin.png 修复后截图 %} 

至于 B：FULLTEXT 路线刚被实测排除，它的出路是右模糊改写或 ES，要等业务拍板，本篇不动它。榜单四条修了三条，还剩那条 22.6 秒的 C——它不简单，留给下篇。

## 三个必踩的坑

### 坑 1：rows 是估算值，不是真实值

EXPLAIN 的 rows 来自统计信息（采样若干索引页推算），统计过期时能偏出几个数量级——本文 filtered 估算「剩 110 万行」，实际 100 行。估算偏了的真正危险不是数字难看，而是**优化器会基于错误估算选错计划**。对策：`ANALYZE TABLE user;` 刷新统计信息；要精确数字，用 EXPLAIN ANALYZE 看 actual rows。

### 坑 2：key 有值 ≠ 快

`SELECT name FROM user WHERE name LIKE '%34567'` 在有 idx_name 时，EXPLAIN 会显示 key=idx_name——但 type 是 **index**：全索引扫描，1000 万个索引条目照样挨个过，只是索引比表小、IO 少一点，还省了回表。判断走没走「好」索引，别看 key 有没有值，看 **type 是不是 const / ref / range**。

### 坑 3：EXPLAIN 看的是「计划」，不是「执行」

EXPLAIN 展示的是优化器**打算**怎么跑。同一条 SQL，在测试库和生产库的执行计划可能完全不同——数据量不同、统计信息不同，优化器的账算得就不同。所以排查线上慢 SQL，EXPLAIN 必须在**生产库（或同数据的从库）**上跑；拿开发库的 EXPLAIN 分析线上问题，等于拿别人的体检报告给自己看病。

## 小结

解剖三件套，一句话：

**EXPLAIN 看计划**（重点盯 type / key / rows / Extra，三张速查表随用随查）→ **EXPLAIN ANALYZE 看实况**（actual time / rows / loops）→ **左模糊的根在 B+Tree 最左匹配**，加普通索引没救，要么改写、要么换引擎。

榜单四条修了三条：A 和 D 一条索引的事，B 走方案矩阵（FULLTEXT 已实测排除）。还剩那条 **22.6 秒的 JOIN**（C）——EXPLAIN 它，你会看到两张表都是 ALL，而且被驱动表的 loops 大得吓人。JOIN 的索引原理和单表不一样，MySQL 8.0 还换了 hash join 新引擎……下一篇收官：《慢查询优化的最后一步：JOIN、联合索引与覆盖索引实战（MySQL 8.0）》。