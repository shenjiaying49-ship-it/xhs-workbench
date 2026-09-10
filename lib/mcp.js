// xiaohongshu-mcp 客户端（Streamable HTTP JSON-RPC）
// 端点默认 http://localhost:18060/mcp，协议：initialize → initialized → tools/call
// 发布规则：仅自己可见 + is_original；超时 ≥850s；超时不盲重试

export class McpClient {
  constructor({ endpoint, timeoutMs = 850000 }) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.protocolVersion = "2024-11-05";
    // xiaohongshu-mcp 底层是单头less浏览器实例，并发调用会互相卡死（context deadline exceeded）
    // 所有工具调用串行排队
    this._queue = Promise.resolve();
  }

  _enqueue(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  async rpc(method, params, { timeoutMs } = {}) {
    const body = { jsonrpc: "2.0", id: Date.now() + Math.floor(Math.random() * 1000), method };
    if (params !== undefined) body.params = params;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || this.timeoutMs);
    try {
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

      const res = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const sid = res.headers.get("mcp-session-id") || res.headers.get("Mcp-Session-Id");
      if (sid) this.sessionId = sid;

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // 会话失效时重置，调用方可重试一次
        if (res.status === 404 || res.status === 400) this.sessionId = null;
        throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        const text = await res.text();
        return this.parseSse(text);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  parseSse(text) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        return JSON.parse(payload);
      } catch {
        // 跳过无法解析的行
      }
    }
    throw new Error(`MCP SSE 响应无法解析: ${text.slice(0, 200)}`);
  }

  // JSON-RPC notification：无 id，服务器通常回 202/204 空响应
  async notify(method, params) {
    const body = { jsonrpc: "2.0", method };
    if (params !== undefined) body.params = params;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const sid = res.headers.get("mcp-session-id") || res.headers.get("Mcp-Session-Id");
      if (sid) this.sessionId = sid;
      if (!res.ok && res.status !== 202 && res.status !== 204) {
        const text = await res.text().catch(() => "");
        throw new Error(`MCP notification HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  async initialize() {
    const result = await this.rpc("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "xhs-workbench", version: "1.0.0" },
    });
    if (result?.result?.protocolInfo?.protocolVersion) {
      this.protocolVersion = result.result.protocolInfo.protocolVersion;
    } else if (result?.result?.protocolVersion) {
      this.protocolVersion = result.result.protocolVersion;
    }
    await this.notify("notifications/initialized", {});
    return true;
  }

  unwrapToolResult(response) {
    const result = response?.result;
    if (response?.error) {
      throw new Error(`MCP 错误 ${response.error.code}: ${response.error.message}`);
    }
    if (!result) return result;
    const content = result.content || [];
    for (const part of content) {
      if (part.type === "text") {
        // 工具级错误（isError）：抛出让调用方走降级/重试，而不是把错误文案当数据
        if (result.isError) {
          throw new Error(String(part.text || "MCP 工具执行失败").slice(0, 200));
        }
        try {
          return JSON.parse(part.text);
        } catch {
          return part.text;
        }
      }
    }
    if (result.isError) throw new Error("MCP 工具执行失败（无错误详情）");
    return result;
  }

  async callTool(name, args = {}, { timeoutMs } = {}) {
    return this._enqueue(() => this._callTool(name, args, { timeoutMs }));
  }

  async _callTool(name, args = {}, { timeoutMs } = {}) {
    let response;
    try {
      response = await this.rpc("tools/call", { name, arguments: args }, { timeoutMs });
      if (response?.error && this.sessionId === null) {
        // 会话可能过期，重新握手后重试一次
        await this.initialize();
        response = await this.rpc("tools/call", { name, arguments: args }, { timeoutMs });
      }
    } catch (error) {
      if (this.sessionId === null || /HTTP (400|404)/.test(error.message)) {
        await this.initialize();
        response = await this.rpc("tools/call", { name, arguments: args }, { timeoutMs });
      } else {
        throw error;
      }
    }
    return this.unwrapToolResult(response);
  }

  async checkLoginStatus() {
    return this.callTool("check_login_status", {}, { timeoutMs: 45000 });
  }

  async getMyProfile() {
    return this.callTool("get_my_profile", { tab: "note" }, { timeoutMs: 120000 });
  }

  // 登录校验：优先 check_login_status；该工具较脆弱（页面 MustWaitLoad 易超时），
  // 失败时回退 get_my_profile 用昵称匹配——目的只是确认「登的是对的号」
  async verifyLogin(expected) {
    await this.initialize();
    try {
      const login = await this.checkLoginStatus();
      const text = JSON.stringify(login || "");
      const ok = !expected || text.includes(expected);
      return { ok, via: "check_login_status", login };
    } catch (error) {
      const profile = await this.getMyProfile();
      const nickname = profile?.userBasicInfo?.nickname || "";
      const text = JSON.stringify(profile || "");
      const ok = !expected || text.includes(expected);
      return {
        ok,
        via: "get_my_profile",
        nickname,
        login: profile,
        fallbackReason: String(error.message || error).slice(0, 120),
      };
    }
  }

  async publishContent({ title, content, imagePaths, tags, visibility, isOriginal }) {
    return this.callTool("publish_content", {
      title,
      content,
      images: imagePaths,
      tags,
      visibility,
      is_original: isOriginal,
    });
  }
}
