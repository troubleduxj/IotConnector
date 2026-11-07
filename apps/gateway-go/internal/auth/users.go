package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
	"golang.org/x/crypto/bcrypt"
)

// 四级角色（阶段 2 决定，与 Node 网关一致）：viewer < operator < engineer < admin。
const RoleEngineer Role = "engineer"

var roleRank = map[Role]int{RoleViewer: 1, RoleOperator: 2, RoleEngineer: 3, RoleAdmin: 4}

// ValidRole 判断角色名是否合法。
func ValidRole(role Role) bool { _, ok := roleRank[role]; return ok }

// RoleAtLeast 判断 actual 是否不低于 required。未知角色一律不满足。
func RoleAtLeast(actual, required Role) bool {
	a, okA := roleRank[actual]
	r, okR := roleRank[required]
	return okA && okR && a >= r
}

var (
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrLocked             = errors.New("account temporarily locked")
	ErrUserExists         = errors.New("username already exists")
	ErrUserNotFound       = errors.New("user not found")
	ErrLastAdmin          = errors.New("cannot remove or demote the last enabled admin")
)

// User 是对外暴露的用户信息，不含口令哈希。
type User struct {
	ID                 string `json:"id"`
	Username           string `json:"username"`
	Role               Role   `json:"role"`
	MustChangePassword bool   `json:"mustChangePassword"`
	Disabled           bool   `json:"disabled"`
	CreatedAt          int64  `json:"createdAt"`
	UpdatedAt          int64  `json:"updatedAt"`
}

// Principal 是一次认证通过后的身份。角色每次从库中读取，改角色即时生效。
type Principal struct {
	UserID             string
	Username           string
	Role               Role
	MustChangePassword bool
	SessionID          string // 会话令牌哈希的前 12 位，用于审计和踢下线；不是令牌本身
}

// SessionInfo 是会话列表中的一项。
type SessionInfo struct {
	ID         string `json:"id"`
	UserID     string `json:"userId"`
	Username   string `json:"username"`
	CreatedAt  int64  `json:"createdAt"`
	ExpiresAt  int64  `json:"expiresAt"`
	LastSeenAt int64  `json:"lastSeenAt"`
	ClientIP   string `json:"clientIp"`
	UserAgent  string `json:"userAgent"`
}

// UserStore 在 SQLite 上实现多用户、会话与锁定。
type UserStore struct {
	db          *db.DB
	sessionTTL  time.Duration
	maxFailures int
	lockFor     time.Duration
	now         func() time.Time
	dummyHash   []byte // 用户不存在时也做一次 bcrypt 比较，使耗时一致，防止枚举用户名
}

type UserStoreOptions struct {
	SessionTTL  time.Duration
	MaxFailures int
	LockFor     time.Duration
}

func NewUserStore(database *db.DB, options UserStoreOptions) *UserStore {
	if options.SessionTTL <= 0 {
		options.SessionTTL = 8 * time.Hour
	}
	if options.MaxFailures <= 0 {
		options.MaxFailures = 5
	}
	if options.LockFor <= 0 {
		options.LockFor = 15 * time.Minute
	}
	dummy, _ := bcrypt.GenerateFromPassword([]byte("dummy-password-for-timing"), bcrypt.DefaultCost)
	return &UserStore{db: database, sessionTTL: options.SessionTTL, maxFailures: options.MaxFailures,
		lockFor: options.LockFor, now: time.Now, dummyHash: dummy}
}

func newID(prefix string) string {
	buf := make([]byte, 9)
	_, _ = rand.Read(buf)
	return prefix + base64.RawURLEncoding.EncodeToString(buf)
}

// ValidateUsername 限制用户名为 1–64 个可见字符，不含空白和控制字符。
func ValidateUsername(name string) error {
	if name == "" || utf8.RuneCountInString(name) > 64 {
		return fmt.Errorf("username must be 1-64 characters")
	}
	for _, r := range name {
		if r <= ' ' || r == 0x7f {
			return fmt.Errorf("username must not contain spaces or control characters")
		}
	}
	return nil
}

func hashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return string(hash), nil
}

// CountUsers 返回用户总数，用于判断是否需要初始化首个管理员。
func (s *UserStore) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// CreateUser 创建用户。password 为空且 passwordHash 非空时直接写入哈希（用于迁移旧数据）。
func (s *UserStore) CreateUser(ctx context.Context, username, password string, role Role, mustChange bool) (User, error) {
	if err := ValidatePassword(password); err != nil {
		return User{}, err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return User{}, err
	}
	return s.insertUser(ctx, username, hash, role, mustChange)
}

// ImportUser 用已有的 bcrypt 哈希创建用户（迁移 auth.json），不校验口令策略。
func (s *UserStore) ImportUser(ctx context.Context, username, bcryptHash string, role Role, mustChange bool) (User, error) {
	if _, err := bcrypt.Cost([]byte(bcryptHash)); err != nil {
		return User{}, fmt.Errorf("import %s: not a bcrypt hash", username)
	}
	return s.insertUser(ctx, username, bcryptHash, role, mustChange)
}

func (s *UserStore) insertUser(ctx context.Context, username, hash string, role Role, mustChange bool) (User, error) {
	username = strings.TrimSpace(username)
	if err := ValidateUsername(username); err != nil {
		return User{}, err
	}
	if !ValidRole(role) {
		return User{}, fmt.Errorf("invalid role %q", role)
	}
	now := s.now().UnixMilli()
	user := User{ID: newID("u_"), Username: username, Role: role, MustChangePassword: mustChange, CreatedAt: now, UpdatedAt: now}
	_, err := s.db.ExecContext(ctx, `INSERT INTO users(id, username, password_hash, role, must_change_password, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, user.ID, user.Username, hash, string(role), boolInt(mustChange), now, now)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return User{}, ErrUserExists
		}
		return User{}, fmt.Errorf("create user: %w", err)
	}
	return user, nil
}

const userColumns = `id, username, role, must_change_password, disabled, created_at, updated_at`

func scanUser(row interface{ Scan(...any) error }) (User, error) {
	var u User
	var role string
	var must, disabled int
	if err := row.Scan(&u.ID, &u.Username, &role, &must, &disabled, &u.CreatedAt, &u.UpdatedAt); err != nil {
		return User{}, err
	}
	u.Role, u.MustChangePassword, u.Disabled = Role(role), must == 1, disabled == 1
	return u, nil
}

func (s *UserStore) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+userColumns+` FROM users ORDER BY created_at, username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

func (s *UserStore) GetUser(ctx context.Context, id string) (User, error) {
	u, err := scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrUserNotFound
	}
	return u, err
}

func (s *UserStore) GetUserByName(ctx context.Context, username string) (User, error) {
	u, err := scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE username = ?`, username))
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrUserNotFound
	}
	return u, err
}

// UserPatch 是管理员对用户的修改；nil 字段不变。
type UserPatch struct {
	Role     *Role
	Password *string
	Disabled *bool
}

// UpdateUser 修改用户。改角色、改口令、禁用都会递增 token_version，使该用户现有会话失效。
// 管理员重置的口令要求用户下次登录后修改。
func (s *UserStore) UpdateUser(ctx context.Context, id string, patch UserPatch) (User, error) {
	if patch.Role != nil && !ValidRole(*patch.Role) {
		return User{}, fmt.Errorf("invalid role %q", *patch.Role)
	}
	var newHash string
	if patch.Password != nil {
		if err := ValidatePassword(*patch.Password); err != nil {
			return User{}, err
		}
		hash, err := hashPassword(*patch.Password)
		if err != nil {
			return User{}, err
		}
		newHash = hash
	}
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		current, err := scanUser(tx.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE id = ?`, id))
		if errors.Is(err, sql.ErrNoRows) {
			return ErrUserNotFound
		}
		if err != nil {
			return err
		}
		losesAdmin := current.Role == RoleAdmin && !current.Disabled &&
			((patch.Role != nil && *patch.Role != RoleAdmin) || (patch.Disabled != nil && *patch.Disabled))
		if losesAdmin {
			if err := ensureAnotherAdmin(ctx, tx, id); err != nil {
				return err
			}
		}
		now := s.now().UnixMilli()
		if patch.Role != nil {
			if _, err := tx.ExecContext(ctx, `UPDATE users SET role = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?`, string(*patch.Role), now, id); err != nil {
				return err
			}
		}
		if patch.Disabled != nil {
			if _, err := tx.ExecContext(ctx, `UPDATE users SET disabled = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?`, boolInt(*patch.Disabled), now, id); err != nil {
				return err
			}
		}
		if patch.Password != nil {
			if _, err := tx.ExecContext(ctx, `UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = 0,
                token_version = token_version + 1, updated_at = ? WHERE id = ?`, newHash, now, id); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return User{}, err
	}
	return s.GetUser(ctx, id)
}

func ensureAnotherAdmin(ctx context.Context, tx *sql.Tx, excludeID string) error {
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0 AND id <> ?`, excludeID).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return ErrLastAdmin
	}
	return nil
}

func (s *UserStore) DeleteUser(ctx context.Context, id string) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		current, err := scanUser(tx.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE id = ?`, id))
		if errors.Is(err, sql.ErrNoRows) {
			return ErrUserNotFound
		}
		if err != nil {
			return err
		}
		if current.Role == RoleAdmin && !current.Disabled {
			if err := ensureAnotherAdmin(ctx, tx, id); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, id)
		return err
	})
}

// Unlock 清除登录失败计数与锁定。
func (s *UserStore) Unlock(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE users SET failed_attempts = 0, locked_until = 0, updated_at = ? WHERE id = ?`, s.now().UnixMilli(), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrUserNotFound
	}
	return nil
}

// Login 校验口令并签发会话。用户不存在、口令错误、已禁用一律返回 ErrInvalidCredentials，
// 且都执行一次 bcrypt 比较，耗时一致。连续失败 maxFailures 次锁定 lockFor。
func (s *UserStore) Login(ctx context.Context, username, password, clientIP, userAgent string) (string, Principal, error) {
	var id, hash, role string
	var must, disabled, failed, version int
	var lockedUntil int64
	err := s.db.QueryRowContext(ctx, `SELECT id, password_hash, role, must_change_password, disabled, failed_attempts, locked_until, token_version
        FROM users WHERE username = ?`, strings.TrimSpace(username)).Scan(&id, &hash, &role, &must, &disabled, &failed, &lockedUntil, &version)
	if errors.Is(err, sql.ErrNoRows) {
		_ = bcrypt.CompareHashAndPassword(s.dummyHash, []byte(password))
		return "", Principal{}, ErrInvalidCredentials
	}
	if err != nil {
		return "", Principal{}, err
	}
	now := s.now()
	if lockedUntil > now.UnixMilli() {
		_ = bcrypt.CompareHashAndPassword(s.dummyHash, []byte(password))
		return "", Principal{}, ErrLocked
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil || disabled == 1 {
		failed++
		lock := int64(0)
		if failed >= s.maxFailures {
			lock, failed = now.Add(s.lockFor).UnixMilli(), 0
		}
		_, _ = s.db.ExecContext(ctx, `UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?`, failed, lock, id)
		return "", Principal{}, ErrInvalidCredentials
	}
	_, _ = s.db.ExecContext(ctx, `UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?`, id)

	token, key := newSessionToken()
	created := now.UnixMilli()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO sessions(token_hash, user_id, token_version, created_at, expires_at, last_seen_at, client_ip, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, key, id, version, created, now.Add(s.sessionTTL).UnixMilli(), created, truncate(clientIP, 64), truncate(userAgent, 200)); err != nil {
		return "", Principal{}, fmt.Errorf("create session: %w", err)
	}
	_, _ = s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at < ?`, created)
	return token, Principal{UserID: id, Username: strings.TrimSpace(username), Role: Role(role), MustChangePassword: must == 1, SessionID: key[:12]}, nil
}

func newSessionToken() (token, key string) {
	buf := make([]byte, 32)
	_, _ = rand.Read(buf)
	token = base64.RawURLEncoding.EncodeToString(buf)
	return token, tokenHash(token)
}

// Authenticate 校验会话令牌。角色、禁用状态、token_version 每次从库中读取：
// 改角色、改口令、禁用、删除用户后，旧令牌立即失效（修正 Node 网关的 D5 问题）。
func (s *UserStore) Authenticate(ctx context.Context, token string) (Principal, bool) {
	if token == "" {
		return Principal{}, false
	}
	key := tokenHash(token)
	var p Principal
	var role string
	var must, disabled, sessionVersion, userVersion int
	var expires int64
	err := s.db.QueryRowContext(ctx, `SELECT u.id, u.username, u.role, u.must_change_password, u.disabled, u.token_version, s.token_version, s.expires_at
        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, key).
		Scan(&p.UserID, &p.Username, &role, &must, &disabled, &userVersion, &sessionVersion, &expires)
	if err != nil {
		return Principal{}, false
	}
	now := s.now().UnixMilli()
	if expires < now || disabled == 1 || sessionVersion != userVersion {
		_, _ = s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, key)
		return Principal{}, false
	}
	// 每分钟最多更新一次活跃时间，避免每个请求都写库
	_, _ = s.db.ExecContext(ctx, `UPDATE sessions SET last_seen_at = ? WHERE token_hash = ? AND last_seen_at < ?`, now, key, now-60_000)
	p.Role, p.MustChangePassword, p.SessionID = Role(role), must == 1, key[:12]
	return p, true
}

// Logout 删除会话。
func (s *UserStore) Logout(ctx context.Context, token string) {
	_, _ = s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash(token))
}

// ChangeOwnPassword 校验当前口令后修改，清除强制改密标记，并使该用户的其他会话失效。
// 当前会话保留，并同步到新的 token_version。
func (s *UserStore) ChangeOwnPassword(ctx context.Context, token, current, next string) error {
	principal, ok := s.Authenticate(ctx, token)
	if !ok {
		return ErrInvalidCredentials
	}
	var hash string
	if err := s.db.QueryRowContext(ctx, `SELECT password_hash FROM users WHERE id = ?`, principal.UserID).Scan(&hash); err != nil {
		return err
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(current)) != nil {
		return fmt.Errorf("current password is incorrect")
	}
	if subtle.ConstantTimeCompare([]byte(current), []byte(next)) == 1 {
		return fmt.Errorf("new password must differ from the current one")
	}
	if err := ValidatePassword(next); err != nil {
		return err
	}
	if strings.Contains(strings.ToLower(next), strings.ToLower(principal.Username)) {
		return fmt.Errorf("password must not contain the username")
	}
	newHash, err := hashPassword(next)
	if err != nil {
		return err
	}
	key := tokenHash(token)
	return s.inTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1, updated_at = ? WHERE id = ?`,
			newHash, s.now().UnixMilli(), principal.UserID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?`, principal.UserID, key); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE sessions SET token_version = (SELECT token_version FROM users WHERE id = ?) WHERE token_hash = ?`, principal.UserID, key)
		return err
	})
}

func (s *UserStore) ListSessions(ctx context.Context) ([]SessionInfo, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT s.token_hash, s.user_id, u.username, s.created_at, s.expires_at, s.last_seen_at, s.client_ip, s.user_agent
        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.expires_at >= ? AND s.token_version = u.token_version ORDER BY s.last_seen_at DESC`, s.now().UnixMilli())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SessionInfo{}
	for rows.Next() {
		var info SessionInfo
		var key string
		if err := rows.Scan(&key, &info.UserID, &info.Username, &info.CreatedAt, &info.ExpiresAt, &info.LastSeenAt, &info.ClientIP, &info.UserAgent); err != nil {
			return nil, err
		}
		info.ID = key[:12]
		out = append(out, info)
	}
	return out, rows.Err()
}

// RevokeSession 按会话 ID（令牌哈希前 12 位）踢下线。
func (s *UserStore) RevokeSession(ctx context.Context, sessionID string) (bool, error) {
	if len(sessionID) != 12 {
		return false, nil
	}
	if _, err := hex.DecodeString(sessionID); err != nil {
		return false, nil
	}
	res, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE substr(token_hash, 1, 12) = ?`, sessionID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *UserStore) inTx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// SetPassword 直接设置口令且不要求下次修改（开发账号用）。同样递增 token_version。
func (s *UserStore) SetPassword(ctx context.Context, id, password string) error {
	if err := ValidatePassword(password); err != nil {
		return err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE users SET password_hash = ?, must_change_password = 0, failed_attempts = 0, locked_until = 0,
        token_version = token_version + 1, updated_at = ? WHERE id = ?`, hash, s.now().UnixMilli(), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrUserNotFound
	}
	return nil
}
