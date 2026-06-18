# 微信小程序电商系统 - 需求文档

## 1. 项目概述

一个完整的微信小程序电商系统，包含商品展示、购物车、订单管理等核心功能。

## 2. 系统架构

| 模块 | 目录 | 技术栈 | 端口 |
|------|------|--------|------|
| 后端API | backend | Node.js + Express + SQLite | 3000 |
| 管理后台 | frontend-admin | React + Vite + Ant Design | 8081 |
| 小程序端 | frontend-mp | 微信原生小程序 | - |

## 3. 功能需求

### 3.1 后端 API (backend)

- 用户管理（登录、注册）
- 商品管理（CRUD）
- 分类管理
- 订单管理
- 购物车管理

### 3.2 管理后台 (frontend-admin)

- 管理员登录
- 商品管理界面
- 订单管理界面
- 数据统计面板

### 3.3 小程序端 (frontend-mp)

- 商品列表/详情
- 购物车
- 下单流程
- 我的订单

## 4. Docker 规范

- 每个子项目包含独立 Dockerfile
- 基础镜像支持 ARM 和 X86 架构
- 使用 docker-compose 统一编排
- 前端服务映射端口从 8081 开始

## 5. 数据模型

### User (用户)
- id, openid, nickname, avatar, phone, created_at

### Product (商品)
- id, name, description, price, stock, category_id, image, status, created_at

### Category (分类)
- id, name, sort_order

### Order (订单)
- id, user_id, total_amount, status, address, created_at

### OrderItem (订单项)
- id, order_id, product_id, quantity, price

### Cart (购物车)
- id, user_id, product_id, quantity
