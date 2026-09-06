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

export class AuthStore {
  private sessions = new Map<string, Session>();

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

  login(username: string, password: string): { token: string; user: SessionUser } | null {
    const user = this.users.find((u) => u.username === username);
    if (!user || !verifyPassword(password, user.passwordHash)) return null;
    const token = randomBytes(24).toString('hex');
    const sessionUser: SessionUser = { id: user.id, username: user.username, role: user.role };
    this.sessions.set(token, { user: sessionUser, expiresAt: Date.now() + SESSION_TTL_MS });
    return { token, user: sessionUser };
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
