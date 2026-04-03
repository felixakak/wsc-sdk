// ConnectionScheduler 优先级调度
class ConnectionScheduler {
  private static queue: { task: () => void; priority: number }[] = [];
  private static running = 0;
  private static maxConcurrent = 2;

  static schedule(task: () => void, priority = 0) {
    this.queue.push({ task, priority });
    this.queue.sort((a, b) => b.priority - a.priority);
    this.run();
  }

  private static run() {
    if (this.running >= this.maxConcurrent) return;
    if (!this.queue.length) return;

    const { task } = this.queue.shift()!;
    this.running++;

    try {
      task();
    } finally {
      setTimeout(() => {
        this.running--;
        this.run();
      }, 200);
    }
  }
}

// ID 生成器
class IdGenerator {
  private counter = 0;
  next() {
    return `${Date.now().toString(36)}-${(this.counter++).toString(36)}`;
  }
}

type WSStatus = "idle" | "connecting" | "open" | "closed";

interface WSOptions {
  url: string;

  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  maxBackoff?: number;

  heartbeatInterval?: number;
  heartbeatTimeout?: number;

  ackTimeout?: number;
  maxRetries?: number;

  queueMaxSize?: number;
  earlyAckTTL?: number;

  debug?: boolean;
  clientId?: string;
}

interface PendingMessage {
  payload: string;
  retries: number;
  timer?: number;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private status: WSStatus = "idle";

  private options: Required<WSOptions>;

  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private connectPromise: Promise<void> | null = null;

  // 心跳
  private heartbeatTimer: number | null = null;
  private heartbeatCheckTimer: number | null = null;
  private lastPongTime = 0;
  private lastPingTime = 0;

  // RTT
  private rtt = 0;
  private srtt = 0;
  private rttVar = 0;

  private manuallyClosed = false;

  private messageQueue: string[] = [];
  private pendingMap = new Map<string, PendingMessage>();
  private earlyAckMap = new Map<string, number>();

  private idGen = new IdGenerator();
  private visibilityPending = false;
  private earlyAckCleaner: number | null = null;

  constructor(options: WSOptions) {
    this.options = {
      reconnectInterval: 1000,
      maxReconnectAttempts: 10,
      maxBackoff: 30000,

      heartbeatInterval: 5000,
      heartbeatTimeout: 10000,

      ackTimeout: 5000,
      maxRetries: 3,

      queueMaxSize: 1000,
      earlyAckTTL: 10000,

      debug: false,
      clientId: options.clientId || this.genClientId(),

      ...options
    };

    this.handleVisibilityChange();
    this.startEarlyAckCleaner();
  }

  private genClientId() {
    return "c-" + Math.random().toString(36).slice(2, 10);
  }

  // connect 连接
  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      if (this.status === "open") {
        this.connectPromise = null;
        return resolve();
      }

      this.manuallyClosed = false;
      this.cleanupWS();
      this.status = "connecting";

      const ws = new WebSocket(this.options.url);
      this.ws = ws;

      ws.onopen = () => {
        this.status = "open";
        this.reconnectAttempts = 0;

        this.cleanupEarlyAck();
        this.flushQueue();
        this.resendPending();

        this.startHeartbeat();

        this.onOpen?.();

        this.connectPromise = null;
        resolve();
      };

      ws.onmessage = (e) => this.handleMessage(e.data);

      ws.onclose = () => {
        this.status = "closed";

        this.stopHeartbeat();
        this.clearPendingTimers();
        this.earlyAckMap.clear();

        this.onClose?.();

        this.connectPromise = null;

        if (!this.manuallyClosed) this.tryReconnect();
      };

      ws.onerror = (err) => {
        this.onError?.(err);
        this.connectPromise = null;
        reject(err);
      };
    });

    return this.connectPromise;
  }

  // retry 重试
  retry() {
    this.manuallyClosed = false;
    this.reconnectAttempts = 0;

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.cleanupWS();

    ConnectionScheduler.schedule(() => this.connect(), 10);
  }

  // ========================
  // 心跳（RTT + 平滑）
  // ========================
  private startHeartbeat() {
    this.stopHeartbeat();

    this.lastPongTime = Date.now();

    this.heartbeatTimer = window.setInterval(() => {
      this.lastPingTime = Date.now();

      this.send({
        type: "ping",
        ts: this.lastPingTime
      });
    }, this.options.heartbeatInterval);

    this.heartbeatCheckTimer = window.setInterval(() => {
      if (Date.now() - this.lastPongTime > this.options.heartbeatTimeout) {
        this.log("heartbeat timeout");
        this.ws?.close();
      }
    }, this.options.heartbeatInterval);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.heartbeatCheckTimer) clearInterval(this.heartbeatCheckTimer);
  }

  // ========================
  // 消息处理
  // ========================
  private handleMessage(raw: string) {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === "pong") {
        this.lastPongTime = Date.now();

        if (msg.ts) {
          this.updateRTT(Date.now() - msg.ts);
        }
        return;
      }

      if (msg.ack) {
        this.handleAck(msg.ack);
        return;
      }

      this.onMessage?.(msg);
    } catch {
      this.onMessage?.(raw);
    }
  }

  // ========================
  // RTT 平滑
  // ========================
  private updateRTT(rtt: number) {
    this.rtt = rtt;

    if (this.srtt === 0) {
      this.srtt = rtt;
      this.rttVar = rtt / 2;
    } else {
      const alpha = 0.125;
      const beta = 0.25;

      this.rttVar = (1 - beta) * this.rttVar + beta * Math.abs(this.srtt - rtt);
      this.srtt = (1 - alpha) * this.srtt + alpha * rtt;
    }

    this.adjustHeartbeat();
  }

  private adjustHeartbeat() {
    const old = this.options.heartbeatInterval;

    const rto = this.srtt + Math.max(100, 4 * this.rttVar);
    let next = Math.max(3000, Math.min(rto, 20000));

    if (Math.abs(next - old) < 500) return;

    this.options.heartbeatInterval = next;
    this.options.heartbeatTimeout = next * 2;

    this.log("heartbeat adjust:", next, "srtt:", this.srtt);

    this.startHeartbeat();
  }

  // send 发送消息
  send(data: any) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    this.sendRaw(payload);
  }

  sendWithAck(data: any, customId?: string) {
    const id = customId || this.idGen.next();

    // earlyAck 检查
    const earlyTs = this.earlyAckMap.get(id);
    if (earlyTs && Date.now() - earlyTs < this.options.earlyAckTTL) {
      this.log("earlyAck hit → skip send", id);
      this.earlyAckMap.delete(id);
      return id;
    }

    const payload = JSON.stringify({
      id,
      clientId: this.options.clientId,
      ...data
    });

    const pending: PendingMessage = {
      payload,
      retries: 0
    };

    this.pendingMap.set(id, pending);

    this.sendRaw(payload);

    this.bindAckTimer(id, pending);

    return id;
  }

  private sendRaw(payload: string) {
    if (this.ws && this.status === "open") {
      this.ws.send(payload);
    } else {
      this.enqueue(payload);
    }
  }

  // ========================
  // ACK
  // ========================
  private handleAck(id: string) {
    const pending = this.pendingMap.get(id);

    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      this.pendingMap.delete(id);
      return;
    }

    // 提前 ACK
    this.earlyAckMap.set(id, Date.now());
  }

  private bindAckTimer(id: string, p: PendingMessage) {
    p.timer = window.setTimeout(() => {
      if (!this.pendingMap.has(id)) return;

      if (p.retries >= this.options.maxRetries) {
        this.pendingMap.delete(id);
        this.onAckFailed?.(id);
        return;
      }

      p.retries++;
      this.sendRaw(p.payload);
      this.bindAckTimer(id, p);
    }, this.options.ackTimeout);
  }

  private clearPendingTimers() {
    this.pendingMap.forEach((p) => {
      if (p.timer) clearTimeout(p.timer);
    });
  }

  private resendPending() {
    this.pendingMap.forEach((p, id) => {
      this.sendRaw(p.payload);
      this.bindAckTimer(id, p);
    });
  }

  // ========================
  // 重连
  // ========================
  private tryReconnect() {
    if (this.manuallyClosed) return;

    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.onReconnectFailed?.();
      return;
    }

    const delay = Math.min(this.options.reconnectInterval * 2 ** this.reconnectAttempts, this.options.maxBackoff);

    this.reconnectAttempts++;

    this.reconnectTimer = window.setTimeout(
      () => {
        ConnectionScheduler.schedule(() => this.connect(), 1);
      },
      delay + Math.random() * 1000
    );
  }

  // ========================
  // 队列
  // ========================
  private enqueue(msg: string) {
    if (this.messageQueue.length >= this.options.queueMaxSize) {
      this.messageQueue.shift();
    }
    this.messageQueue.push(msg);
  }

  private flushQueue() {
    while (this.messageQueue.length && this.ws) {
      this.ws.send(this.messageQueue.shift()!);
    }
  }

  // ========================
  // earlyAck
  // ========================
  private cleanupEarlyAck() {
    const now = Date.now();
    this.earlyAckMap.forEach((ts, id) => {
      if (now - ts > this.options.earlyAckTTL) {
        this.earlyAckMap.delete(id);
      }
    });
  }

  private startEarlyAckCleaner() {
    this.earlyAckCleaner = window.setInterval(() => {
      this.cleanupEarlyAck();
    }, this.options.earlyAckTTL);
  }

  // handleVisibilityChange 处理页面前后台切换
  private handleVisibilityChange() {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;

      if (this.visibilityPending) return;
      this.visibilityPending = true;

      setTimeout(() => {
        this.visibilityPending = false;

        if (this.status !== "open") {
          ConnectionScheduler.schedule(() => this.connect(), 5);
        }
      }, 300);
    });
  }

  // close 关闭连接
  close() {
    this.manuallyClosed = true;

    this.stopHeartbeat();
    this.clearPendingTimers();
    this.cleanupWS();
    this.earlyAckMap.clear();

    if (this.earlyAckCleaner) clearInterval(this.earlyAckCleaner);

    this.status = "closed";
  }

  private cleanupWS() {
    if (!this.ws) return;

    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onclose = null;
    this.ws.onerror = null;

    try {
      this.ws.close();
    } catch {}

    this.ws = null;
  }

  // ========================
  // API
  // ========================
  getRTT() {
    return this.rtt;
  }

  getSmoothedRTT() {
    return this.srtt;
  }

  getStatus() {
    return this.status;
  }

  isConnected() {
    return this.status === "open";
  }

  getPendingCount() {
    return this.pendingMap.size;
  }

  // ========================
  // hooks
  // ========================
  onOpen?: () => void;
  onMessage?: (data: any) => void;
  onClose?: () => void;
  onError?: (err: Event) => void;
  onReconnectFailed?: () => void;
  onAckFailed?: (id: string) => void;

  // log 日志打印
  private log(...args: any[]) {
    if (this.options.debug) {
      console.log("[WS]", ...args);
    }
  }
}
