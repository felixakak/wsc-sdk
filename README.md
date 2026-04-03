# 🚀 工业级 WebSocket 客户端 (WSC-SDK) 技术文档

这是一个高可靠、高性能的 WebSocket 封装库，专为复杂的即时通讯、实时金融行情及协同办公场景设计。它不仅解决了基础的连接管理，更引入了 **TCP 拥塞控制算法原理** 和 **全局任务调度机制**。

# 🌟 核心特性说明

**1. 🧠 自适应网络感知 (SRTT & RTTVar)**

本 SDK 摒弃了死板的固定心跳，实现了基于 RFC 6298 标准的平滑往返时延（SRTT）估计算法：
    - **SRTT (Smoothed Round-Trip Time):** 过滤网络瞬时毛刺，反映真实的链路延迟。
    - **RTTVar (RTT Variation):** 衡量网络抖动程度。
    - **动态心跳 (Dynamic Heartbeat):** 自动根据 $SRTT + 4 \times RTTVar$ 计算最优重传超时（RTO），在弱网环境下自动放宽容忍度，减少误断连。

**2. 🚦 全局优先级调度器 (ConnectionScheduler)**

通过中央调度器管理所有实例的连接行为：
    - **并发限流:** 默认限制同时握手数量为 2，防止页面加载时大量 WS 同时连接抢夺带宽。
    - **优先级排队:** \* P10 (最高): 用户手动点击重连（retry）。
      - **P5 (中等):** 页面从后台切回前台（visibilitychange）。
      - **P1 (最低):** 断线后的指数退避自动重连。

**3. 🛡️ 消息可靠性投递 (ACK & Early-Ack)** 
    - **应用层 ACK:** 支持 sendWithAck，在未收到服务端确认时自动重试。
    - **Early-Ack 镜像:** 解决“确认包比数据包先到”的极端网络时序问题，防止无效重传。
    - **顺序离线队列:** 连接断开时，非 ACK 消息进入 messageQueue，重连后按序冲刷。

**4. 🔒 异步并发状态锁**

内置 connectPromise 状态锁。当多个业务逻辑同时触发连接时，SDK 确保只发起一个物理连接，所有调用方共享同一个 Promise 结果。

# 📦 快速上手

**1. 初始化**

```TypeScript
import { WebSocketClient } from './WebSocketClient';

const client = new WebSocketClient({
  url: 'wss://your-server.com/ws',
  debug: true,
  clientId: 'device-unique-id', // 可选，用于多端识别
  heartbeatInterval: 5000,
  maxReconnectAttempts: 5
});
```

**2. 基础通信**

```TypeScript
// 建立连接
await client.connect();

// 发送普通消息
client.send({ type: 'ping' });

// 监听消息
client.onMessage = (data) => {
  console.log('收到消息:', data);
};
```

**3. 可靠发送 (ACK 模式)**

此模式要求服务端在收到消息后，返回包含相同 id 的消息，例如：{"ack": "msg-123"}。

```TypeScript
const msgId = client.sendWithAck({
  type: 'chat',
  content: '重要通知'
});

client.onAckFailed = (id) => {
  console.error(`消息 ${id} 发送失败，已超过最大重试次数`);
};
```

# 🛠️ API 参考

**方法 (Methods)**

| 方法名              | 说明                               |
| :------------------ | :--------------------------------- |
| `connect()`         | 发起连接（带并发锁，返回 Promise） |
| `retry()`           | 手动高优先级重连                   |
| `send(data)`        | 发送普通 JSON 或字符串消息         |
| `sendWithAck(data)` | 发送需回执的消息，内置自动重试机制 |
| `close()`           | 彻底关闭连接并销毁所有定时器       |
| `getSmoothedRTT()`  | 获取当前平滑后的网络延迟 (ms)      |

**回调钩子 (Hooks)**

- `onOpen()`: 连接建立成功。
- `onMessage(data)`: 收到业务消息。
- `onClose()`: 连接关闭。
- `onAckFailed(id)`: 消息重试耗尽后的失败回调。

# 📉 配置项 (WSOptions)

| 参数                | 类型     | 默认值 | 描述                 |
| :------------------ | :------- | :----- | :------------------- |
| `reconnectInterval` | `number` | 1000   | 初始重连间隔         |
| `maxBackoff`        | `number` | 30000  | 最大重连退避时间     |
| `heartbeatTimeout`  | `number` | 10000  | 心跳超时判定阈值     |
| `maxRetries`        | `number` | 3      | ACK 消息最大重试次数 |
| `earlyAckTTL`       | `number` | 10000  | 提前确认包的有效期   |

# 💡 开发建议
  1. **资源释放:** 在前端框架（如 React/Vue）的组件卸载生命周期内，务必调用 client.close()。
  2. **服务端配合:** 请确保服务端能正确识别并返回消息 id 以完成 ACK 闭环。
  3. **状态监控:** 可以利用 getSmoothedRTT() 实时展示用户的网络质量图标（绿/黄/红灯）。
