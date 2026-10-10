import type { AgentActionRecord, AgentLogEntry } from '../domain/agent-log.js';
import type { BotSettings } from '../domain/settings.js';
import type { Campaign } from '../domain/campaign.js';

// Thin client for the Control Centre API. It deliberately does not import
// src/config/env.ts (which demands Mongo/Redis URLs): the operator runs
// outside the bot, with nothing but the control URL and the admin key.

export interface StatusSnapshot {
  version: string;
  settings: BotSettings;
  workers: Array<{ processType: string; status: string; fresh: boolean }>;
  workerHealthy: boolean;
  operatorIdle: { idle: boolean; alert: boolean; cause: string | null; blockedReason: string | null };
  queues: Record<string, { waiting: number; active: number; delayed: number; completed: number; failed: number }>;
  metrics: Record<string, number>;
  safetyCeilings: Record<string, number>;
}

export interface ComplianceOverview {
  totalProfiles: number;
  assessed: number;
  pending: number;
  publicationEligible: number;
  review: number;
  blocked: number;
  seoReady: number;
}

export interface ApplyResult {
  ok: boolean;
  httpStatus: number;
  detail: string;
}

export class ControlApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'ControlApiError';
  }
}

export class ControlClient {
  private cookie = '';
  private csrf = '';

  constructor(
    private readonly baseUrl: string,
    private readonly adminKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set('cookie', this.cookie);
    return this.fetchImpl(this.url(path), { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) });
  }

  // Unauthenticated liveness probes, usable before (or without) a login.
  async probe(path: '/health' | '/ready'): Promise<{ ok: boolean; httpStatus: number; body: unknown }> {
    try {
      const res = await this.request(path);
      const body: unknown = await res.json().catch(() => null);
      return { ok: res.ok, httpStatus: res.status, body };
    } catch (error) {
      return { ok: false, httpStatus: 0, body: error instanceof Error ? error.message : 'request failed' };
    }
  }

  async login(): Promise<void> {
    // Always JSON-encode: the admin key may contain characters that break a
    // hand-built JSON string (the server answers 500 for malformed JSON).
    const res = await this.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: this.adminKey }),
    });
    if (res.status === 401) throw new ControlApiError('login rejected: CONTROL_ADMIN_KEY is wrong or was rotated', 401);
    if (!res.ok) throw new ControlApiError(`login failed with HTTP ${res.status}`, res.status);
    const setCookie = res.headers.getSetCookie();
    const pair = setCookie.map(item => item.split(';')[0] ?? '').find(item => item.includes('='));
    const body = (await res.json()) as { csrfToken?: string };
    if (!pair || !body.csrfToken) throw new ControlApiError('login response missing session cookie or CSRF token', res.status);
    this.cookie = pair;
    this.csrf = body.csrfToken;
  }

  async logout(): Promise<void> {
    if (!this.cookie) return;
    await this.request('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': this.csrf } }).catch(() => undefined);
    this.cookie = '';
    this.csrf = '';
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.request(path);
    if (!res.ok) throw new ControlApiError(`GET ${path} failed with HTTP ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  status(): Promise<StatusSnapshot> {
    return this.getJson('/api/status');
  }

  compliance(): Promise<ComplianceOverview> {
    return this.getJson('/api/compliance-overview');
  }

  async campaigns(): Promise<Campaign[]> {
    const body = await this.getJson<Campaign[] | { items: Campaign[] }>('/api/campaigns');
    return Array.isArray(body) ? body : body.items;
  }

  async agentLog(limit = 10): Promise<AgentLogEntry[]> {
    return (await this.getJson<{ items: AgentLogEntry[] }>(`/api/agent/log?limit=${limit}`)).items;
  }

  async pendingRecommendations(limit = 200): Promise<AgentActionRecord[]> {
    return (await this.getJson<{ items: AgentActionRecord[] }>(`/api/agent/recommendations?limit=${limit}`)).items;
  }

  private async decide(id: string, verb: 'approve' | 'dismiss'): Promise<ApplyResult> {
    const res = await this.request(`/api/agent/recommendations/${encodeURIComponent(id)}/${verb}`, {
      method: 'POST',
      headers: { 'x-csrf-token': this.csrf, 'content-type': 'application/json' },
      body: '{}',
    });
    let detail = '';
    if (res.status !== 204) {
      const body = (await res.json().catch(() => ({}))) as { resultDetail?: string; error?: string };
      detail = body.resultDetail ?? body.error ?? '';
    }
    return { ok: res.ok, httpStatus: res.status, detail };
  }

  approve(id: string): Promise<ApplyResult> {
    return this.decide(id, 'approve');
  }

  dismiss(id: string): Promise<ApplyResult> {
    return this.decide(id, 'dismiss');
  }
}
