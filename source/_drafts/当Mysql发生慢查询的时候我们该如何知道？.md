---
title: 从零排查 MySQL 慢查询：慢日志 + EXPLAIN 实战（附 Docker 完整环境）
tags: [ Mysql ]
categories: [ 数据库 ]
---
线上接口突然变慢，怀疑是 SQL 问题却不知道从哪查起？本文用 Docker 搭一套可复现环境，手把手带你走完「发现 → 定位 → 分析 → 优化」全流程。
<!-- more -->

# 0. 前言：一个真实的场景

周四下午，你正在写需求，突然收到告警：订单查询接口的 P99 从 200ms 涨到了 8 秒。打开代码看了半天——逻辑很简单，就是按手机号查用户、再关联订单表，代码没有任何改动。你怀是数据库的问题，但打开 Navicat 连上生产库，又不知道从哪里查起：
```
    是哪条 SQL 慢？现在跑的 SQL 那么多。
    它为什么慢？是数据量大了，还是没走索引？
    该怎么修？加索引？改 SQL？加缓存？
```
这不是某一个人的困境。排查慢查询其实是一个有标准流程的工程问题，核心就四步：

```mermaid
flowchart LR
    A[接口响应变慢] --> B[慢查询日志]
    B --> C[发现哪条 SQL 慢]
    C --> D[pt-query-digest 定位 Top SQL]
    D --> E[EXPLAIN 分析为什么慢]
    E --> F[加索引 / 改写 SQL]
    F --> G[回归验证]
```
本文的目标很实际：读完之后，你能独立走完这四步，定位日常工作中 90% 的慢查询问题。
为了让每个步骤都能动手验证，我会先在 Docker 里搭一套带 100 万行测试数据的环境，然后故意制造三条典型的慢 SQL——等值查询缺索引、LIKE 左模糊、多表 JOIN 缺索引——逐一带大家从发现、定位、分析到优化完整走一遍。文中所有命令和 SQL 均可直接复制复现。
环境说明：MySQL 8.0.43（官方 Docker 镜像），客户端任意（本文用 docker exec 进入容器执行）。
1. 环境准备：5 分钟搭好实验环境
1.1 启动 MySQL 8.0.43
一条命令搞定：
bash
docker run -d --name mysql8 -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=root123 \
  -e MYSQL_DATABASE=mydb \
  -v mysql8-data:/var/lib/mysql \
  mysql:8.0.43
参数说明：
表格
参数	作用
--name mysql8	容器名，后面 docker exec 要用
-p 3306:3306	宿主机 3306 映射到容器 3306
MYSQL_ROOT_PASSWORD	root 密码，生产环境务必改复杂
MYSQL_DATABASE=mydb	启动时自动创建实验数据库
-v mysql8-data	数据卷持久化，删容器数据不丢
启动后验证：
bash
docker ps
docker logs mysql8
# 看到 ready for connections 即成功
1.2 建两张"故意没索引"的表
sql
CREATE TABLE `user` (
  `id`         bigint      NOT NULL AUTO_INCREMENT,
  `name`       varchar(50) NOT NULL DEFAULT '',
  `phone`      varchar(20) NOT NULL DEFAULT '',
  `email`      varchar(100) NOT NULL DEFAULT '',
  `age`        int         NOT NULL DEFAULT 0,
  `city`       varchar(50) NOT NULL DEFAULT '',
  `created_at` datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `orders` (
  `id`         bigint       NOT NULL AUTO_INCREMENT,
  `user_id`    bigint       NOT NULL,
  `amount`     decimal(10,2) NOT NULL DEFAULT 0,
  `status`     tinyint      NOT NULL DEFAULT 0,   -- 0待支付 1已支付 2已发货
  `created_at` datetime     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
注意：除了主键，一张业务索引都不加。这不是失误，是故意留的"案发现场"——后面每一条慢 SQL，都是真实会发生的问题。
1.3 造数：两条 INSERT 生成 150 万行
MySQL 8.0 支持递归 CTE，配合一张序列表做 CROSS JOIN，不用写存储过程循环：
sql
-- 序列表 0~999
CREATE TABLE seq_0_999 (n INT PRIMARY KEY);
INSERT INTO seq_0_999 (n)
WITH RECURSIVE s AS (
    SELECT 0 AS n
    UNION ALL
    SELECT n + 1 FROM s WHERE n < 999
)
SELECT n FROM s;

-- 100 万用户：1000 × 1000
INSERT INTO `user` (name, phone, email, age, city, created_at)
SELECT
    CONCAT('用户', a.n * 1000 + b.n),
    CONCAT('138', LPAD(FLOOR(RAND() * 100000000), 8, '0')),
    CONCAT('user', a.n * 1000 + b.n, '@test.com'),
    FLOOR(18 + RAND() * 60),
    ELT(FLOOR(1 + RAND() * 5), '北京', '上海', '广州', '深圳', '杭州'),
    DATE_ADD('2020-01-01', INTERVAL FLOOR(RAND() * 2000) DAY)
FROM seq_0_999 a
CROSS JOIN seq_0_999 b;

-- 50 万订单
CREATE TABLE seq_0_499 (n INT PRIMARY KEY);
INSERT INTO seq_0_499 (n)
WITH RECURSIVE s AS (
    SELECT 0 AS n
    UNION ALL
    SELECT n + 1 FROM s WHERE n < 499
)
SELECT n FROM s;

INSERT INTO orders (user_id, amount, status, created_at)
SELECT
    FLOOR(1 + RAND() * 1000000),
    ROUND(RAND() * 1000, 2),
    FLOOR(RAND() * 3),
    DATE_ADD('2024-01-01', INTERVAL FLOOR(RAND() * 365) DAY)
FROM seq_0_499 a
CROSS JOIN seq_0_999 b;

SELECT COUNT(*) FROM `user`;   -- 1000000
SELECT COUNT(*) FROM orders;   -- 500000

-- 埋点：固定一条已知手机号，后面案例要用
UPDATE `user` SET phone = '13800001111' WHERE id = 100;
这套造数思路值得单独说一句：学排查最好的方式不是背命令，而是亲手制造问题再亲手解决。造数脚本的另一个用途，是以后验证任何索引优化效果时都可以复用。
环境就绪，第一起"案件"即将发生——下一章我们打开慢查询日志，等待它现形。


