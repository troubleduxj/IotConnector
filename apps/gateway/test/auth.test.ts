import { describe, expect, it } from 'vitest';
import { AuthStore, hashPassword, verifyPassword } from '../src/auth';

function makeStore(): AuthStore {
  return new AuthStore([
    { id: 'u1', username: 'admin', passwordHash: hashPassword('secret1'), role: 'admin', createdAt: 1 },
    { id: 'u2', username: 'op', passwordHash: hashPassword('op12345'), role: 'operator', createdAt: 1 },
  ]);
}

describe('AuthStore', () => {
  it('口令散列可验证、错误口令拒绝', () => {
    const hash = hashPassword('abc123');
    expect(verifyPassword('abc123', hash)).toBe(true);
    expect(verifyPassword('wrong', hash)).toBe(false);
  });

  it('正确口令登录返回令牌与会话', () => {
    const store = makeStore();
    const result = store.login('admin', 'secret1');
    expect(result?.ok).toBe(true);
    expect(store.verify(result?.token)).toMatchObject({ username: 'admin', role: 'admin' });
  });

  it('错误口令返回 null', () => {
    expect(makeStore().login('admin', 'bad')?.ok ?? null).toBe(null);
  });

  it('连续失败 5 次后锁定 10 分钟', () => {
    const store = makeStore();
    let last: ReturnType<AuthStore['login']>;
    for (let i = 0; i < 5; i += 1) last = store.login('op', 'wrong');
    // 锁定中：即使口令正确也拒绝
    const after = store.login('op', 'op12345');
    expect(after?.ok).toBe(false);
    expect(after && 'locked' in after ? after.locked : false).toBe(true);
    void last;
  });

  it('RBAC：operator 不满足 admin 要求', () => {
    const store = makeStore();
    const login = store.login('op', 'op12345');
    if (!login?.ok) throw new Error('login failed');
    const result = store.authorize(login.token, 'admin');
    expect('code' in result ? result.code : 0).toBe(403);
    const okResult = store.authorize(login.token, 'operator');
    expect('user' in okResult).toBe(true);
  });

  it('登出后令牌失效', () => {
    const store = makeStore();
    const login = store.login('admin', 'secret1');
    if (!login?.ok) throw new Error('login failed');
    store.logout(login.token);
    expect(store.verify(login.token)).toBeNull();
  });

  it('管理员重置口令：置 mustChangePassword，旧口令失效、新口令可登录', () => {
    const store = makeStore();
    expect(store.resetPassword('u2', 'newpass9')).toBe(true);
    expect(store.login('op', 'op12345')?.ok ?? null).toBe(null);
    const login = store.login('op', 'newpass9');
    expect(login?.ok).toBe(true);
    expect(login?.ok === true ? login.mustChangePassword : false).toBe(true);
  });

  it('用户改密后 mustChangePassword 清除', () => {
    const store = makeStore();
    store.resetPassword('u2', 'newpass9');
    expect(store.changePassword('u2', 'mypersonal7')).toBe(true);
    const login = store.login('op', 'mypersonal7');
    expect(login?.ok === true ? login.mustChangePassword : true).toBe(false);
  });

  it('未标记用户登录不返回 mustChangePassword', () => {
    const login = makeStore().login('admin', 'secret1');
    expect(login?.ok === true ? Boolean(login.mustChangePassword) : true).toBe(false);
  });
});
