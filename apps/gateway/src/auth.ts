import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * 用户认证（PRD FR-M10-02）：本地账号 + scrypt 口令散列 + 内存会话令牌 + RBAC。
 * 角色权限矩阵：
 *   operator：只读 + 受控写（位号写入）
 *   engineer：operator + 通道/位号/告警/存储规则配置
 *   admin：engineer + 用户管理 + 通知配置 + 审计查询
 */

export type Role = 'admin' | 'engineer' | 'operator';

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: Role;
  createdAt: number;
  /** 首次登录须改密 */
  mustChangePassword?: boolean;
}

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
}

const ROLE_RANK: Record<Role, number> = { operator: 1, engineer: 2, admin: 3 };
const SESSION_TTL_MS = 12 * 3600_000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

interface Session {
  user: SessionUser;
  expiresAt: number;
}

interface LoginAttempt {
  count: number;
  lockedUntil: number;
}

export class AuthStore {
  private sessions = new Map<string, Session>();
  private attempts = new Map<string, LoginAttempt>();

  /** 会话持久化钩子（登录/登出/过期时调用） */
  onSessionsChanged?: (entries: Array<{ token: string; user: SessionUser; expiresAt: number }>) => void;
  /** 登录失败锁定回调（审计用） */
  onLockout?: (username: string, lockedUntil: number) => void;

  static MAX_ATTEMPTS = 5;
  static LOCKOUT_MS = 10 * 60_000;

  constructor(private users: User[]) {}

  getUsers(): User[] {
    return this.users;
  }

  findUser(id: string): User | undefined {
    return this.users.find((u) => u.id === id);
  }

  setUsers(users: User[]): void {
    this.users = users;
  }

  login(username: string, password: string):
    | { ok: true; token: string; user: SessionUser; mustChangePassword?: boolean }
    | { ok: false; error: string; locked?: boolean }
    | null {
    const attempt = this.attempts.get(username);
    if (attempt && attempt.lockedUntil > Date.now()) {
      const mins = Math.ceil((attempt.lockedUntil - Date.now()) / 60000);
      return { ok: false, error: `失败次数过多，账号锁定至 ${new Date(attempt.lockedUntil).toLocaleTimeString()}（约 ${mins} 分钟）`, locked: true };
    }
    const user = this.users.find((u) => u.username === username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      const rec = attempt ?? { count: 0, lockedUntil: 0 };
      rec.count += 1;
      if (rec.count >= AuthStore.MAX_ATTEMPTS) {
        rec.lockedUntil = Date.now() + AuthStore.LOCKOUT_MS;
        rec.count = 0;
        this.onLockout?.(username, rec.lockedUntil);
      }
      this.attempts.set(username, rec);
      return null; // 用户名或口令错误（与不存在一致，防枚举）
    }
    this.attempts.delete(username);
    const token = randomBytes(24).toString('hex');
    const sessionUser: SessionUser = { id: user.id, username: user.username, role: user.role };
    this.sessions.set(token, { user: sessionUser, expiresAt: Date.now() + SESSION_TTL_MS });
    this.persistSessions();
    return {
      ok: true,
      token,
      user: sessionUser,
      mustChangePassword: user.mustChangePassword,
    };
  }

  listSessions(): Array<{ token: string; username: string; role: Role; expiresAt: number }> {
    return [...this.sessions.entries()].map(([token, s]) => ({
      token,
      username: s.user.username,
      role: s.user.role,
      expiresAt: s.expiresAt,
    }));
  }

  kickSession(token: string): boolean {
    return this.sessions.delete(token);
  }

  verifyUserPassword(user: User, password: string): boolean {
    return verifyPassword(password, user.passwordHash);
  }

  changePassword(userId: string, newPassword: string): boolean {
    const user = this.users.find((u) => u.id === userId);
    if (!user) return false;
    user.passwordHash = hashPassword(newPassword);
    user.mustChangePassword = false;
    return true;
  }

  /** 管理员重置口令：散列更新并强制该用户下次登录改密 */
  resetPassword(userId: string, newPassword: string): boolean {
    const user = this.users.find((u) => u.id === userId);
    if (!user) return false;
    user.passwordHash = hashPassword(newPassword);
    user.mustChangePassword = true;
    return true;
  }

  /** 启动时恢复持久化的会话 */
  loadSessions(entries: Array<{ token: string; user: SessionUser; expiresAt: number }>): void {
    for (const e of entries) {
      if (e.expiresAt > Date.now()) this.sessions.set(e.token, { user: e.user, expiresAt: e.expiresAt });
    }
  }

  private persistSessions(): void {
    this.onSessionsChanged?.(
      [...this.sessions.entries()].map(([token, s]) => ({ token, user: s.user, expiresAt: s.expiresAt })),
    );
  }

  verify(token: string | undefined): SessionUser | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    return session.user;
  }

  /** 校验令牌与最低角色；返回 null 表示通过，否则返回 HTTP 状态码 */
  authorize(token: string | undefined, minRole: Role): { user: SessionUser } | { code: 401 | 403 } {
    const user = this.verify(token);
    if (!user) return { code: 401 };
    if (!roleAtLeast(user.role, minRole)) return { code: 403 };
    return { user };
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }
}
